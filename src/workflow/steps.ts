import { executeAction, type ExecutionResult } from "../domain/executor";
import {
  audit,
  getAction,
  getIncident,
  getInvestigation,
  insertEvidence,
  listEvidence,
  listHypotheses,
  replaceHypotheses,
  updateIncident,
  updateInvestigation,
} from "../domain/repo";
import type { Env } from "../env";
import { evaluateRecovery, type InvestigationPlan, type RankedHypothesis, type RecoveryResult } from "../investigation/analysis";
import { gapEvidence, gatherEvidence, type GatherSource } from "../investigation/gather";
import { chooseAction, draftHypotheses, planInvestigation, rankHypotheses, writeReport } from "../investigation/pipeline";
import { safeJsonParse } from "../lib/json";
import { floorMinute } from "../lib/time";
import { D1TelemetryStore, d1Provider } from "../telemetry/provider";
import type { InvestigationParams, WorkflowPhase } from "./types";

export async function recordPhase(env: Env, incidentId: string, investigationId: string, phase: WorkflowPhase, detail?: unknown) {
  await updateInvestigation(env.DB, investigationId, { phase });
  await audit(env.DB, { incidentId, actor: "workflow", event: "phase", detail: { investigationId, phase, ...(detail as object) }, dedupeKey: `phase:${investigationId}:${phase}` });
}


export async function triage(env: Env, p: InvestigationParams): Promise<InvestigationPlan> {
  const plan = await planInvestigation(env, { service: p.service, symptom: p.symptom, description: p.description });
  await updateInvestigation(env.DB, p.investigationId, { plan_json: JSON.stringify(plan) });
  await updateIncident(env.DB, p.incidentId, { severity: plan.severity, service: plan.service });
  await recordPhase(env, p.incidentId, p.investigationId, "triage", { service: plan.service, severity: plan.severity, source: plan.source });
  return plan;
}


export async function gather(env: Env, p: InvestigationParams, plan: InvestigationPlan, source: GatherSource): Promise<string[]> {
  const evidence = await gatherEvidence(d1Provider(env.DB, p.scenario), source, plan, p.investigationId);
  await insertEvidence(env.DB, p.investigationId, p.incidentId, evidence);
  return evidence.map((e) => e.id);
}

export async function recordGap(env: Env, p: InvestigationParams, source: GatherSource, error: string): Promise<string[]> {
  const gap = gapEvidence(p.investigationId, source, error);
  await insertEvidence(env.DB, p.investigationId, p.incidentId, [gap]);
  return [gap.id];
}


export async function correlate(env: Env, p: InvestigationParams, plan: InvestigationPlan): Promise<{ count: number; source: "llm" | "heuristic" }> {
  const evidence = await listEvidence(env.DB, p.investigationId);
  const { drafts, source } = await draftHypotheses(env, plan, evidence);
  await replaceHypotheses(
    env.DB,
    p.investigationId,
    drafts.map((d, i) => ({ ...d, rank: i + 1, adjustments: [] })),
    `${p.investigationId}:hyp-draft`,
  );
  await audit(env.DB, { incidentId: p.incidentId, actor: "workflow", event: "correlated", detail: { source, count: drafts.length }, dedupeKey: `correlate:${p.investigationId}` });
  return { count: drafts.length, source };
}

export async function validate(env: Env, p: InvestigationParams, plan: InvestigationPlan): Promise<RankedHypothesis[]> {
  const evidence = await listEvidence(env.DB, p.investigationId);
  const drafts = await listHypotheses(env.DB, p.investigationId);
  const { ranked, usedHeuristic } = rankHypotheses(drafts, evidence, plan.service);
  await replaceHypotheses(env.DB, p.investigationId, ranked, `${p.investigationId}:hyp`);
  await recordPhase(env, p.incidentId, p.investigationId, "hypotheses_ranked", {
    top: ranked[0] ? { title: ranked[0].title, confidence: ranked[0].confidence } : null,
    adjustments: ranked.map((h) => ({ title: h.title, adjustments: h.adjustments })),
    usedHeuristic,
  });
  return ranked;
}


export async function propose(env: Env, p: InvestigationParams): Promise<string[]> {
  const [evidence, hypotheses] = await Promise.all([listEvidence(env.DB, p.investigationId), listHypotheses(env.DB, p.investigationId)]);
  const { action: chosen } = await chooseAction(env, hypotheses, evidence);

  if (!chosen) {
    await recordPhase(env, p.incidentId, p.investigationId, "approval_decided", { decision: "none", reason: "no safe action with sufficient confidence" });
    return [];
  }

  const actionId = `${p.investigationId}:action:1`;
  await env.DB.prepare(
    "INSERT INTO actions (id, investigation_id, incident_id, source, type, target, rationale, status, created_at) VALUES (?, ?, ?, 'workflow', ?, ?, ?, 'pending_approval', ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(actionId, p.investigationId, p.incidentId, chosen.type, chosen.target, chosen.rationale, Date.now())
    .run();
  await updateInvestigation(env.DB, p.investigationId, { status: "awaiting_approval" });
  await updateIncident(env.DB, p.incidentId, { status: "mitigating" });
  await recordPhase(env, p.incidentId, p.investigationId, "approval_required", { actionId, type: chosen.type, target: chosen.target });
  return [actionId];
}


export async function recordDecision(
  env: Env,
  p: InvestigationParams,
  actionId: string,
  eventApproved: boolean | null,
): Promise<"approved" | "rejected" | "timed_out"> {
  if (eventApproved === null) {
    await env.DB.prepare("UPDATE actions SET status = 'timed_out' WHERE id = ? AND status = 'pending_approval'").bind(actionId).run();
  }
  const action = await getAction(env.DB, p.incidentId, actionId);
  const decision = action?.status === "approved" || action?.status === "executed" ? "approved" : action?.status === "rejected" ? "rejected" : "timed_out";
  await updateInvestigation(env.DB, p.investigationId, { status: "running" });
  if (decision !== "approved") await updateIncident(env.DB, p.incidentId, { status: "investigating" });
  await recordPhase(env, p.incidentId, p.investigationId, "approval_decided", { actionId, decision, by: action?.decided_by });
  return decision;
}

export async function execute(env: Env, p: InvestigationParams, actionId: string): Promise<ExecutionResult> {
  const action = await getAction(env.DB, p.incidentId, actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  const result = await executeAction(env.DB, action, p.scenario, "workflow");
  await recordPhase(env, p.incidentId, p.investigationId, "action_executed", { actionId, summary: result.summary });
  return result;
}

export async function verify(env: Env, p: InvestigationParams, plan: InvestigationPlan, executedAt: number): Promise<RecoveryResult> {
  const provider = d1Provider(env.DB, p.scenario);
  const store = new D1TelemetryStore(env.DB, p.scenario);
  const from = floorMinute(executedAt);
  const now = Date.now();

  const pairs = await Promise.all(
    (["error_rate", "p95_latency"] as const).map(async (metric) => ({
      metric,
      before: await provider.getMetrics({ service: plan.service, metric, ...plan.window }),
      afterValues: (await store.metrics({ service: plan.service, metric, start: from, end: now })).map((r) => r.value),
    })),
  );
  const result = evaluateRecovery(plan.service, pairs);

  const summary = `Verification ${plan.service}: ${result.recovered ? "RECOVERED" : "NOT RECOVERED"}. ${result.checks
    .map((c) => `${c.metric} baseline ${c.baseline} → peak ${c.incidentPeak} → after ${c.after ?? "n/a"}`)
    .join("; ")}.`;
  await insertEvidence(env.DB, p.investigationId, p.incidentId, [
    { id: `${p.investigationId}:verification:1`, source: "verification", summary, raw: { kind: "verification", data: result }, isGap: false },
  ]);
  if (result.recovered) await updateIncident(env.DB, p.incidentId, { status: "resolved", resolved_at: now });
  await recordPhase(env, p.incidentId, p.investigationId, "verified", { recovered: result.recovered });
  return result;
}


export async function report(env: Env, p: InvestigationParams): Promise<{ source: "llm" | "template"; length: number }> {
  const [incident, investigation, evidence, hypotheses] = await Promise.all([
    getIncident(env.DB, p.incidentId),
    getInvestigation(env.DB, p.investigationId),
    listEvidence(env.DB, p.investigationId),
    listHypotheses(env.DB, p.investigationId),
  ]);
  const action = await env.DB.prepare("SELECT type, target, status, rationale FROM actions WHERE investigation_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(p.investigationId)
    .first<{ type: string; target: string; status: string; rationale: string }>();
  const plan = safeJsonParse<InvestigationPlan | null>(investigation?.plan_json, null);
  const verification = evidence.find((e) => e.raw.kind === "verification");
  const recovery = verification?.raw.kind === "verification" ? verification.raw.data : null;
  const input = { incidentTitle: incident?.title ?? p.symptom, plan, evidence, hypotheses, action: action ?? null, recovery };

  const { markdown, source, guardrail } = await writeReport(env, input);

  await updateInvestigation(env.DB, p.investigationId, { report_md: markdown, status: "completed", finished_at: Date.now() });
  const current = await getIncident(env.DB, p.incidentId);
  if (current && current.status !== "resolved" && action?.status !== "executed") await updateIncident(env.DB, p.incidentId, { status: "open" });
  await recordPhase(env, p.incidentId, p.investigationId, "completed", { reportSource: source, guardrail });
  return { source, length: markdown.length };
}

export async function markFailed(env: Env, p: InvestigationParams, error: string) {
  await updateInvestigation(env.DB, p.investigationId, { status: "failed", finished_at: Date.now() });
  await updateIncident(env.DB, p.incidentId, { status: "open" });
  await recordPhase(env, p.incidentId, p.investigationId, "failed", { error: error.slice(0, 500) });
}
