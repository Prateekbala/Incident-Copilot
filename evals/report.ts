import type { LlmCall } from "./ai";
import { GATES, HIGHER_IS_BETTER, PRICING_PER_M, REGRESSION_TOLERANCE, type Gate, type Mode } from "./config";
import type { Grade } from "./graders";
import { JUDGE_DIMENSIONS, type JudgeVerdict } from "./judge";
import { bootstrapCI, brierScore, expectedCalibrationError, mean, percentile, type Estimate } from "./stats";

export interface TrialResult {
  trial: number;
  passed: boolean;
  grades: Grade[];
  judge?: JudgeVerdict | null;
  topConfidence: number | null;
  hasRootCause: boolean;
  action: string;
  sources: { triage: string; correlate: string; action: string; report: string; guardrail?: string };
  durationMs: number;
  llmCalls: Array<Omit<LlmCall, "requestText">>;
  error?: string;
}

export interface CaseResult {
  caseId: string;
  tags: string[];
  trials: TrialResult[];
}

export interface GateResult extends Gate {
  actual: number;
  passed: boolean;
}

export interface MetricDelta {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  regression: boolean;
}

export interface RunSummary {
  mode: Mode;
  startedAt: string;
  models: { primary: string; fallback: string; judge?: string };
  trials: number;
  cases: CaseResult[];
  metrics: Record<string, Estimate>;
  ops: Record<string, number>;
  gates: GateResult[];
  comparison?: { baselineStartedAt: string; deltas: MetricDelta[]; newlyFailing: string[]; newlyPassing: string[] };
  passed: boolean;
}

const gradeOf = (t: TrialResult, id: string) => t.grades.find((g) => g.id === id);

function perCase(cases: CaseResult[], fn: (t: TrialResult) => number | null): number[] {
  return cases.flatMap((c) => {
    const values = c.trials.map(fn).filter((v): v is number => v !== null && Number.isFinite(v));
    return values.length ? [mean(values)] : [];
  });
}

const passOf = (id: string) => (t: TrialResult) => {
  const g = gradeOf(t, id);
  return g?.pass == null ? null : g.pass ? 1 : 0;
};
const failOf = (id: string) => (t: TrialResult) => {
  const g = gradeOf(t, id);
  return g?.pass == null ? null : g.pass ? 0 : 1;
};

export function computeMetrics(cases: CaseResult[]): Record<string, Estimate> {
  const m: Record<string, Estimate> = {};
  const add = (name: string, values: number[]) => {
    if (values.length) m[name] = bootstrapCI(values);
  };

  add("case_pass_rate", perCase(cases, (t) => (t.passed ? 1 : 0)));
  add("pass_hat_k", cases.map((c) => (c.trials.every((t) => t.passed) ? 1 : 0)));
  add("rca_top1", perCase(cases, passOf("rca.top1")));
  add("rca_top3", perCase(cases, passOf("rca.top3")));
  add("citation_recall", perCase(cases, (t) => gradeOf(t, "rca.citation_recall")?.score ?? null));
  add("action_accuracy", perCase(cases, passOf("action.correct")));
  add("triage_service", perCase(cases, passOf("triage.service")));
  add("triage_severity", perCase(cases, passOf("triage.severity")));
  add("unsafe_action_rate", perCase(cases, failOf("safety.no_unsafe_action")));
  add("injection_success_rate", perCase(cases, failOf("safety.prompt_injection")));
  add(
    "pii_leak_rate",
    perCase(cases, (t) => (gradeOf(t, "privacy.report")?.pass === false || gradeOf(t, "privacy.model_egress")?.pass === false ? 1 : 0)),
  );
  add("ungrounded_report_rate", perCase(cases, failOf("report.grounded_citations")));
  add("dishonest_report_rate", perCase(cases, failOf("report.honest_status")));
  add("gap_disclosure", perCase(cases, passOf("report.discloses_gaps")));
  add("model_citation_precision", perCase(cases, (t) => gradeOf(t, "model.citation_precision")?.score ?? null));
  add("report_guardrail_trip_rate", perCase(cases, failOf("model.report_accepted")));

  const judged = (fn: (j: JudgeVerdict) => number) => perCase(cases, (t) => (t.judge ? fn(t.judge) : null));
  add("judge_pass_rate", judged((j) => (j.pass ? 1 : 0)));
  for (const d of JUDGE_DIMENSIONS) add(`judge_${d}`, judged((j) => j[d].score));

  return m;
}

export function computeOps(cases: CaseResult[], fallbackModel: string): Record<string, number> {
  const trials = cases.flatMap((c) => c.trials);
  const calls = trials.flatMap((t) => t.llmCalls);
  const pipelineOk = calls.filter((c) => c.ok && c.stage !== "judge");
  const cost = (c: Omit<LlmCall, "requestText">) => {
    const p = PRICING_PER_M[c.model];
    return p ? (c.inputTokens * p.input + c.outputTokens * p.output) / 1e6 : 0;
  };
  const llmLatency = trials.map((t) => t.llmCalls.reduce((a, c) => a + c.latencyMs, 0));
  const calibration = trials.filter((t) => t.hasRootCause && t.topConfidence !== null).map((t) => ({ p: t.topConfidence!, y: gradeOf(t, "rca.top1")?.pass === true }));
  const share = (pick: (t: TrialResult) => boolean) => (trials.length ? trials.filter(pick).length / trials.length : NaN);
  return {
    trials: trials.length,
    errors: trials.filter((t) => t.error).length,
    llm_calls_per_trial: trials.length ? calls.length / trials.length : 0,
    llm_error_rate: calls.length ? calls.filter((c) => !c.ok).length / calls.length : 0,
    fallback_model_rate: pipelineOk.length ? pipelineOk.filter((c) => c.model === fallbackModel).length / pipelineOk.length : 0,
    tokens_per_trial: trials.length ? calls.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0) / trials.length : 0,
    cost_per_trial_usd: trials.length ? calls.reduce((a, c) => a + cost(c), 0) / trials.length : 0,
    llm_latency_p50_ms: percentile(llmLatency, 50),
    llm_latency_p95_ms: percentile(llmLatency, 95),
    wall_p50_ms: percentile(trials.map((t) => t.durationMs), 50),
    triage_fallback_share: share((t) => t.sources.triage === "fallback"),
    correlate_heuristic_share: share((t) => t.sources.correlate === "heuristic"),
    report_template_share: share((t) => t.sources.report === "template"),
    brier: calibration.length ? brierScore(calibration) : NaN,
    ece: calibration.length ? expectedCalibrationError(calibration) : NaN,
  };
}

export function evaluateGates(mode: Mode, metrics: Record<string, Estimate>): GateResult[] {
  return GATES[mode].flatMap((g) => {
    const est = metrics[g.metric];
    if (!est) return [];
    const passed = g.op === ">=" ? est.mean >= g.value - 1e-9 : est.mean <= g.value + 1e-9;
    return [{ ...g, actual: est.mean, passed }];
  });
}

export function compare(current: RunSummary, baseline: RunSummary): NonNullable<RunSummary["comparison"]> {
  const deltas: MetricDelta[] = [];
  for (const [metric, est] of Object.entries(current.metrics)) {
    const base = baseline.metrics[metric];
    if (!base) continue;
    const delta = est.mean - base.mean;
    const noise = Math.max(REGRESSION_TOLERANCE, (est.hi - est.lo) / 2);
    const higher = HIGHER_IS_BETTER.has(metric);
    const lower = metric.endsWith("_rate") && !higher;
    const regression = (higher && -delta > noise) || (lower && delta > REGRESSION_TOLERANCE);
    deltas.push({ metric, baseline: base.mean, current: est.mean, delta, regression });
  }
  const passedIn = (s: RunSummary) => new Map(s.cases.map((c) => [c.caseId, c.trials.every((t) => t.passed)]));
  const before = passedIn(baseline);
  const after = passedIn(current);
  const newlyFailing = [...after].filter(([id, ok]) => !ok && before.get(id) === true).map(([id]) => id);
  const newlyPassing = [...after].filter(([id, ok]) => ok && before.get(id) === false).map(([id]) => id);
  return { baselineStartedAt: baseline.startedAt, deltas, newlyFailing, newlyPassing };
}

const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a");
const num = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : "n/a");
const isRatio = (metric: string) => !metric.startsWith("judge_") || metric === "judge_pass_rate";

function fmtMetric(metric: string, v: number) {
  return isRatio(metric) ? pct(v) : num(v);
}

export function renderMarkdown(s: RunSummary): string {
  const lines: string[] = [];
  const total = s.cases.length;
  const passedCases = s.cases.filter((c) => c.trials.every((t) => t.passed)).length;
  lines.push(`# Eval report: ${s.passed ? "✅ PASS" : "❌ FAIL"}`, "");
  lines.push(`Mode **${s.mode}** · ${total} cases × ${s.trials} trial(s) · ${passedCases}/${total} cases pass every trial · ${s.startedAt}`);
  lines.push(`Models: primary \`${s.models.primary}\`, fallback \`${s.models.fallback}\`${s.models.judge ? `, judge \`${s.models.judge}\`` : ""}`, "");

  lines.push("## Gates", "", "| Gate | Threshold | Actual | Result |", "| --- | --- | --- | --- |");
  for (const g of s.gates) lines.push(`| ${g.metric} | ${g.op} ${fmtMetric(g.metric, g.value)} | ${fmtMetric(g.metric, g.actual)} | ${g.passed ? "✅" : "❌"} |`);
  const regressions = s.comparison?.deltas.filter((d) => d.regression) ?? [];
  if (regressions.length) lines.push(`| regression vs baseline | none | ${regressions.map((r) => r.metric).join(", ")} | ❌ |`);

  const deltaFor = (metric: string) => s.comparison?.deltas.find((d) => d.metric === metric);
  lines.push("", "## Metrics (95% bootstrap CI over cases)", "", "| Metric | Value | 95% CI | Baseline | Δ |", "| --- | --- | --- | --- | --- |");
  for (const [metric, est] of Object.entries(s.metrics)) {
    const d = deltaFor(metric);
    const delta = d ? `${d.delta >= 0 ? "+" : ""}${isRatio(metric) ? (d.delta * 100).toFixed(1) + "pp" : d.delta.toFixed(2)}${d.regression ? " ⚠️" : ""}` : "";
    lines.push(`| ${metric} | ${fmtMetric(metric, est.mean)} | ${fmtMetric(metric, est.lo)} – ${fmtMetric(metric, est.hi)} | ${d ? fmtMetric(metric, d.baseline) : ""} | ${delta} |`);
  }

  const o = s.ops;
  lines.push(
    "",
    "## Operations",
    "",
    `- LLM calls/trial ${num(o.llm_calls_per_trial, 1)}, error rate ${pct(o.llm_error_rate)}, fallback-model rate ${pct(o.fallback_model_rate)}`,
    `- Tokens/trial ${num(o.tokens_per_trial, 0)}, cost/trial $${num(o.cost_per_trial_usd, 5)}, LLM latency p50 ${num(o.llm_latency_p50_ms, 0)} ms / p95 ${num(o.llm_latency_p95_ms, 0)} ms`,
    `- Deterministic fallbacks: triage ${pct(o.triage_fallback_share)}, correlation ${pct(o.correlate_heuristic_share)}, report ${pct(o.report_template_share)}`,
    `- Calibration of top-hypothesis confidence: Brier ${num(o.brier, 3)}, ECE ${num(o.ece, 3)}`,
  );

  if (s.comparison) {
    lines.push("", `## Change vs baseline (${s.comparison.baselineStartedAt})`, "");
    lines.push(`- Newly failing: ${s.comparison.newlyFailing.length ? s.comparison.newlyFailing.map((c) => `\`${c}\``).join(", ") : "none"}`);
    lines.push(`- Newly passing: ${s.comparison.newlyPassing.length ? s.comparison.newlyPassing.map((c) => `\`${c}\``).join(", ") : "none"}`);
  }

  lines.push("", "## Cases", "", "| Case | Tags | Pass | Action | Failures |", "| --- | --- | --- | --- | --- |");
  for (const c of s.cases) {
    const passes = c.trials.filter((t) => t.passed).length;
    const failures = [...new Set(c.trials.flatMap((t) => [...(t.error ? [`error: ${t.error}`] : []), ...t.grades.filter((g) => g.pass === false).map((g) => `${g.id}: ${g.detail}`)]))];
    lines.push(
      `| \`${c.caseId}\` | ${c.tags.join(", ")} | ${passes}/${c.trials.length} | ${[...new Set(c.trials.map((t) => t.action))].join(" / ")} | ${failures.join("<br>").replace(/\|/g, "\\|") || "—"} |`,
    );
  }

  const judged = s.cases.flatMap((c) => c.trials.filter((t) => t.judge).map((t) => ({ id: c.caseId, j: t.judge! })));
  const failedJudgements = judged.filter((x) => !x.j.pass);
  if (failedJudgements.length) {
    lines.push("", "## Judge failures", "");
    for (const { id, j } of failedJudgements.slice(0, 10)) {
      const low = JUDGE_DIMENSIONS.filter((d) => j[d].score < 4).map((d) => `${d} ${j[d].score}/5 — ${j[d].reasoning.slice(0, 200)}`);
      lines.push(`- \`${id}\`: ${low.join("; ")}`);
    }
  }
  return lines.join("\n") + "\n";
}
