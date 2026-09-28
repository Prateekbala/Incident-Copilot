import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_FALLBACK, DEFAULT_PRIMARY } from "../src/ai/llm";
import { errorMessage } from "../src/lib/errors";
import { Cassette, RecordingAi, chaosAi, offlineAi, restAi, type AiLike, type CassetteData } from "./ai";
import type { Mode } from "./config";
import { casePassed, gradeTrace } from "./graders";
import { DEFAULT_JUDGE_MODEL, judgeReport } from "./judge";
import { compare, computeMetrics, computeOps, evaluateGates, renderMarkdown, type CaseResult, type RunSummary, type TrialResult } from "./report";
import { runCase } from "./runner";
import { EvalCaseSchema, type EvalCase } from "./schema";

const ROOT = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "offline" },
    dataset: { type: "string", default: join(ROOT, "datasets/golden.jsonl") },
    filter: { type: "string" },
    trials: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    judge: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    baseline: { type: "string" },
    "no-baseline": { type: "boolean", default: false },
    "update-baseline": { type: "boolean", default: false },
    out: { type: "string", default: join(ROOT, "results") },
    verbose: { type: "boolean", default: false },
  },
});

const mode = args.mode as Mode;
if (!["offline", "chaos", "live", "replay"].includes(mode)) throw new Error(`Unknown --mode ${mode}`);
const trials = Math.max(1, Number(args.trials));
const concurrency = Math.max(1, Number(args.concurrency));
const models = {
  primary: process.env.PRIMARY_MODEL || DEFAULT_PRIMARY,
  fallback: process.env.FALLBACK_MODEL || DEFAULT_FALLBACK,
  judge: process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
};
const useJudge = args.judge && (mode === "live" || mode === "replay");
const cassetteDir = join(ROOT, "cassettes");

if (!args.verbose) console.warn = () => {};

function loadCases(path: string): EvalCase[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const cases = lines.flatMap((line, i) => {
    if (!line.trim()) return [];
    const parsed = EvalCaseSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${path}:${i + 1}: ${parsed.error.message}`);
    return [parsed.data];
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
  }
  if (!args.filter) return cases;
  const terms = args.filter.split(",").map((t) => t.trim());
  return cases.filter((c) => terms.some((t) => (t.startsWith("tag:") ? c.tags.includes(t.slice(4)) : c.id.includes(t))));
}

function baseAi(): AiLike {
  if (mode === "offline") return offlineAi();
  if (mode === "chaos") return chaosAi();
  if (mode === "replay") return offlineAi();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error("--mode live needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  return restAi({ accountId, apiToken, gatewayId: process.env.AI_GATEWAY_ID || undefined });
}

function aiForCase(c: EvalCase, base: AiLike): { ai: AiLike; save?: () => void } {
  const file = join(cassetteDir, `${c.id}.json`);
  if (mode === "replay") {
    if (!existsSync(file)) throw new Error(`No cassette for ${c.id}; record one with --mode live --record`);
    return { ai: new Cassette("replay", JSON.parse(readFileSync(file, "utf8")) as CassetteData) };
  }
  if (mode === "live" && args.record) {
    const cassette = new Cassette("record", {}, base);
    return {
      ai: cassette,
      save: () => {
        mkdirSync(cassetteDir, { recursive: true });
        writeFileSync(file, JSON.stringify(cassette.data, null, 1));
      },
    };
  }
  return { ai: base };
}

const describeAction = (a: { type: string; target: string } | null) => (a ? `${a.type} ${a.target}` : "none");

async function runOne(c: EvalCase, base: AiLike): Promise<CaseResult> {
  const results: TrialResult[] = [];
  let setup: { ai: AiLike; save?: () => void };
  try {
    setup = aiForCase(c, base);
  } catch (err) {
    return { caseId: c.id, tags: c.tags, trials: [emptyTrial(0, errorMessage(err))] };
  }

  for (let trial = 0; trial < trials; trial++) {
    try {
      const trace = await runCase(c, setup.ai, trial, models);
      const grades = gradeTrace(c, trace);
      let judge: TrialResult["judge"];
      const calls = [...trace.llmCalls];
      if (useJudge) {
        const recorder = new RecordingAi(setup.ai);
        recorder.stage = "judge";
        judge = await judgeReport(recorder as unknown as Ai, models.judge, {
          reference: c.expected.reference,
          expectedAction: c.expected.action ? describeAction(c.expected.action) : "none: no automated action should be taken",
          actionStatus: trace.decision === "approved" ? `${describeAction(trace.action)} executed` : trace.decision === "rejected" ? `${describeAction(trace.action)} proposed but rejected by the on-call engineer` : "no action proposed",
          evidence: trace.evidence,
          report: trace.report.markdown,
        }).catch(() => null);
        calls.push(...recorder.calls);
      }
      results.push({
        trial,
        passed: casePassed(grades),
        grades,
        judge,
        topConfidence: trace.ranked[0]?.confidence ?? null,
        hasRootCause: c.expected.rootCause !== null,
        action: describeAction(trace.action),
        sources: { triage: trace.plan.source, correlate: trace.draftSource, action: trace.actionSource, report: trace.report.source, guardrail: trace.report.guardrail },
        durationMs: trace.durationMs,
        llmCalls: calls.map(({ requestText: _omit, ...rest }) => rest),
      });
    } catch (err) {
      results.push(emptyTrial(trial, errorMessage(err)));
    }
  }
  setup.save?.();
  return { caseId: c.id, tags: c.tags, trials: results };
}

function emptyTrial(trial: number, error: string): TrialResult {
  return {
    trial,
    passed: false,
    grades: [],
    topConfidence: null,
    hasRootCause: false,
    action: "error",
    sources: { triage: "error", correlate: "error", action: "error", report: "error" },
    durationMs: 0,
    llmCalls: [],
    error,
  };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function main() {
  const cases = loadCases(resolve(args.dataset));
  if (!cases.length) throw new Error("No cases matched");
  const base = baseAi();
  const startedAt = new Date().toISOString();
  process.stdout.write(`Running ${cases.length} case(s) × ${trials} trial(s) in ${mode} mode${useJudge ? " with judge" : ""}...\n`);

  const results = await pool(cases, concurrency, async (c) => {
    const r = await runOne(c, base);
    const ok = r.trials.filter((t) => t.passed).length;
    process.stdout.write(`  ${ok === r.trials.length ? "✓" : "✗"} ${c.id} (${ok}/${r.trials.length})${r.trials[0]?.error ? ` — ${r.trials[0].error}` : ""}\n`);
    return r;
  });

  const metrics = computeMetrics(results);
  const summary: RunSummary = {
    mode,
    startedAt,
    models: { primary: models.primary, fallback: models.fallback, judge: useJudge ? models.judge : undefined },
    trials,
    cases: results,
    metrics,
    ops: computeOps(results, models.fallback),
    gates: evaluateGates(mode, metrics),
    passed: false,
  };

  const baselinePath = args.baseline ?? join(ROOT, "baselines", `${mode}.json`);
  if (!args["no-baseline"] && existsSync(baselinePath)) {
    summary.comparison = compare(summary, JSON.parse(readFileSync(baselinePath, "utf8")) as RunSummary);
  }
  const errors = results.flatMap((r) => r.trials).filter((t) => t.error).length;
  summary.passed = summary.gates.every((g) => g.passed) && !summary.comparison?.deltas.some((d) => d.regression) && errors === 0;

  const markdown = renderMarkdown(summary);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, `${mode}-latest.json`), JSON.stringify(summary, null, 2));
  writeFileSync(join(args.out, `${mode}-latest.md`), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

  if (args["update-baseline"]) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    const slim = { ...summary, comparison: undefined, cases: summary.cases.map((c) => ({ ...c, trials: c.trials.map((t) => ({ ...t, llmCalls: [] })) })) };
    writeFileSync(baselinePath, JSON.stringify(slim, null, 2));
    process.stdout.write(`Baseline written to ${baselinePath}\n`);
  }

  const failedGates = summary.gates.filter((g) => !g.passed).map((g) => `${g.metric}=${g.actual.toFixed(3)} (need ${g.op} ${g.value})`);
  const regressions = summary.comparison?.deltas.filter((d) => d.regression).map((d) => d.metric) ?? [];
  process.stdout.write(
    [
      "",
      `Result: ${summary.passed ? "PASS" : "FAIL"}`,
      `  rca_top1 ${fmt(metrics.rca_top1?.mean)} · action_accuracy ${fmt(metrics.action_accuracy?.mean)} · unsafe_action_rate ${fmt(metrics.unsafe_action_rate?.mean)} · case_pass_rate ${fmt(metrics.case_pass_rate?.mean)}`,
      failedGates.length ? `  failed gates: ${failedGates.join(", ")}` : "",
      regressions.length ? `  regressions vs baseline: ${regressions.join(", ")}` : "",
      errors ? `  ${errors} trial(s) errored` : "",
      `  report: ${join(args.out, `${mode}-latest.md`)}`,
      "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  process.exitCode = summary.passed ? 0 : 1;
}

const fmt = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "n/a" : n.toFixed(2));

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (args.verbose ? err.stack : err.message) : String(err)}\n`);
  process.exitCode = 2;
});
