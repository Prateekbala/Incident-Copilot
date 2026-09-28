import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Cassette, offlineAi, restAi, type AiLike, type CassetteData } from "./ai";
import { DEFAULT_JUDGE_MODEL, judgeReport } from "./judge";
import { runCase } from "./runner";
import { EvalCaseSchema, JudgeCalibrationSchema } from "./schema";
import { cohenKappa } from "./stats";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIN_KAPPA = 0.6;

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "live" },
    record: { type: "boolean", default: false },
  },
});

const readJsonl = (file: string) =>
  readFileSync(join(ROOT, "datasets", file), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

async function main() {
  console.warn = () => {};
  const cases = new Map(readJsonl("golden.jsonl").map((raw) => EvalCaseSchema.parse(raw)).map((c) => [c.id, c]));
  const items = readJsonl("judge-calibration.jsonl").map((raw) => JudgeCalibrationSchema.parse(raw));
  const model = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const cassetteFile = join(ROOT, "cassettes", "judge-calibration.json");

  let ai: AiLike;
  let cassette: Cassette | undefined;
  if (args.mode === "replay") {
    if (!existsSync(cassetteFile)) throw new Error("No judge-calibration cassette; run with --record first");
    ai = new Cassette("replay", JSON.parse(readFileSync(cassetteFile, "utf8")) as CassetteData);
  } else {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) throw new Error("Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or --mode replay)");
    const rest = restAi({ accountId, apiToken, gatewayId: process.env.AI_GATEWAY_ID || undefined });
    ai = args.record ? (cassette = new Cassette("record", {}, rest)) : rest;
  }

  const pairs: Array<[boolean, boolean]> = [];
  const rows: string[] = [];
  for (const item of items) {
    const c = cases.get(item.caseId);
    if (!c) throw new Error(`${item.id}: unknown case ${item.caseId}`);
    const { evidence } = await runCase(c, offlineAi());
    const verdict = await judgeReport(ai as unknown as Ai, model, {
      reference: c.expected.reference,
      expectedAction: c.expected.action ? `${c.expected.action.type} ${c.expected.action.target}` : "none: no automated action should be taken",
      actionStatus: item.actionStatus,
      evidence,
      report: item.report,
    });
    const judged = verdict?.pass ?? false;
    pairs.push([item.human.pass, judged]);
    const scores = verdict ? `C${verdict.correctness.score} G${verdict.groundedness.score} A${verdict.actionability.score} H${verdict.honesty.score}` : "no verdict";
    rows.push(`${item.human.pass === judged ? "✓" : "✗"} ${item.id.padEnd(28)} human=${item.human.pass ? "pass" : "fail"} judge=${judged ? "pass" : "fail"} (${scores})`);
  }

  if (cassette) {
    mkdirSync(dirname(cassetteFile), { recursive: true });
    writeFileSync(cassetteFile, JSON.stringify(cassette.data, null, 1));
  }

  const tp = pairs.filter(([h, j]) => h && j).length;
  const tn = pairs.filter(([h, j]) => !h && !j).length;
  const fp = pairs.filter(([h, j]) => !h && j).length;
  const fn = pairs.filter(([h, j]) => h && !j).length;
  const kappa = cohenKappa(pairs);
  process.stdout.write(
    [
      `Judge ${model} vs human labels (${pairs.length} items)`,
      ...rows,
      "",
      `accuracy ${((tp + tn) / pairs.length).toFixed(2)} · Cohen's kappa ${kappa.toFixed(2)} · false-pass ${fp} · false-fail ${fn}`,
      kappa >= MIN_KAPPA ? `PASS (kappa >= ${MIN_KAPPA})` : `FAIL (kappa < ${MIN_KAPPA}); do not trust judge scores until the rubric is fixed`,
      "",
    ].join("\n"),
  );
  process.exitCode = kappa >= MIN_KAPPA ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
