import { floorMinute, MINUTE } from "../lib/time";
import type { ScenarioName, ServiceName } from "../telemetry/catalog";
import { BASELINES, DB_BASELINES, EFFECTIVE_REMEDIATION } from "../telemetry/scenarios";
import { multiInsert, runBatched } from "../telemetry/seed";
import { audit, type ActionRow } from "./repo";

export interface ExecutionResult {
  simulated: true;
  executedAt: number;
  summary: string;
}

const RECOVERY_MINUTES = 4 * 60;

async function previousVersion(db: D1Database, scenario: string, service: string): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT version FROM telemetry_deployments WHERE scenario = ? AND service = ? AND id NOT LIKE 'rb-%' ORDER BY ts DESC LIMIT 2")
    .bind(scenario, service)
    .all<{ version: string }>();
  return results[1]?.version ?? null;
}

async function applyRecovery(db: D1Database, scenario: ScenarioName, services: ServiceName[], database: string, from: number) {
  const statements: D1PreparedStatement[] = [];
  const noise = (base: number, spread: number) => base + (Math.random() * 2 - 1) * spread;
  const end = from + RECOVERY_MINUTES * MINUTE;

  for (const service of services) {
    for (const metric of ["error_rate", "p95_latency", "cpu"] as const) {
      statements.push(
        db.prepare("DELETE FROM telemetry_metrics WHERE scenario = ? AND service = ? AND metric = ? AND ts >= ?").bind(scenario, service, metric, from),
      );
      const base = BASELINES[service][metric];
      const spread = metric === "p95_latency" ? 10 : metric === "cpu" ? 3 : 0.05;
      const rows: unknown[][] = [];
      for (let ts = from; ts <= end; ts += MINUTE) rows.push([scenario, service, metric, ts, Math.max(0, Math.round(noise(base, spread) * 100) / 100)]);
      statements.push(...multiInsert(db, "INSERT INTO telemetry_metrics (scenario, service, metric, ts, value)", 5, rows));
    }
    statements.push(db.prepare("DELETE FROM telemetry_logs WHERE scenario = ? AND service = ? AND ts >= ? AND level IN ('WARN','ERROR')").bind(scenario, service, from));
  }

  const db0 = DB_BASELINES[database];
  if (db0) {
    statements.push(db.prepare("DELETE FROM telemetry_db_health WHERE scenario = ? AND database = ? AND ts >= ?").bind(scenario, database, from));
    const rows: unknown[][] = [];
    for (let ts = from; ts <= end; ts += MINUTE) {
      rows.push([scenario, database, ts, Math.round(noise(db0.active_connections, 4)), db0.max_connections, Math.max(0, Math.round(noise(db0.slow_queries, 1))), Math.round(noise(db0.replication_lag_ms, 8)), Math.round(noise(db0.cpu_pct, 3) * 10) / 10]);
    }
    statements.push(
      ...multiInsert(
        db,
        "INSERT INTO telemetry_db_health (scenario, database, ts, active_connections, max_connections, slow_queries, replication_lag_ms, cpu_pct)",
        8,
        rows,
      ),
    );
  }
  await runBatched(db, statements);
}

export async function executeAction(db: D1Database, action: ActionRow, scenario: ScenarioName, actor: string): Promise<ExecutionResult> {
  const current = await db.prepare("SELECT status, result_json FROM actions WHERE id = ?").bind(action.id).first<{ status: string; result_json: string | null }>();
  if (current?.status === "executed" && current.result_json) return JSON.parse(current.result_json) as ExecutionResult;
  if (current?.status !== "approved") throw new Error(`Action ${action.id} is ${current?.status ?? "missing"}, not approved`);

  const executedAt = Date.now();
  let summary: string;

  if (action.type === "rollback") {
    const prev = await previousVersion(db, scenario, action.target);
    summary = `Simulated rollback of ${action.target} to ${prev ?? "the previous version"} completed.`;
    await db
      .prepare("INSERT INTO telemetry_deployments (id, scenario, service, version, ts, author, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded') ON CONFLICT(id) DO NOTHING")
      .bind(`rb-${action.id}`, scenario, action.target, prev ?? "previous", executedAt, "incident-copilot", `rollback approved by ${action.decided_by ?? "unknown"}`)
      .run();
  } else if (action.type === "scale_up") {
    summary = `Simulated scale-up of ${action.target} (2x capacity) completed.`;
  } else {
    summary = `Simulated restart of ${action.target} completed.`;
  }

  const effective = EFFECTIVE_REMEDIATION[scenario];
  if (effective && effective.type === action.type && effective.target === action.target) {
    await applyRecovery(db, scenario, effective.affected, effective.database, floorMinute(executedAt));
  }

  const result: ExecutionResult = { simulated: true, executedAt, summary };
  await db
    .prepare("UPDATE actions SET status = 'executed', result_json = ? WHERE id = ? AND status = 'approved'")
    .bind(JSON.stringify(result), action.id)
    .run();
  await audit(db, { incidentId: action.incident_id, actor, event: "action_executed", detail: { actionId: action.id, type: action.type, target: action.target, summary }, dedupeKey: `exec:${action.id}` });
  return result;
}
