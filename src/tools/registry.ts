import { z } from "zod";
import type { ToolSchema } from "../ai/llm";
import type { Env } from "../env";
import { ACTION_TYPES } from "../investigation/analysis";
import { HOUR, iso, parseTime, resolveWindow } from "../lib/time";
import { DATABASES, METRICS, SERVICE_NAMES, matchService, type ScenarioName } from "../telemetry/catalog";
import { d1Provider } from "../telemetry/provider";
import type { TelemetryProvider } from "../telemetry/types";
import { getEvidence, proposeChatAction, startInvestigation } from "../domain/investigations";

export interface ToolContext {
  env: Env;
  incidentId: string;
  userId: string;
  scenario: ScenarioName;
  provider: TelemetryProvider;
}

export interface Tool<A = any, R = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  mutating: boolean;
  gated?: boolean;
  timeoutMs: number;
  run(args: A, ctx: ToolContext): Promise<R>;
}

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const time = optional(z.union([z.string().max(64), z.number()])).describe(
  'ISO-8601 timestamp, unix ms, or relative like "now-30m". Defaults to the last 3 hours.',
);
const service = z
  .preprocess((v) => (typeof v === "string" ? (matchService(v) ?? v) : v), z.enum(SERVICE_NAMES))
  .describe(`Service name. One of: ${SERVICE_NAMES.join(", ")}`);

function tool<S extends z.ZodType, R>(def: Omit<Tool<z.infer<S>, R>, "schema"> & { schema: S }): Tool<z.infer<S>, R> {
  return def as Tool<z.infer<S>, R>;
}

export const TOOLS = [
  tool({
    name: "query_logs",
    description: "Search a service's logs in a time window. Returns aggregated error signatures with counts and one sample line each (not raw logs).",
    schema: z.object({
      service,
      start: time,
      end: time,
      level: optional(z.enum(["DEBUG", "INFO", "WARN", "ERROR"])),
      contains: optional(z.string().max(100)),
      limit: optional(z.coerce.number().int().min(1).max(50)),
    }),
    mutating: false,
    timeoutMs: 8000,
    async run(a, ctx) {
      const w = resolveWindow(a.start, a.end);
      const s = await ctx.provider.queryLogs({ service: a.service, start: w.start, end: w.end, level: a.level, contains: a.contains, limit: a.limit });
      return {
        service: s.service,
        window: `${iso(w.start)} → ${iso(w.end)}`,
        total: s.total,
        byLevel: s.byLevel,
        signatures: s.signatures.map((sig) => ({ level: sig.level, count: sig.count, firstSeen: iso(sig.firstSeen), lastSeen: iso(sig.lastSeen), sample: sig.sample })),
      };
    },
  }),
  tool({
    name: "get_metrics",
    description: "Get a metric for a service: baseline vs incident window, peak, current value, delta % and anomaly onset time.",
    schema: z.object({ service, metric: z.enum(METRICS), start: time, end: time }),
    mutating: false,
    timeoutMs: 8000,
    async run(a, ctx) {
      const w = resolveWindow(a.start, a.end);
      const m = await ctx.provider.getMetrics({ service: a.service, metric: a.metric, start: w.start, end: w.end });
      return {
        service: m.service,
        metric: m.metric,
        unit: m.unit,
        baseline: m.baseline,
        peak: m.peak,
        current: m.current,
        deltaPct: m.deltaPct,
        onset: m.onset ? iso(m.onset) : null,
      };
    },
  }),
  tool({
    name: "list_deployments",
    description: "List recent deployments (version, time, author, message, status). Omit service to list deployments across all services.",
    schema: z.object({ service: optional(service), since: time }),
    mutating: false,
    timeoutMs: 8000,
    async run(a, ctx) {
      const since = parseTime(a.since) ?? Date.now() - 24 * HOUR;
      const deploys = await ctx.provider.listDeployments({ service: a.service, since, until: Date.now() });
      return deploys.map((d) => ({ service: d.service, version: d.version, time: iso(d.ts), author: d.author, message: d.message, status: d.status }));
    },
  }),
  tool({
    name: "check_db_health",
    description: "Database health over the last 3 hours: connections used/max, slow queries, replication lag and CPU (baseline, peak, current).",
    schema: z.object({ database: z.enum(DATABASES) }),
    mutating: false,
    timeoutMs: 8000,
    async run(a, ctx) {
      const w = resolveWindow(undefined, undefined);
      const h = await ctx.provider.getDbHealth({ database: a.database, start: w.start, end: w.end });
      return { database: h.database, baseline: h.baseline, peak: h.peak, current: h.current, saturationOnset: h.onset ? iso(h.onset) : null, saturation: h.saturation };
    },
  }),
  tool({
    name: "get_evidence",
    description: "Fetch a piece of evidence collected by the investigation by its ID (e.g. to show raw data behind a hypothesis).",
    schema: z.object({ evidence_id: z.string().min(1).max(200) }),
    mutating: false,
    timeoutMs: 5000,
    async run(a, ctx) {
      const e = await getEvidence(ctx.env.DB, ctx.incidentId, a.evidence_id);
      return e ?? { error: "not_found", detail: `No evidence ${a.evidence_id} for this incident` };
    },
  }),
  tool({
    name: "start_investigation",
    description:
      "Start a deep, multi-step investigation workflow (logs, metrics, deploys, DB health, correlation, remediation proposal). Use this for any outage rather than chaining many tools manually.",
    schema: z.object({
      service,
      symptom: z.string().min(3).max(500),
      start_time: optional(z.string().max(64)),
    }),
    mutating: false,
    timeoutMs: 8000,
    async run(a, ctx) {
      return startInvestigation(ctx.env, {
        incidentId: ctx.incidentId,
        service: a.service,
        symptom: a.symptom,
        startTime: a.start_time,
        actor: "agent",
      });
    },
  }),
  tool({
    name: "propose_remediation",
    description:
      "Propose a remediation (rollback, scale_up or restart). This does NOT execute anything: it creates a request that a human must approve.",
    schema: z.object({
      type: z.enum(ACTION_TYPES),
      target: z.string().min(1).max(64),
      rationale: z.string().min(3).max(600),
    }),
    mutating: true,
    gated: true,
    timeoutMs: 5000,
    async run(a, ctx) {
      return proposeChatAction(ctx.env, { incidentId: ctx.incidentId, ...a });
    },
  }),
] as const;

const byName = new Map<string, Tool>(TOOLS.map((t) => [t.name, t as Tool]));

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

export const TOOL_SCHEMAS: ToolSchema[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: jsonSchemaFor(t.schema),
}));

export function toolContext(env: Env, incidentId: string, userId: string, scenario: ScenarioName): ToolContext {
  return { env, incidentId, userId, scenario, provider: d1Provider(env.DB, scenario) };
}
