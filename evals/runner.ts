import type { AiEnv } from "../src/ai/llm";
import {
  evaluateRecovery,
  type Evidence,
  type HypothesisDraft,
  type InvestigationPlan,
  type ProposedAction,
  type RankedHypothesis,
  type RecoveryResult,
} from "../src/investigation/analysis";
import { chooseAction, collectEvidence, draftHypotheses, planInvestigation, rankHypotheses, writeReport } from "../src/investigation/pipeline";
import { BASELINES, EFFECTIVE_REMEDIATION } from "../src/telemetry/scenarios";
import type { AiLike, LlmCall } from "./ai";
import { RecordingAi } from "./ai";
import { buildProvider, caseTimes } from "./fixtures";
import type { EvalCase } from "./schema";

export interface Trace {
  caseId: string;
  trial: number;
  plan: InvestigationPlan;
  evidence: Evidence[];
  drafts: HypothesisDraft[];
  draftSource: "llm" | "heuristic";
  ranked: RankedHypothesis[];
  usedHeuristic: boolean;
  action: ProposedAction | null;
  actionSource: "llm" | "rules" | "none";
  decision: "approved" | "rejected" | "none";
  recovery: RecoveryResult | null;
  report: { markdown: string; source: "llm" | "template"; guardrail?: string };
  llmCalls: LlmCall[];
  durationMs: number;
}

export interface RunnerModels {
  primary?: string;
  fallback?: string;
}

function simulateRecovery(c: EvalCase, plan: InvestigationPlan, evidence: Evidence[], action: ProposedAction): RecoveryResult {
  const effective = c.scenario !== "healthy" && EFFECTIVE_REMEDIATION[c.scenario].type === action.type && EFFECTIVE_REMEDIATION[c.scenario].target === action.target;
  const pairs = (["error_rate", "p95_latency"] as const).flatMap((metric) => {
    const e = evidence.find((x) => x.raw.kind === "metrics" && x.raw.data.metric === metric);
    if (e?.raw.kind !== "metrics") return [];
    const after = effective ? BASELINES[plan.service][metric] : (e.raw.data.current ?? 0);
    return [{ metric, before: e.raw.data, afterValues: [after] }];
  });
  return evaluateRecovery(plan.service, pairs);
}

export async function runCase(c: EvalCase, ai: AiLike, trial = 0, models: RunnerModels = {}): Promise<Trace> {
  const started = performance.now();
  const recorder = new RecordingAi(ai);
  const env: AiEnv = { AI: recorder as unknown as Ai, PRIMARY_MODEL: models.primary, FALLBACK_MODEL: models.fallback };
  const { anchor } = caseTimes(c);
  const investigationId = `inv-eval-${c.id}`;

  recorder.stage = "triage";
  const plan = await planInvestigation(env, c.report, anchor);

  const evidence = await collectEvidence(buildProvider(c), plan, investigationId);

  recorder.stage = "correlate";
  const { drafts, source: draftSource } = await draftHypotheses(env, plan, evidence);
  const { ranked, usedHeuristic } = rankHypotheses(drafts, evidence, plan.service);

  recorder.stage = "propose";
  const { action, source: actionSource } = await chooseAction(env, ranked, evidence);

  const decision = action ? (c.approval === "approve" ? "approved" : "rejected") : "none";
  const recovery = action && decision === "approved" ? simulateRecovery(c, plan, evidence, action) : null;
  const allEvidence: Evidence[] = recovery
    ? [...evidence, { id: `${investigationId}:verification:1`, source: "verification", summary: `Verification ${plan.service}: ${recovery.recovered ? "RECOVERED" : "NOT RECOVERED"}.`, raw: { kind: "verification", data: recovery }, isGap: false }]
    : evidence;

  recorder.stage = "report";
  const report = await writeReport(env, {
    incidentTitle: c.report.symptom,
    plan,
    evidence: allEvidence,
    hypotheses: ranked,
    action: action ? { ...action, status: decision === "approved" ? "executed" : "rejected" } : null,
    recovery,
  });

  return {
    caseId: c.id,
    trial,
    plan,
    evidence: allEvidence,
    drafts,
    draftSource,
    ranked,
    usedHeuristic,
    action,
    actionSource,
    decision,
    recovery,
    report,
    llmCalls: recorder.calls,
    durationMs: Math.round(performance.now() - started),
  };
}
