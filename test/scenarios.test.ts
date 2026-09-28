import { describe, expect, it } from "vitest";
import {
  evaluateRecovery,
  heuristicHypotheses,
  ruleBasedAction,
  validateHypotheses,
  vetAction,
  type Evidence,
  type InvestigationPlan,
} from "../src/investigation/analysis";
import { gatherEvidence, type GatherSource } from "../src/investigation/gather";
import { HOUR, MINUTE } from "../src/lib/time";
import type { ScenarioName } from "../src/telemetry/catalog";
import { MemoryTelemetryStore, SummarizingProvider } from "../src/telemetry/provider";
import { generateScenario, ONSET_OFFSET_MS } from "../src/telemetry/scenarios";

const ANCHOR = Date.UTC(2026, 8, 28, 14, 20);

async function investigate(scenario: ScenarioName, now = ANCHOR) {
  const data = generateScenario(scenario, ANCHOR);
  const provider = new SummarizingProvider(new MemoryTelemetryStore(data));
  const plan: InvestigationPlan = {
    service: "checkout-api",
    symptom: "checkout errors and latency",
    severity: "sev2",
    window: { start: now - 3 * HOUR, end: now },
    toolsToRun: ["logs", "metrics", "deployments", "db_health"],
    source: "fallback",
  };
  const evidence: Evidence[] = (
    await Promise.all(plan.toolsToRun.map((s: GatherSource) => gatherEvidence(provider, s, plan, "inv-test")))
  ).flat();
  const ranked = validateHypotheses(heuristicHypotheses(evidence, plan.service), evidence, plan.service);
  return { data, provider, plan, evidence, ranked, action: ruleBasedAction(ranked, evidence) };
}

describe("scenario A: n_plus_one_deploy", () => {
  it("ranks the checkout deploy first and proposes a rollback", async () => {
    const { ranked, action, evidence } = await investigate("n_plus_one_deploy");
    expect(ranked[0].category).toBe("deploy");
    expect(ranked[0].title).toContain("checkout-api@2.3.1");
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(ranked[0].evidence_ids).toContain("inv-test:db:orders-db");
    expect(action).toMatchObject({ type: "rollback", target: "checkout-api" });
    expect(evidence.every((e) => !e.isGap)).toBe(true);
  });

  it("detects the latency onset near the seeded onset and an ~8x p95 jump", async () => {
    const { evidence } = await investigate("n_plus_one_deploy");
    const p95 = evidence.find((e) => e.id === "inv-test:metrics:p95_latency");
    expect(p95?.raw.kind).toBe("metrics");
    if (p95?.raw.kind !== "metrics") return;
    const onset = p95.raw.data.onset!;
    expect(Math.abs(onset - (ANCHOR - ONSET_OFFSET_MS))).toBeLessThanOrEqual(6 * MINUTE);
    expect(p95.raw.data.current! / p95.raw.data.baseline!).toBeGreaterThan(6);
  });

  it("redacts secrets from log samples", async () => {
    const { evidence } = await investigate("n_plus_one_deploy");
    const text = JSON.stringify(evidence);
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).not.toContain("sk_live_51HxyzABCDEF123456");
  });
});

describe("scenario B: cron_cpu_spike (red herring)", () => {
  it("ranks the batch job above the unrelated deploy and proposes scale_up", async () => {
    const { ranked, action } = await investigate("cron_cpu_spike");
    expect(ranked[0].category).toBe("batch_job");
    expect(ranked[0].title).toContain("reconciliation-cron");
    const deploy = ranked.find((h) => h.category === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.confidence).toBeLessThan(0.2);
    expect(action).toMatchObject({ type: "scale_up", target: "orders-db" });
  });

  it("refuses an LLM-proposed rollback that the evidence does not support", async () => {
    const { ranked, evidence } = await investigate("cron_cpu_spike");
    expect(vetAction({ type: "rollback", target: "checkout-api", rationale: "latest deploy" }, ranked, evidence)).toBeNull();
    expect(vetAction({ type: "rollback", target: "payments-api", rationale: "log said so" }, ranked, evidence)).toBeNull();
    expect(vetAction({ type: "scale_up", target: "orders-db", rationale: "cpu" }, ranked, evidence)).toMatchObject({ type: "scale_up" });
  });
});

describe("validateHypotheses", () => {
  it("drops hypotheses citing only nonexistent evidence and downgrades stale deploys", async () => {
    const { evidence } = await investigate("cron_cpu_spike");
    const ranked = validateHypotheses(
      [
        { title: "Made up", explanation: "x", category: "other", confidence: 0.99, evidence_ids: ["inv-test:nope:1"] },
        { title: "Blame deploy", explanation: "x", category: "deploy", confidence: 0.9, evidence_ids: ["inv-test:deploy:dep-b-2", "bogus"] },
      ],
      evidence,
      "checkout-api",
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].title).toBe("Blame deploy");
    expect(ranked[0].evidence_ids).toEqual(["inv-test:deploy:dep-b-2"]);
    expect(ranked[0].confidence).toBeLessThan(0.5);
    expect(ranked[0].adjustments.join(" ")).toMatch(/invalid citation/);
  });
});

describe("evaluateRecovery", () => {
  it("reports recovery only when post-remediation values return near baseline", async () => {
    const { evidence } = await investigate("n_plus_one_deploy");
    const get = (metric: string) => {
      const e = evidence.find((x) => x.id === `inv-test:metrics:${metric}`)!;
      if (e.raw.kind !== "metrics") throw new Error("bad evidence");
      return e.raw.data;
    };
    const ok = evaluateRecovery("checkout-api", [
      { metric: "error_rate", before: get("error_rate"), afterValues: [0.3, 0.35] },
      { metric: "p95_latency", before: get("p95_latency"), afterValues: [185, 190] },
    ]);
    expect(ok.recovered).toBe(true);

    const bad = evaluateRecovery("checkout-api", [
      { metric: "error_rate", before: get("error_rate"), afterValues: [11.5] },
      { metric: "p95_latency", before: get("p95_latency"), afterValues: [1400] },
    ]);
    expect(bad.recovered).toBe(false);

    const empty = evaluateRecovery("checkout-api", [{ metric: "error_rate", before: get("error_rate"), afterValues: [] }]);
    expect(empty.recovered).toBe(false);
  });
});
