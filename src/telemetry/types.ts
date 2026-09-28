import type { DatabaseName, MetricName, ScenarioName, ServiceName } from "./catalog";

export interface LogRow {
  service: string;
  ts: number;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  trace_id?: string | null;
}

export interface MetricRow {
  service: string;
  metric: MetricName;
  ts: number;
  value: number;
}

export interface DeploymentRow {
  id: string;
  service: string;
  version: string;
  ts: number;
  author: string | null;
  message: string | null;
  status: string | null;
}

export interface DbHealthRow {
  database: string;
  ts: number;
  active_connections: number;
  max_connections: number;
  slow_queries: number;
  replication_lag_ms: number;
  cpu_pct: number;
}

export type GeneratedScenario = ScenarioName | "healthy";

export interface ScenarioData {
  scenario: GeneratedScenario;
  logs: LogRow[];
  metrics: MetricRow[];
  deployments: DeploymentRow[];
  dbHealth: DbHealthRow[];
}

export interface LogSignature {
  signature: string;
  level: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  sample: string;
}

export interface LogSummary {
  service: string;
  window: { start: number; end: number };
  total: number;
  byLevel: Record<string, number>;
  signatures: LogSignature[];
}

export interface MetricSummary {
  service: string;
  metric: MetricName;
  unit: string;
  window: { start: number; end: number };
  points: number;
  baseline: number | null;
  peak: number | null;
  current: number | null;
  deltaPct: number | null;
  onset: number | null;
  series: Array<[number, number]>;
}

export interface DeploymentSummary {
  id: string;
  service: string;
  version: string;
  ts: number;
  author: string | null;
  message: string | null;
  status: string | null;
}

export interface DbHealthSnapshot {
  active_connections: number;
  max_connections: number;
  slow_queries: number;
  replication_lag_ms: number;
  cpu_pct: number;
}

export interface DbHealthSummary {
  database: string;
  window: { start: number; end: number };
  points: number;
  baseline: DbHealthSnapshot | null;
  peak: DbHealthSnapshot | null;
  current: DbHealthSnapshot | null;
  onset: number | null;
  saturation: { connections: boolean; cpu: boolean };
}

export interface ServiceActivity {
  service: string;
  total: number;
  warn: number;
  error: number;
}

export interface LogQuery {
  service: ServiceName;
  start: number;
  end: number;
  level?: LogRow["level"];
  contains?: string;
  limit?: number;
}

export interface MetricQuery {
  service: ServiceName;
  metric: MetricName;
  start: number;
  end: number;
}

export interface DeploymentQuery {
  service?: ServiceName;
  since: number;
  until: number;
}

export interface DbHealthQuery {
  database: DatabaseName;
  start: number;
  end: number;
}

export interface TelemetryProvider {
  queryLogs(q: LogQuery): Promise<LogSummary>;
  getMetrics(q: MetricQuery): Promise<MetricSummary>;
  listDeployments(q: DeploymentQuery): Promise<DeploymentSummary[]>;
  getDbHealth(q: DbHealthQuery): Promise<DbHealthSummary>;
  serviceActivity(q: { start: number; end: number }): Promise<ServiceActivity[]>;
}

export interface TelemetryStore {
  logs(q: LogQuery): Promise<LogRow[]>;
  metrics(q: MetricQuery): Promise<MetricRow[]>;
  deployments(q: DeploymentQuery): Promise<DeploymentRow[]>;
  dbHealth(q: DbHealthQuery): Promise<DbHealthRow[]>;
  activity(q: { start: number; end: number }): Promise<ServiceActivity[]>;
}
