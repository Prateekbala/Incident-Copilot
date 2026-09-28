import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { chat, type ChatMessage } from "../ai/llm";
import { AGENT_SYSTEM_PROMPT, SUMMARY_PROMPT, wrapUntrusted } from "../ai/prompts";
import { decideAction, startInvestigation } from "../domain/investigations";
import { audit, getAction, getIncident, latestInvestigation, listActions, listHypotheses, type ActionRow, type IncidentRow } from "../domain/repo";
import type { Env } from "../env";
import { withTimeout } from "../lib/async";
import { AiUnavailableError, ApiError, errorMessage } from "../lib/errors";
import { matchService } from "../telemetry/catalog";
import { TOOL_SCHEMAS, getTool, toolContext } from "../tools/registry";
import type { WorkflowNotification } from "../workflow/types";

const MAX_ITERATIONS = 4;
const MAX_TOOL_CALLS = 8;
const RECENT_MESSAGES = 10;
const SUMMARIZE_THRESHOLD = 20;
const SUMMARIZE_BATCH = 10;
const MAX_MESSAGE_CHARS = 4000;

const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), clientMsgId: z.string().min(1).max(100), text: z.string().min(1).max(MAX_MESSAGE_CHARS) }),
  z.object({ type: z.literal("approval_decision"), clientMsgId: z.string().min(1).max(100), actionId: z.string().min(1).max(200), approved: z.boolean() }),
  z.object({ type: z.literal("ping") }),
]);

interface Attachment {
  userId: string;
}

export type StoredMessage = {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
  created_at: number;
};

export interface IncidentState {
  incidentId: string;
  title: string;
  status: string;
  severity: string | null;
  service: string | null;
  investigation: { id: string; status: string; phase: string | null } | null;
  top_hypotheses: Array<{ id: string; title: string; confidence: number }>;
  pending_actions: Array<{ id: string; type: string; target: string }>;
}

export class IncidentAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        client_msg_id TEXT UNIQUE,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        tool_name     TEXT,
        tool_call_id  TEXT,
        summarized    INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.kvSet("schema_version", "1");
  }


  private kvGet(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private kvSet(key: string, value: string) {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private bindIncident(incidentId: string) {
    if (!this.kvGet("incident_id")) this.kvSet("incident_id", incidentId);
  }

  private get incidentId(): string {
    const id = this.kvGet("incident_id");
    if (!id) throw new Error("IncidentAgent not bound to an incident");
    return id;
  }

  private saveMessage(role: StoredMessage["role"], content: string, opts: { clientMsgId?: string; toolName?: string; toolCallId?: string } = {}): StoredMessage | null {
    const createdAt = Date.now();
    const cursor = this.sql.exec<{ id: number }>(
      "INSERT INTO messages (client_msg_id, role, content, tool_name, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_msg_id) DO NOTHING RETURNING id",
      opts.clientMsgId ?? null,
      role,
      content,
      opts.toolName ?? null,
      opts.toolCallId ?? null,
      createdAt,
    );
    const row = cursor.toArray()[0];
    return row ? { id: row.id, role, content, tool_name: opts.toolName ?? null, created_at: createdAt } : null;
  }

  private recentConversation(limit = RECENT_MESSAGES): StoredMessage[] {
    return this.sql
      .exec<StoredMessage>("SELECT id, role, content, tool_name, created_at FROM messages WHERE role IN ('user','assistant') ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .reverse();
  }

  async getMessages(limit = 100): Promise<StoredMessage[]> {
    return this.sql
      .exec<StoredMessage>("SELECT id, role, content, tool_name, created_at FROM messages ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .reverse();
  }


  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
    const incidentId = request.headers.get("X-Incident-Id");
    const userId = request.headers.get("X-User-Id");
    if (!incidentId || !userId) return new Response("Missing incident context", { status: 400 });
    this.bindIncident(incidentId);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId } satisfies Attachment);

    const state = this.kvGet("incident_state");
    server.send(JSON.stringify({ type: "history", messages: await this.getMessages(), state: state ? JSON.parse(state) : null }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const { userId } = (ws.deserializeAttachment() ?? {}) as Attachment;
    let parsed: z.infer<typeof ClientMessage>;
    try {
      parsed = ClientMessage.parse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
    } catch (err) {
      this.sendTo(ws, { type: "error", code: "validation_failed", message: `Invalid message: ${errorMessage(err).slice(0, 200)}`, retryable: false });
      return;
    }

    switch (parsed.type) {
      case "ping":
        this.sendTo(ws, { type: "pong" });
        return;
      case "user_message":
        await this.enqueue(() => this.handleUserMessage(userId, parsed.clientMsgId, parsed.text, ws));
        return;
      case "approval_decision":
        try {
          await this.decide(this.incidentId, userId, parsed.actionId, parsed.approved);
        } catch (err) {
          this.sendTo(ws, { type: "error", code: err instanceof ApiError ? err.code : "internal", message: errorMessage(err), retryable: true });
        }
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
    }
  }

  private sendTo(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }

  private broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
      }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }


  async postUserMessage(incidentId: string, userId: string, clientMsgId: string, text: string): Promise<{ accepted: boolean }> {
    this.bindIncident(incidentId);
    const seen = this.sql.exec("SELECT 1 FROM messages WHERE client_msg_id = ?", clientMsgId).toArray().length > 0;
    if (seen) return { accepted: false };
    this.ctx.waitUntil(this.enqueue(() => this.handleUserMessage(userId, clientMsgId, text)));
    return { accepted: true };
  }

  async startInvestigation(incidentId: string, userId: string, args: { service: string; symptom: string; startTime?: string }) {
    this.bindIncident(incidentId);
    const result = await startInvestigation(this.env, { incidentId, ...args, actor: userId });
    this.broadcast({ type: "investigation_progress", phase: "started", detail: result });
    await this.refreshState();
    return result;
  }

  async decide(incidentId: string, userId: string, actionId: string, approved: boolean) {
    this.bindIncident(incidentId);
    const { action, changed } = await decideAction(this.env, { incidentId, actionId, approved, userId });
    if (changed) {
      const verb = approved ? "approved" : "rejected";
      const note = this.saveMessage("assistant", `✅ ${userId} ${verb} **${action.type}** of \`${action.target}\`.${action.status === "executed" ? " The simulated action has been executed." : ""}`, {
        clientMsgId: `decision:${action.id}`,
      });
      if (note) this.broadcast({ type: "assistant_message", message: note });
    }
    await this.refreshState();
    return { action, changed };
  }

  async onWorkflowEvent(incidentId: string, evt: WorkflowNotification) {
    this.bindIncident(incidentId);
    this.broadcast({ type: "investigation_progress", investigationId: evt.investigationId, phase: evt.phase, detail: evt.detail ?? {} });

    if (evt.phase === "approval_required" && typeof evt.detail?.actionId === "string") {
      const action = await getAction(this.env.DB, incidentId, evt.detail.actionId);
      if (action?.status === "pending_approval") this.broadcast({ type: "approval_request", action });
    }

    const note = await this.workflowNote(incidentId, evt);
    if (note) {
      const saved = this.saveMessage("assistant", note, { clientMsgId: `wf:${evt.investigationId}:${evt.phase}` });
      if (saved) this.broadcast({ type: "assistant_message", message: saved });
    }
    await this.refreshState();
  }

  private async workflowNote(incidentId: string, evt: WorkflowNotification): Promise<string | null> {
    switch (evt.phase) {
      case "hypotheses_ranked": {
        const hyps = await listHypotheses(this.env.DB, evt.investigationId);
        if (!hyps.length) return "🔎 Investigation finished correlating evidence but found no supported hypothesis.";
        return (
          "🔎 **Ranked hypotheses**\n" +
          hyps.map((h) => `${h.rank}. **${h.title}** (confidence ${h.confidence}) — evidence ${h.evidence_ids.map((id) => `\`${id}\``).join(", ")}`).join("\n")
        );
      }
      case "approval_required": {
        const action = typeof evt.detail?.actionId === "string" ? await getAction(this.env.DB, incidentId, evt.detail.actionId) : null;
        return action ? `🛑 **Approval required:** ${action.type} \`${action.target}\`. ${action.rationale}` : null;
      }
      case "verified":
        return evt.detail?.recovered ? "📈 Verification: metrics are back to baseline. The incident is marked resolved." : "📉 Verification: metrics have **not** recovered yet. Further action is needed.";
      case "completed":
        return "📝 Investigation complete. The report is available in the Report tab.";
      case "failed":
        return `⚠️ Investigation failed: ${String(evt.detail?.error ?? "unknown error")}`;
      default:
        return null;
    }
  }


  private async refreshState(): Promise<IncidentState | null> {
    const incident = await getIncident(this.env.DB, this.incidentId);
    if (!incident) return null;
    const investigation = await latestInvestigation(this.env.DB, incident.id);
    const [hyps, actions] = await Promise.all([
      investigation ? listHypotheses(this.env.DB, investigation.id) : Promise.resolve([]),
      listActions(this.env.DB, incident.id),
    ]);
    const state: IncidentState = {
      incidentId: incident.id,
      title: incident.title,
      status: incident.status,
      severity: incident.severity,
      service: incident.service,
      investigation: investigation ? { id: investigation.id, status: investigation.status, phase: investigation.phase } : null,
      top_hypotheses: hyps.slice(0, 3).map((h) => ({ id: h.id, title: h.title, confidence: h.confidence })),
      pending_actions: actions.filter((a) => a.status === "pending_approval").map((a) => ({ id: a.id, type: a.type, target: a.target })),
    };
    this.kvSet("incident_state", JSON.stringify(state));
    this.broadcast({ type: "state_update", state });
    return state;
  }

  private buildPrompt(incident: IncidentRow, state: IncidentState | null): ChatMessage[] {
    const summary = this.kvGet("rolling_summary");
    const context = [
      `Incident ${incident.id}: "${incident.title}"`,
      incident.description ? `Reported: ${incident.description}` : "",
      `Current incident state (authoritative, from the system of record):\n${JSON.stringify(state)}`,
      `Current time: ${new Date().toISOString()}`,
      summary ? `Conversation so far (summary of older turns):\n${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${context}` },
      ...this.recentConversation().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
  }


  private async handleUserMessage(userId: string, clientMsgId: string, text: string, origin?: WebSocket) {
    const incidentId = this.incidentId;
    if (this.env.RATE_LIMITER) {
      const { success } = await this.env.RATE_LIMITER.limit({ key: `chat:${userId}` });
      if (!success) {
        if (origin) this.sendTo(origin, { type: "error", code: "rate_limited", message: "Too many messages, slow down.", retryable: true });
        return;
      }
    }

    const saved = this.saveMessage("user", text.slice(0, MAX_MESSAGE_CHARS), { clientMsgId });
    if (!saved) return;
    this.broadcast({ type: "user_message", message: saved, userId });

    const incident = await getIncident(this.env.DB, incidentId);
    if (!incident) {
      this.broadcast({ type: "error", code: "not_found", message: "Incident not found", retryable: false });
      return;
    }
    const state = await this.refreshState();
    const messages = this.buildPrompt(incident, state);
    const ctx = toolContext(this.env, incidentId, userId, incident.scenario);
    let toolCalls = 0;

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const res = await chat(this.env, { messages, tools: TOOL_SCHEMAS, maxTokens: 1024 });
        if (res.degraded) return this.finish(`_(Degraded mode: primary model unavailable, answering without tools.)_\n\n${res.text}`);
        if (!res.toolCalls.length) return this.finish(res.text || "I don't have anything to add yet.");

        for (const call of res.toolCalls) {
          if (++toolCalls > MAX_TOOL_CALLS) break;
          const result = await this.runTool(call.id, call.name, call.arguments, ctx);
          messages.push({ role: "assistant", content: JSON.stringify({ name: call.name, parameters: call.arguments }) });
          messages.push({ role: "tool", name: call.name, tool_call_id: call.id, content: wrapUntrusted(result) });
        }
        if (toolCalls >= MAX_TOOL_CALLS) break;
      }

      messages.push({ role: "user", content: "Tool budget reached. Answer now using only the information above; say what is still unknown." });
      const final = await chat(this.env, { messages, maxTokens: 800 });
      return this.finish(final.text || "I've reached my tool-call budget; see the timeline and evidence panel for what I found.");
    } catch (err) {
      if (err instanceof AiUnavailableError) return this.degradedReply(incident, userId, text);
      console.error(`[agent] turn failed: ${errorMessage(err)}`);
      return this.finish(`⚠️ Something went wrong while processing that message (${errorMessage(err).slice(0, 200)}). Please retry.`);
    } finally {
      this.ctx.waitUntil(this.maybeSummarize());
    }
  }

  private async runTool(callId: string, name: string, rawArgs: unknown, ctx: ReturnType<typeof toolContext>): Promise<unknown> {
    const tool = getTool(name);
    this.broadcast({ type: "tool_call", id: callId, name, args: rawArgs, status: "running" });

    let result: unknown;
    let status: "ok" | "error" = "ok";
    if (!tool) {
      result = { error: "invalid_tool_call", detail: `Unknown tool "${name}". Available: ${TOOL_SCHEMAS.map((t) => t.name).join(", ")}` };
      status = "error";
    } else {
      const args = tool.schema.safeParse(rawArgs ?? {});
      if (!args.success) {
        result = { error: "invalid_tool_call", detail: args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
        status = "error";
      } else {
        try {
          result = await withTimeout(tool.run(args.data, ctx), tool.timeoutMs, name);
          if (result && typeof result === "object" && "error" in result) status = "error";
        } catch (err) {
          result = { error: "tool_failed", detail: errorMessage(err) };
          status = "error";
        }
      }
    }

    const content = JSON.stringify(result).slice(0, 8000);
    this.saveMessage("tool", content, { toolName: name, toolCallId: callId });
    this.broadcast({ type: "tool_call", id: callId, name, args: rawArgs, status, result });
    await audit(this.env.DB, { incidentId: ctx.incidentId, actor: "agent", event: "tool_call", detail: { name, args: rawArgs, status } });

    if (status === "ok" && name === "start_investigation") {
      this.broadcast({ type: "investigation_progress", phase: "started", detail: result });
      await this.refreshState();
    }
    if (status === "ok" && name === "propose_remediation" && result && typeof result === "object" && "actionId" in result) {
      const action = await getAction(this.env.DB, ctx.incidentId, String(result.actionId));
      if (action) this.broadcast({ type: "approval_request", action });
      await this.refreshState();
    }
    return result;
  }

  private finish(text: string) {
    const saved = this.saveMessage("assistant", text);
    const chunks = text.match(/[\s\S]{1,48}(\s|$)|[\s\S]{1,48}/g) ?? [text];
    for (const chunk of chunks) this.broadcast({ type: "assistant_delta", messageId: saved?.id, text: chunk });
    this.broadcast({ type: "assistant_done", messageId: saved?.id, message: saved });
  }

  private async degradedReply(incident: IncidentRow, userId: string, text: string) {
    const lines = ["⚠️ **AI temporarily unavailable.** Running in degraded mode."];
    const investigation = await latestInvestigation(this.env.DB, incident.id);
    const active = investigation && (investigation.status === "running" || investigation.status === "awaiting_approval");
    const service = matchService(text) ?? matchService(`${incident.title} ${incident.description}`) ?? incident.service;

    if (!active && service) {
      try {
        const res = await startInvestigation(this.env, { incidentId: incident.id, service, symptom: text.slice(0, 300), actor: userId });
        this.broadcast({ type: "investigation_progress", phase: "started", detail: res });
        lines.push(`I started a deterministic investigation of \`${service}\` (\`${res.investigationId}\`). Progress will appear in the timeline.`);
      } catch (err) {
        lines.push(`I couldn't start an investigation: ${errorMessage(err)}`);
      }
    } else if (investigation) {
      const hyps = await listHypotheses(this.env.DB, investigation.id);
      const pending = (await listActions(this.env.DB, incident.id)).filter((a: ActionRow) => a.status === "pending_approval");
      lines.push(`Investigation \`${investigation.id}\` is **${investigation.status}** (phase: ${investigation.phase ?? "n/a"}).`);
      if (hyps.length) lines.push("Top hypotheses:", ...hyps.slice(0, 3).map((h) => `${h.rank}. ${h.title} (confidence ${h.confidence})`));
      if (pending.length) lines.push(`Pending approval: ${pending.map((a) => `${a.type} \`${a.target}\``).join(", ")}.`);
      lines.push("Raw evidence is shown in the Evidence panel.");
    } else {
      lines.push("Mention the affected service (e.g. checkout-api) and I'll start an investigation.");
    }
    await this.refreshState();
    this.finish(lines.join("\n\n"));
  }

  private async maybeSummarize() {
    try {
      const pending = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role IN ('user','assistant') AND summarized = 0")
        .toArray()[0].n;
      if (pending <= SUMMARIZE_THRESHOLD) return;

      const oldest = this.sql
        .exec<StoredMessage>("SELECT id, role, content FROM messages WHERE role IN ('user','assistant') AND summarized = 0 ORDER BY id LIMIT ?", SUMMARIZE_BATCH)
        .toArray();
      const previous = this.kvGet("rolling_summary") ?? "";
      const res = await chat(this.env, {
        cheap: true,
        maxTokens: 300,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: `Previous summary:\n${previous || "(none)"}\n\nNew messages:\n${oldest.map((m) => `${m.role}: ${m.content.slice(0, 800)}`).join("\n")}` },
        ],
      });
      if (!res.text.trim()) return;
      this.kvSet("rolling_summary", res.text.trim().slice(0, 2000));
      const maxId = oldest[oldest.length - 1].id;
      this.sql.exec("UPDATE messages SET summarized = 1 WHERE id <= ? AND role IN ('user','assistant')", maxId);
    } catch (err) {
      console.warn(`[agent] summarization skipped: ${errorMessage(err)}`);
    }
  }
}
