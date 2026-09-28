CREATE TABLE incidents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  severity      TEXT,
  service       TEXT,
  scenario      TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_incidents_owner ON incidents(owner_id, created_at DESC);

CREATE TABLE investigations (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  status        TEXT NOT NULL,
  phase         TEXT,
  plan_json     TEXT,
  report_md     TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX idx_inv_incident ON investigations(incident_id, started_at DESC);

CREATE TABLE evidence (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  incident_id      TEXT NOT NULL,
  source           TEXT NOT NULL,
  summary          TEXT NOT NULL,
  raw_json         TEXT,
  is_gap           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_evidence_inv ON evidence(investigation_id);

CREATE TABLE hypotheses (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  title            TEXT NOT NULL,
  explanation      TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'other',
  confidence       REAL NOT NULL,
  evidence_ids     TEXT NOT NULL,
  rank             INTEGER NOT NULL
);
CREATE INDEX idx_hyp_inv ON hypotheses(investigation_id, rank);

CREATE TABLE actions (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  incident_id      TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'workflow',
  type             TEXT NOT NULL,
  target           TEXT NOT NULL,
  rationale        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_approval',
  decided_by       TEXT,
  decided_at       INTEGER,
  result_json      TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_actions_incident ON actions(incident_id, created_at DESC);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT,
  actor       TEXT NOT NULL,
  event       TEXT NOT NULL,
  detail_json TEXT,
  dedupe_key  TEXT UNIQUE,
  ts          INTEGER NOT NULL
);
CREATE INDEX idx_audit_incident ON audit_log(incident_id, ts);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE telemetry_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scenario TEXT NOT NULL, service TEXT NOT NULL,
  ts INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, trace_id TEXT
);
CREATE INDEX idx_tl ON telemetry_logs(scenario, service, ts);

CREATE TABLE telemetry_metrics (
  scenario TEXT NOT NULL, service TEXT NOT NULL, metric TEXT NOT NULL,
  ts INTEGER NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (scenario, service, metric, ts)
);

CREATE TABLE telemetry_deployments (
  id TEXT PRIMARY KEY, scenario TEXT NOT NULL, service TEXT NOT NULL,
  version TEXT NOT NULL, ts INTEGER NOT NULL, author TEXT, message TEXT, status TEXT
);
CREATE INDEX idx_td ON telemetry_deployments(scenario, ts);

CREATE TABLE telemetry_db_health (
  scenario TEXT NOT NULL, database TEXT NOT NULL, ts INTEGER NOT NULL,
  active_connections INTEGER, max_connections INTEGER,
  slow_queries INTEGER, replication_lag_ms INTEGER, cpu_pct REAL,
  PRIMARY KEY (scenario, database, ts)
);
