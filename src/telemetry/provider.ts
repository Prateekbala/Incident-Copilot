import { summarizeDbHealth, summarizeLogs, summarizeMetric } from "./summarize";
import type {
  DbHealthQuery,
  DbHealthRow,
  DbHealthSummary,
  DeploymentQuery,
  DeploymentRow,
  DeploymentSummary,
  LogQuery,
  LogRow,
  LogSummary,
  MetricQuery,
  MetricRow,
  MetricSummary,
  ScenarioData,
  ServiceActivity,
  TelemetryProvider,
  TelemetryStore,
} from "./types";

export class SummarizingProvider implements TelemetryProvider {
  constructor(private store: TelemetryStore) {}

  async queryLogs(q: LogQuery): Promise<LogSummary> {
    return summarizeLogs(await this.store.logs(q), q);
  }

  async getMetrics(q: MetricQuery): Promise<MetricSummary> {
    return summarizeMetric(await this.store.metrics(q), q);
  }

  async listDeployments(q: DeploymentQuery): Promise<DeploymentSummary[]> {
    const rows = await this.store.deployments(q);
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 20);
  }

  async getDbHealth(q: DbHealthQuery): Promise<DbHealthSummary> {
    return summarizeDbHealth(await this.store.dbHealth(q), q);
  }

  serviceActivity(q: { start: number; end: number }): Promise<ServiceActivity[]> {
    return this.store.activity(q);
  }
}

const LOG_ROW_CAP = 5000;

export class D1TelemetryStore implements TelemetryStore {
  constructor(
    private db: D1Database,
    private scenario: string,
  ) {}

  async logs(q: LogQuery): Promise<LogRow[]> {
    const clauses = ["scenario = ?", "service = ?", "ts >= ?", "ts <= ?"];
    const params: unknown[] = [this.scenario, q.service, q.start, q.end];
    if (q.level) {
      clauses.push("level = ?");
      params.push(q.level);
    }
    if (q.contains) {
      clauses.push("instr(lower(message), lower(?)) > 0");
      params.push(q.contains);
    }
    const { results } = await this.db
      .prepare(`SELECT service, ts, level, message, trace_id FROM telemetry_logs WHERE ${clauses.join(" AND ")} ORDER BY ts LIMIT ${LOG_ROW_CAP}`)
      .bind(...params)
      .all<LogRow>();
    return results;
  }

  async metrics(q: MetricQuery): Promise<MetricRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT service, metric, ts, value FROM telemetry_metrics WHERE scenario = ? AND service = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts",
      )
      .bind(this.scenario, q.service, q.metric, q.start, q.end)
      .all<MetricRow>();
    return results;
  }

  async deployments(q: DeploymentQuery): Promise<DeploymentRow[]> {
    const stmt = q.service
      ? this.db
          .prepare("SELECT id, service, version, ts, author, message, status FROM telemetry_deployments WHERE scenario = ? AND service = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC")
          .bind(this.scenario, q.service, q.since, q.until)
      : this.db
          .prepare("SELECT id, service, version, ts, author, message, status FROM telemetry_deployments WHERE scenario = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC")
          .bind(this.scenario, q.since, q.until);
    return (await stmt.all<DeploymentRow>()).results;
  }

  async dbHealth(q: DbHealthQuery): Promise<DbHealthRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT database, ts, active_connections, max_connections, slow_queries, replication_lag_ms, cpu_pct FROM telemetry_db_health WHERE scenario = ? AND database = ? AND ts >= ? AND ts <= ? ORDER BY ts",
      )
      .bind(this.scenario, q.database, q.start, q.end)
      .all<DbHealthRow>();
    return results;
  }

  async activity(q: { start: number; end: number }): Promise<ServiceActivity[]> {
    const { results } = await this.db
      .prepare(
        `SELECT service, COUNT(*) AS total,
                SUM(CASE WHEN level = 'WARN' THEN 1 ELSE 0 END) AS warn,
                SUM(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) AS error
           FROM telemetry_logs WHERE scenario = ? AND ts >= ? AND ts <= ? GROUP BY service`,
      )
      .bind(this.scenario, q.start, q.end)
      .all<ServiceActivity>();
    return results;
  }
}

export class MemoryTelemetryStore implements TelemetryStore {
  constructor(private data: ScenarioData) {}

  async logs(q: LogQuery): Promise<LogRow[]> {
    return this.data.logs
      .filter(
        (r) =>
          r.service === q.service &&
          r.ts >= q.start &&
          r.ts <= q.end &&
          (!q.level || r.level === q.level) &&
          (!q.contains || r.message.toLowerCase().includes(q.contains.toLowerCase())),
      )
      .sort((a, b) => a.ts - b.ts)
      .slice(0, LOG_ROW_CAP);
  }

  async metrics(q: MetricQuery): Promise<MetricRow[]> {
    return this.data.metrics.filter((r) => r.service === q.service && r.metric === q.metric && r.ts >= q.start && r.ts <= q.end);
  }

  async deployments(q: DeploymentQuery): Promise<DeploymentRow[]> {
    return this.data.deployments.filter((r) => (!q.service || r.service === q.service) && r.ts >= q.since && r.ts <= q.until);
  }

  async dbHealth(q: DbHealthQuery): Promise<DbHealthRow[]> {
    return this.data.dbHealth.filter((r) => r.database === q.database && r.ts >= q.start && r.ts <= q.end);
  }

  async activity(q: { start: number; end: number }): Promise<ServiceActivity[]> {
    const map = new Map<string, ServiceActivity>();
    for (const r of this.data.logs) {
      if (r.ts < q.start || r.ts > q.end) continue;
      const a = map.get(r.service) ?? { service: r.service, total: 0, warn: 0, error: 0 };
      a.total++;
      if (r.level === "WARN") a.warn++;
      if (r.level === "ERROR") a.error++;
      map.set(r.service, a);
    }
    return [...map.values()];
  }
}

export function d1Provider(db: D1Database, scenario: string): TelemetryProvider {
  return new SummarizingProvider(new D1TelemetryStore(db, scenario));
}
