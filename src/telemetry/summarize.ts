import { redact } from "../lib/redact";
import { METRIC_UNITS, type MetricName } from "./catalog";
import type {
  DbHealthRow,
  DbHealthSnapshot,
  DbHealthSummary,
  LogQuery,
  LogRow,
  LogSignature,
  LogSummary,
  MetricQuery,
  MetricRow,
  MetricSummary,
} from "./types";

const LEVEL_RANK: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0 };
const SUSTAIN = 3;

export function logSignature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/"[^"]*"/g, '"<s>"')
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 200);
}

export function summarizeLogs(rows: LogRow[], q: LogQuery): LogSummary {
  const byLevel: Record<string, number> = {};
  const groups = new Map<string, LogSignature>();

  for (const row of rows) {
    byLevel[row.level] = (byLevel[row.level] ?? 0) + 1;
    const message = redact(row.message);
    const sig = `${row.level} ${logSignature(message)}`;
    const g = groups.get(sig);
    if (g) {
      g.count++;
      g.firstSeen = Math.min(g.firstSeen, row.ts);
      g.lastSeen = Math.max(g.lastSeen, row.ts);
    } else {
      groups.set(sig, {
        signature: logSignature(message),
        level: row.level,
        count: 1,
        firstSeen: row.ts,
        lastSeen: row.ts,
        sample: message.slice(0, 300),
      });
    }
  }

  const signatures = [...groups.values()]
    .sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0) || b.count - a.count)
    .slice(0, Math.min(q.limit ?? 8, 8));

  return { service: q.service, window: { start: q.start, end: q.end }, total: rows.length, byLevel, signatures };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

const MIN_ABS_DELTA: Record<MetricName, number> = { error_rate: 1, p95_latency: 100, rps: 50, cpu: 20 };

function isAnomalous(metric: MetricName, value: number, baseline: number): boolean {
  const delta = value - baseline;
  if (metric === "rps") return Math.abs(delta) >= Math.max(MIN_ABS_DELTA.rps, Math.abs(baseline) * 0.4);
  return delta >= Math.max(MIN_ABS_DELTA[metric], baseline * 0.8);
}

function sustainedOnset<T extends { ts: number }>(rows: T[], predicate: (r: T) => boolean): number | null {
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    run = predicate(rows[i]) ? run + 1 : 0;
    if (run === SUSTAIN) return rows[i - SUSTAIN + 1].ts;
  }
  return null;
}

function downsample(rows: MetricRow[], maxPoints = 24): Array<[number, number]> {
  if (rows.length <= maxPoints) return rows.map((r) => [r.ts, round(r.value)]);
  const bucket = rows.length / maxPoints;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < maxPoints; i++) {
    const slice = rows.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket));
    const avg = slice.reduce((s, r) => s + r.value, 0) / slice.length;
    out.push([slice[0].ts, round(avg)]);
  }
  return out;
}

export function summarizeMetric(rows: MetricRow[], q: MetricQuery): MetricSummary {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const base: MetricSummary = {
    service: q.service,
    metric: q.metric,
    unit: METRIC_UNITS[q.metric],
    window: { start: q.start, end: q.end },
    points: sorted.length,
    baseline: null,
    peak: null,
    current: null,
    deltaPct: null,
    onset: null,
    series: [],
  };
  if (!sorted.length) return base;

  const baselineCount = Math.max(5, Math.floor(sorted.length / 4));
  const baseline = median(sorted.slice(0, baselineCount).map((r) => r.value));
  const peak = Math.max(...sorted.map((r) => r.value));
  const current = sorted[sorted.length - 1].value;
  const onset = sustainedOnset(sorted.slice(Math.min(baselineCount, sorted.length - 1)), (r) =>
    isAnomalous(q.metric, r.value, baseline),
  );

  return {
    ...base,
    baseline: round(baseline),
    peak: round(peak),
    current: round(current),
    deltaPct: baseline > 0 ? round(((current - baseline) / baseline) * 100, 1) : null,
    onset,
    series: downsample(sorted),
  };
}

function snapshot(row: DbHealthRow): DbHealthSnapshot {
  return {
    active_connections: row.active_connections,
    max_connections: row.max_connections,
    slow_queries: row.slow_queries,
    replication_lag_ms: row.replication_lag_ms,
    cpu_pct: round(row.cpu_pct, 1),
  };
}

const connSaturated = (r: DbHealthRow) => r.max_connections > 0 && r.active_connections / r.max_connections >= 0.9;
const cpuSaturated = (r: DbHealthRow) => r.cpu_pct >= 85;

export function summarizeDbHealth(rows: DbHealthRow[], q: { database: string; start: number; end: number }): DbHealthSummary {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const summary: DbHealthSummary = {
    database: q.database,
    window: { start: q.start, end: q.end },
    points: sorted.length,
    baseline: null,
    peak: null,
    current: null,
    onset: null,
    saturation: { connections: false, cpu: false },
  };
  if (!sorted.length) return summary;

  const baselineRows = sorted.slice(0, Math.max(5, Math.floor(sorted.length / 4)));
  const avg = (pick: (r: DbHealthRow) => number) => baselineRows.reduce((s, r) => s + pick(r), 0) / baselineRows.length;

  summary.baseline = {
    active_connections: Math.round(avg((r) => r.active_connections)),
    max_connections: sorted[0].max_connections,
    slow_queries: Math.round(avg((r) => r.slow_queries)),
    replication_lag_ms: Math.round(avg((r) => r.replication_lag_ms)),
    cpu_pct: round(avg((r) => r.cpu_pct), 1),
  };
  summary.peak = {
    active_connections: Math.max(...sorted.map((r) => r.active_connections)),
    max_connections: Math.max(...sorted.map((r) => r.max_connections)),
    slow_queries: Math.max(...sorted.map((r) => r.slow_queries)),
    replication_lag_ms: Math.max(...sorted.map((r) => r.replication_lag_ms)),
    cpu_pct: round(Math.max(...sorted.map((r) => r.cpu_pct)), 1),
  };
  summary.current = snapshot(sorted[sorted.length - 1]);
  summary.onset = sustainedOnset(sorted, (r) => connSaturated(r) || cpuSaturated(r));
  summary.saturation = { connections: sorted.some(connSaturated), cpu: sorted.some(cpuSaturated) };
  return summary;
}
