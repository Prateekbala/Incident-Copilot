import { z } from "zod";
import { chat, chatJson, type AiEnv } from "../ai/llm";
import { CORRELATE_PROMPT, PROPOSE_PROMPT, REPORT_PROMPT, TRIAGE_PROMPT, wrapUntrusted } from "../ai/prompts";
import { errorMessage } from "../lib/errors";
import { redact } from "../lib/redact";
import { iso, resolveWindow } from "../lib/time";
import { SERVICE_NAMES, databasesFor, isService, matchService } from "../telemetry/catalog";
import type { TelemetryProvider } from "../telemetry/types";
import {
  HYPOTHESIS_CATEGORIES,
  heuristicHypotheses,
  ruleBasedAction,
  templateReport,
  validateHypotheses,
  vetAction,
  type Evidence,
  type HypothesisDraft,
  type InvestigationPlan,
  type ProposedAction,
  type RankedHypothesis,
  type ReportInput,
} from "./analysis";
import { gapEvidence, gatherEvidence, type GatherSource } from "./gather";

export const ALL_SOURCES: GatherSource[] = ["logs", "metrics", "deployments", "db_health"];
const REQUIRED_SOURCES: GatherSource[] = ["logs", "metrics", "deployments"];

const zodValidate =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? { success: true as const, data: r.data } : { success: false as const, error: r.error.message };
  };

const TriageSchema = z.object({
  service: z.preprocess((v) => (typeof v === "string" ? (matchService(v) ?? v) : v), z.enum(SERVICE_NAMES)),
  symptom: z.string().min(3).max(300),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
  toolsToRun: z.array(z.enum(["logs", "metrics", "deployments", "db_health"])).default(ALL_SOURCES),
});

const HypothesesSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        explanation: z.string().min(3).max(1200),
        category: z.preprocess((v) => (typeof v === "string" && (HYPOTHESIS_CATEGORIES as readonly string[]).includes(v) ? v : "other"), z.enum(HYPOTHESIS_CATEGORIES)),
        confidence: z.coerce.number().min(0).max(1),
        evidence_ids: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(5),
});

const ProposalSchema = z.object({
  action: z.object({ type: z.string(), target: z.string(), rationale: z.string() }).nullable(),
});

export interface IncidentReport {
  service?: string;
  symptom: string;
  description: string;
}

export function fallbackSeverity(text: string): InvestigationPlan["severity"] {
  if (/\b(down|outage|all users|data loss)\b/i.test(text)) return "sev1";
  if (/\b5\d\ds?\b|5xx|errors?|failing|throwing/i.test(text)) return "sev2";
  return "sev3";
}

export function evidencePrompt(evidence: Evidence[]): string {
  return evidence.map((e) => `[${e.id}] (${e.source}) ${e.summary}`).join("\n");
}

export async function planInvestigation(ai: AiEnv, report: IncidentReport, now = Date.now()): Promise<InvestigationPlan> {
  const text = `${report.description}\nSymptom: ${report.symptom}\nSuggested service: ${report.service ?? "unknown"}`;
  const given = isService(report.service) ? report.service : undefined;

  let plan: InvestigationPlan = {
    service: given ?? matchService(text) ?? "checkout-api",
    symptom: report.symptom,
    severity: fallbackSeverity(text),
    window: resolveWindow(undefined, undefined, now),
    toolsToRun: ALL_SOURCES,
    source: "fallback",
  };

  try {
    const res = await chatJson(ai, {
      messages: [
        { role: "system", content: TRIAGE_PROMPT },
        { role: "user", content: wrapUntrusted(text) },
      ],
      jsonSchema: z.toJSONSchema(TriageSchema, { unrepresentable: "any" }) as Record<string, unknown>,
      maxTokens: 300,
      attempts: 1,
      validate: zodValidate(TriageSchema),
    });
    if (res) {
      plan = { ...plan, service: given ?? res.data.service, symptom: res.data.symptom, severity: res.data.severity, toolsToRun: res.data.toolsToRun, source: "llm" };
    }
  } catch (err) {
    console.warn(`[triage] falling back to default plan: ${errorMessage(err)}`);
  }

  const tools = new Set<GatherSource>([...plan.toolsToRun, ...REQUIRED_SOURCES]);
  if (databasesFor(plan.service).length) tools.add("db_health");
  plan.toolsToRun = ALL_SOURCES.filter((s) => tools.has(s));
  return plan;
}

export async function collectEvidence(provider: TelemetryProvider, plan: InvestigationPlan, investigationId: string): Promise<Evidence[]> {
  const batches = await Promise.all(
    plan.toolsToRun.map(async (source) => {
      try {
        return await gatherEvidence(provider, source, plan, investigationId);
      } catch (err) {
        return [gapEvidence(investigationId, source, errorMessage(err))];
      }
    }),
  );
  return batches.flat();
}

export async function draftHypotheses(
  ai: AiEnv,
  plan: InvestigationPlan,
  evidence: Evidence[],
): Promise<{ drafts: HypothesisDraft[]; source: "llm" | "heuristic" }> {
  try {
    const res = await chatJson(ai, {
      messages: [
        { role: "system", content: CORRELATE_PROMPT },
        {
          role: "user",
          content: `Incident: ${plan.symptom} (service ${plan.service}, window ${iso(plan.window.start)} → ${iso(plan.window.end)})\n\nEvidence:\n${wrapUntrusted(evidencePrompt(evidence))}`,
        },
      ],
      jsonSchema: z.toJSONSchema(HypothesesSchema, { unrepresentable: "any" }) as Record<string, unknown>,
      maxTokens: 1200,
      attempts: 1,
      validate: zodValidate(HypothesesSchema),
    });
    if (res?.data.hypotheses.length) return { drafts: res.data.hypotheses, source: "llm" };
  } catch (err) {
    console.warn(`[correlate] LLM unavailable: ${errorMessage(err)}`);
  }
  return { drafts: heuristicHypotheses(evidence, plan.service), source: "heuristic" };
}

export function rankHypotheses(drafts: HypothesisDraft[], evidence: Evidence[], service: string): { ranked: RankedHypothesis[]; usedHeuristic: boolean } {
  const ranked = validateHypotheses(drafts, evidence, service);
  if (ranked.length) return { ranked, usedHeuristic: false };
  return { ranked: validateHypotheses(heuristicHypotheses(evidence, service), evidence, service), usedHeuristic: true };
}

export async function chooseAction(
  ai: AiEnv,
  hypotheses: RankedHypothesis[],
  evidence: Evidence[],
): Promise<{ action: ProposedAction | null; source: "llm" | "rules" | "none" }> {
  const ruled = ruleBasedAction(hypotheses, evidence);
  if (!ruled) return { action: null, source: "none" };

  try {
    const res = await chatJson(ai, {
      messages: [
        { role: "system", content: PROPOSE_PROMPT },
        {
          role: "user",
          content: `Top hypotheses:\n${wrapUntrusted(hypotheses.map((h) => ({ rank: h.rank, title: h.title, category: h.category, confidence: h.confidence, evidence_ids: h.evidence_ids })))}\n\nEvidence:\n${wrapUntrusted(evidencePrompt(evidence))}`,
        },
      ],
      maxTokens: 400,
      attempts: 1,
      validate: zodValidate(ProposalSchema),
    });
    const vetted = vetAction(res?.data.action, hypotheses, evidence);
    if (vetted) return { action: vetted, source: "llm" };
  } catch (err) {
    console.warn(`[propose] LLM unavailable, using rule-based action: ${errorMessage(err)}`);
  }
  return { action: ruled, source: "rules" };
}

const EVIDENCE_ID = /\binv-[A-Za-z0-9-]+:[a-z_]+:[A-Za-z0-9._-]+/g;
const EXECUTION_CLAIM = /\b(?:has been|have been|was|were|successfully)\s+(?:rolled back|executed|scaled(?: up)?|restarted|applied|mitigated)\b/i;

export function checkReport(markdown: string, input: ReportInput): string | null {
  const known = new Set(input.evidence.map((e) => e.id));
  const unknown = [...new Set(markdown.match(EVIDENCE_ID) ?? [])].filter((id) => !known.has(id));
  if (unknown.length) return `cites unknown evidence ${unknown.slice(0, 3).join(", ")}`;
  if (input.action?.status !== "executed" && EXECUTION_CLAIM.test(markdown)) return "claims an action was executed but none was";
  return null;
}

export async function writeReport(ai: AiEnv, input: ReportInput): Promise<{ markdown: string; source: "llm" | "template"; guardrail?: string }> {
  let guardrail: string | undefined;
  try {
    const res = await chat(ai, {
      messages: [
        { role: "system", content: REPORT_PROMPT },
        {
          role: "user",
          content: wrapUntrusted({
            ...input,
            evidence: input.evidence.map((e) => ({ id: e.id, source: e.source, summary: e.summary, gap: e.isGap })),
            hypotheses: input.hypotheses.map((h) => ({ rank: h.rank, title: h.title, explanation: h.explanation, confidence: h.confidence, evidence_ids: h.evidence_ids })),
          }),
        },
      ],
      maxTokens: 1500,
      attempts: 1,
      allowFallback: false,
    });
    const markdown = redact(res.text.trim());
    if (markdown.length > 100) {
      guardrail = checkReport(markdown, input) ?? undefined;
      if (!guardrail) return { markdown, source: "llm" };
      console.warn(`[report] rejected LLM report: ${guardrail}`);
    }
  } catch (err) {
    console.warn(`[report] LLM unavailable, using template: ${errorMessage(err)}`);
  }
  return { markdown: templateReport(input), source: "template", guardrail };
}
