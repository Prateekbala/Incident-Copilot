import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { incidentSnapshot, getIncident, getInvestigation, listIncidents, createIncident, type IncidentRow } from "./domain/repo";
import type { Env } from "./env";
import { ApiError, errorMessage } from "./lib/errors";
import { ulid } from "./lib/ids";
import { SCENARIOS, SERVICE_NAMES, matchService } from "./telemetry/catalog";
import { activeScenario, seedScenario } from "./telemetry/seed";

export { IncidentAgent } from "./agent/incident-agent";
export { InvestigationWorkflow } from "./workflow/investigation";

type AppEnv = { Bindings: Env; Variables: { userId: string } };
type Ctx = Context<AppEnv>;

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const app = new Hono<AppEnv>().basePath("/api");


app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
  if (err instanceof z.ZodError) {
    const e = new ApiError("validation_failed", "Invalid request", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return c.json(e.toJSON(), 400);
  }
  console.error(`[api] ${c.req.method} ${c.req.path}: ${errorMessage(err)}`);
  return c.json(new ApiError("internal", "Internal error").toJSON(), 500);
});

app.notFound((c) => c.json(new ApiError("not_found", "Route not found").toJSON(), 404));


function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const [token, user] = pair.split(":").map((s) => s.trim());
    if (token && user) map.set(token, user);
  }
  return map;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const isWs = c.req.header("Upgrade") === "websocket";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : isWs ? (c.req.query("token") ?? "") : "";
  if (!token) throw new ApiError("unauthorized", "Missing bearer token");
  for (const [known, user] of parseTokens(c.env.API_TOKENS)) {
    if (timingSafeEqual(token, known)) {
      c.set("userId", user);
      return next();
    }
  }
  throw new ApiError("unauthorized", "Invalid token");
};

const rateLimit =
  (bucket: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (c.env.RATE_LIMITER) {
      const { success } = await c.env.RATE_LIMITER.limit({ key: `${bucket}:${c.get("userId")}` });
      if (!success) {
        c.header("Retry-After", "60");
        throw new ApiError("rate_limited", "Too many requests");
      }
    }
    return next();
  };

async function ownedIncident(c: Ctx): Promise<IncidentRow> {
  const id = c.req.param("id") ?? "";
  if (!/^[0-9A-Z]{26}$/.test(id)) throw new ApiError("not_found", "Incident not found");
  const incident = await getIncident(c.env.DB, id);
  if (!incident) throw new ApiError("not_found", "Incident not found");
  if (incident.owner_id !== c.get("userId")) throw new ApiError("forbidden", "Not your incident");
  return incident;
}

const agent = (env: Env, incidentId: string) => env.INCIDENT_AGENT.get(env.INCIDENT_AGENT.idFromName(incidentId));

async function body<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    json = {};
  }
  return schema.parse(json);
}


app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.use("/demo/*", requireAuth);
app.use("/incidents", requireAuth);
app.use("/incidents/*", requireAuth);

app.get("/demo/scenario", async (c) => c.json({ scenario: await activeScenario(c.env.DB), available: SCENARIOS, services: SERVICE_NAMES }));

app.post("/demo/seed", rateLimit("seed"), async (c) => {
  const { scenario } = await body(c, z.object({ scenario: z.enum(SCENARIOS) }));
  const result = await seedScenario(c.env.DB, scenario);
  return c.json(result);
});

app.post("/incidents", rateLimit("incidents"), async (c) => {
  const input = await body(c, z.object({ title: z.string().trim().max(120).optional(), description: z.string().trim().min(3).max(4000) }));
  const scenario = await activeScenario(c.env.DB);
  if (!scenario) throw new ApiError("conflict", "Seed a demo scenario first (POST /api/demo/seed)");
  const id = ulid();
  const title = input.title || input.description.split("\n")[0].slice(0, 80);
  await createIncident(c.env.DB, { id, title, description: input.description, ownerId: c.get("userId"), scenario, service: matchService(input.description) ?? null });
  return c.json({ id }, 201);
});

app.get("/incidents", async (c) => c.json({ incidents: await listIncidents(c.env.DB, c.get("userId")) }));

app.get("/incidents/:id", async (c) => {
  const incident = await ownedIncident(c);
  const [snapshot, messages] = await Promise.all([incidentSnapshot(c.env.DB, incident), agent(c.env, incident.id).getMessages(100)]);
  return c.json({ ...snapshot, messages });
});

app.get("/incidents/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") throw new ApiError("validation_failed", "Expected WebSocket upgrade");
  const origin = c.req.header("Origin");
  if (origin && new URL(origin).host !== new URL(c.req.url).host) throw new ApiError("forbidden", "Cross-origin WebSocket rejected");
  const incident = await ownedIncident(c);

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Incident-Id", incident.id);
  headers.set("X-User-Id", c.get("userId"));
  return agent(c.env, incident.id).fetch(new Request(c.req.raw.url, { headers }));
});

app.get("/incidents/:id/messages", async (c) => {
  const incident = await ownedIncident(c);
  return c.json({ messages: await agent(c.env, incident.id).getMessages(100) });
});

app.post("/incidents/:id/messages", rateLimit("messages"), async (c) => {
  const incident = await ownedIncident(c);
  const input = await body(c, z.object({ text: z.string().trim().min(1).max(4000), clientMsgId: z.string().min(1).max(100).optional() }));
  const clientMsgId = input.clientMsgId ?? `http-${ulid()}`;
  const res = await agent(c.env, incident.id).postUserMessage(incident.id, c.get("userId"), clientMsgId, input.text);
  return c.json({ ...res, clientMsgId }, 202);
});

app.post("/incidents/:id/voice", rateLimit("voice"), async (c) => {
  await ownedIncident(c);
  const form = await c.req.formData();
  const audio = form.get("audio");
  if (!audio || typeof audio === "string") throw new ApiError("validation_failed", "Expected multipart field 'audio'");
  if (audio.size > MAX_AUDIO_BYTES) throw new ApiError("validation_failed", "Audio too large (max 5 MB)");

  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    const run = c.env.AI.run as unknown as (m: string, i: unknown, o?: unknown) => Promise<{ text?: string }>;
    const opts = c.env.AI_GATEWAY_ID ? { gateway: { id: c.env.AI_GATEWAY_ID } } : undefined;
    const res = await run.call(c.env.AI, "@cf/openai/whisper-large-v3-turbo", { audio: btoa(binary) }, opts);
    return c.json({ transcript: (res.text ?? "").trim() });
  } catch (err) {
    throw new ApiError("ai_unavailable", `Transcription failed: ${errorMessage(err)}`);
  }
});

app.post("/incidents/:id/investigations", rateLimit("investigations"), async (c) => {
  const incident = await ownedIncident(c);
  const input = await body(
    c,
    z.object({
      service: z.preprocess((v) => (typeof v === "string" ? (matchService(v) ?? v) : v), z.enum(SERVICE_NAMES)).optional(),
      symptom: z.string().trim().min(3).max(500).optional(),
      start_time: z.string().max(64).optional(),
    }),
  );
  const service = input.service ?? (incident.service as (typeof SERVICE_NAMES)[number] | null) ?? matchService(incident.description);
  if (!service) throw new ApiError("validation_failed", `Could not infer the service; pass one of ${SERVICE_NAMES.join(", ")}`);
  const result = await agent(c.env, incident.id).startInvestigation(incident.id, c.get("userId"), {
    service,
    symptom: input.symptom ?? incident.description.slice(0, 300),
    startTime: input.start_time,
  });
  return c.json(result, result.status === "started" ? 201 : 200);
});

app.get("/incidents/:id/investigations/:iid", async (c) => {
  const incident = await ownedIncident(c);
  const inv = await getInvestigation(c.env.DB, c.req.param("iid"));
  if (!inv || inv.incident_id !== incident.id) throw new ApiError("not_found", "Investigation not found");
  let workflow: unknown = null;
  try {
    workflow = await (await c.env.INVESTIGATION.get(inv.id)).status();
  } catch (err) {
    workflow = { error: errorMessage(err) };
  }
  return c.json({ investigation: inv, workflow });
});

app.post("/incidents/:id/actions/:aid/decision", async (c) => {
  const incident = await ownedIncident(c);
  const { approved } = await body(c, z.object({ approved: z.boolean() }));
  const res = await agent(c.env, incident.id).decide(incident.id, c.get("userId"), c.req.param("aid"), approved);
  return c.json(res);
});

app.get("/incidents/:id/report", async (c) => {
  const incident = await ownedIncident(c);
  const inv = await c.env.DB.prepare("SELECT report_md FROM investigations WHERE incident_id = ? AND report_md IS NOT NULL ORDER BY started_at DESC LIMIT 1")
    .bind(incident.id)
    .first<{ report_md: string }>();
  if (!inv) throw new ApiError("not_found", "No report yet");
  return c.body(inv.report_md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
