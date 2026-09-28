import type { ScenarioName } from "./catalog";
import { generateScenario } from "./scenarios";

const MAX_PARAMS = 100;
const BATCH_STATEMENTS = 100;

export function multiInsert(db: D1Database, head: string, columns: number, rows: unknown[][], tail = ""): D1PreparedStatement[] {
  const perStatement = Math.floor(MAX_PARAMS / columns);
  const placeholders = `(${Array(columns).fill("?").join(",")})`;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    statements.push(db.prepare(`${head} VALUES ${chunk.map(() => placeholders).join(",")} ${tail}`).bind(...chunk.flat()));
  }
  return statements;
}

export async function runBatched(db: D1Database, statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    await db.batch(statements.slice(i, i + BATCH_STATEMENTS));
  }
}

export async function seedScenario(db: D1Database, scenario: ScenarioName, anchor = Date.now()) {
  const data = generateScenario(scenario, anchor);

  await db.batch([
    db.prepare("DELETE FROM telemetry_logs WHERE scenario = ?").bind(scenario),
    db.prepare("DELETE FROM telemetry_metrics WHERE scenario = ?").bind(scenario),
    db.prepare("DELETE FROM telemetry_deployments WHERE scenario = ?").bind(scenario),
    db.prepare("DELETE FROM telemetry_db_health WHERE scenario = ?").bind(scenario),
  ]);

  const statements = [
    ...multiInsert(
      db,
      "INSERT INTO telemetry_logs (scenario, service, ts, level, message, trace_id)",
      6,
      data.logs.map((r) => [scenario, r.service, r.ts, r.level, r.message, r.trace_id ?? null]),
    ),
    ...multiInsert(
      db,
      "INSERT INTO telemetry_metrics (scenario, service, metric, ts, value)",
      5,
      data.metrics.map((r) => [scenario, r.service, r.metric, r.ts, r.value]),
    ),
    ...multiInsert(
      db,
      "INSERT INTO telemetry_deployments (id, scenario, service, version, ts, author, message, status)",
      8,
      data.deployments.map((r) => [r.id, scenario, r.service, r.version, r.ts, r.author, r.message, r.status]),
    ),
    ...multiInsert(
      db,
      "INSERT INTO telemetry_db_health (scenario, database, ts, active_connections, max_connections, slow_queries, replication_lag_ms, cpu_pct)",
      8,
      data.dbHealth.map((r) => [scenario, r.database, r.ts, r.active_connections, r.max_connections, r.slow_queries, r.replication_lag_ms, r.cpu_pct]),
    ),
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_scenario', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(scenario),
    db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(`seeded_at:${scenario}`, String(anchor)),
  ];
  await runBatched(db, statements);

  return {
    scenario,
    anchor,
    counts: {
      logs: data.logs.length,
      metrics: data.metrics.length,
      deployments: data.deployments.length,
      dbHealth: data.dbHealth.length,
    },
  };
}

export async function activeScenario(db: D1Database): Promise<ScenarioName | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'active_scenario'").first<{ value: ScenarioName }>();
  return row?.value ?? null;
}
