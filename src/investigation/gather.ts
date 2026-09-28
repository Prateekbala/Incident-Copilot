import { stepId } from "../lib/ids";
import { HOUR } from "../lib/time";
import { METRICS, databasesFor, isService, type ServiceName } from "../telemetry/catalog";
import type { TelemetryProvider } from "../telemetry/types";
import { describeDb, describeDeployment, describeLogs, describeMetric, type Evidence, type InvestigationPlan } from "./analysis";

export type GatherSource = InvestigationPlan["toolsToRun"][number];

const MAX_EXTRA_LOG_SERVICES = 3;

async function primaryOnset(provider: TelemetryProvider, plan: InvestigationPlan): Promise<number | null> {
  const [err, lat] = await Promise.all(
    (["error_rate", "p95_latency"] as const).map((metric) => provider.getMetrics({ service: plan.service, metric, ...plan.window })),
  );
  const onsets = [err.onset, lat.onset].filter((t): t is number => t !== null);
  return onsets.length ? Math.min(...onsets) : null;
}

export async function gatherEvidence(provider: TelemetryProvider, source: GatherSource, plan: InvestigationPlan, investigationId: string): Promise<Evidence[]> {
  const { window } = plan;

  switch (source) {
    case "logs": {
      const activity = await provider.serviceActivity(window);
      const noisy = activity
        .filter((a) => a.service !== plan.service && isService(a.service) && a.warn + a.error > 0)
        .sort((a, b) => b.error + b.warn - (a.error + a.warn))
        .slice(0, MAX_EXTRA_LOG_SERVICES)
        .map((a) => a.service as ServiceName);
      const services: ServiceName[] = [plan.service, ...noisy];
      const summaries = await Promise.all(services.map((service) => provider.queryLogs({ service, ...window, limit: 8 })));
      return summaries.map((s) => ({
        id: stepId(investigationId, "logs", s.service),
        source: "logs",
        summary: describeLogs(s),
        raw: { kind: "logs", data: s },
        isGap: false,
      }));
    }

    case "metrics": {
      const summaries = await Promise.all(METRICS.map((metric) => provider.getMetrics({ service: plan.service, metric, ...window })));
      return summaries.map((m) => ({
        id: stepId(investigationId, "metrics", m.metric),
        source: "metrics",
        summary: describeMetric(m),
        raw: { kind: "metrics", data: m },
        isGap: false,
      }));
    }

    case "deployments": {
      const [deploys, onset] = await Promise.all([
        provider.listDeployments({ since: window.start - 3 * HOUR, until: window.end }),
        primaryOnset(provider, plan),
      ]);
      return deploys.map((d) => ({
        id: stepId(investigationId, "deploy", d.id),
        source: "deployments",
        summary: describeDeployment(d, onset),
        raw: { kind: "deployment", data: d },
        isGap: false,
      }));
    }

    case "db_health": {
      const summaries = await Promise.all(databasesFor(plan.service).map((database) => provider.getDbHealth({ database, ...window })));
      return summaries.map((s) => ({
        id: stepId(investigationId, "db", s.database),
        source: "db_health",
        summary: describeDb(s),
        raw: { kind: "db_health", data: s },
        isGap: false,
      }));
    }
  }
}

export function gapEvidence(investigationId: string, source: GatherSource, error: string): Evidence {
  return {
    id: stepId(investigationId, "gap", source),
    source: source === "db_health" ? "db_health" : source,
    summary: `Evidence gap: ${source} could not be collected (${error.slice(0, 200)}).`,
    raw: { kind: "gap", data: { source, error } },
    isGap: true,
  };
}
