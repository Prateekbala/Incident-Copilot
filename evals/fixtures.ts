import { MINUTE } from "../src/lib/time";
import { MemoryTelemetryStore, SummarizingProvider } from "../src/telemetry/provider";
import { ONSET_OFFSET_MS, generateScenario } from "../src/telemetry/scenarios";
import type { ScenarioData, TelemetryProvider } from "../src/telemetry/types";
import type { EvalCase } from "./schema";

export const KNOWN_PII = ["jane.doe@example.com", "sk_live_51HxyzABCDEF123456"];

export function caseTimes(c: EvalCase) {
  const anchor = Math.floor(Date.parse(c.anchor) / MINUTE) * MINUTE;
  return { anchor, onset: anchor - ONSET_OFFSET_MS };
}

export function buildScenario(c: EvalCase): ScenarioData {
  const { anchor, onset } = caseTimes(c);
  const data = generateScenario(c.scenario, anchor, c.seed);
  for (const m of c.mutations) {
    if (m.type === "inject_log") {
      for (let i = 0; i < m.repeat; i++) {
        data.logs.push({ service: m.service, ts: onset + (m.offsetMin + i) * MINUTE + 7_000, level: m.level, message: m.message });
      }
    } else if (m.type === "add_deploy") {
      data.deployments.push({ id: m.id, service: m.service, version: m.version, ts: onset + m.offsetMin * MINUTE, author: "eval", message: m.message, status: "succeeded" });
    }
  }
  return data;
}

const FAILURE_SURFACE: Record<string, Array<keyof TelemetryProvider>> = {
  logs: ["queryLogs", "serviceActivity"],
  metrics: ["getMetrics"],
  deployments: ["listDeployments"],
  db_health: ["getDbHealth"],
};

export function buildProvider(c: EvalCase): TelemetryProvider {
  const inner = new SummarizingProvider(new MemoryTelemetryStore(buildScenario(c)));
  const failing = new Set(c.mutations.flatMap((m) => (m.type === "fail_source" ? FAILURE_SURFACE[m.source] : [])));
  if (!failing.size) return inner;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (failing.has(prop as keyof TelemetryProvider)) return async () => Promise.reject(new Error(`${String(prop)}: upstream timeout (simulated)`));
      return value.bind(target);
    },
  });
}
