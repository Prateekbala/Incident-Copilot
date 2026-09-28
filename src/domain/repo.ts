import type { Evidence, EvidenceRaw, RankedHypothesis } from "../investigation/analysis";
import { safeJsonParse } from "../lib/json";
import type { ScenarioName } from "../telemetry/catalog";

export interface IncidentRow {
  id: string;
  title: string;
  description: string;
  status: "open" | "investigating" | "mitigating" | "resolved";
  severity: string | null;
  service: string | null;
  scenario: ScenarioName;
  owner_id: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface InvestigationRow {
  id: string;
  incident_id: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  phase: string | null;
  plan_json: string | null;
  report_md: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface ActionRow {
  id: string;
  investigation_id: string;
  incident_id: string;
  source: "workflow" | "chat";
  type: string;
  target: string;
  rationale: string;
  status: "pending_approval" | "approved" | "rejected" | "executed" | "failed" | "timed_out";
  decided_by: string | null;
  decided_at: number | null;
  result_json: string | null;
  created_at: number;
}

interface EvidenceDbRow {
  id: string;
  source: Evidence["source"];
  summary: string;
  raw_json: string | null;
  is_gap: number;
  created_at: number;
}

interface HypothesisDbRow {
  id: string;
  title: string;
  explanation: string;
  category: RankedHypothesis["category"];
  confidence: number;
  evidence_ids: string;
  rank: number;
}

export async function createIncident(
  db: D1Database,
  i: { id: string; title: string; description: string; ownerId: string; scenario: ScenarioName; service: string | null },
) {
  const now = Date.now();
  await db
    .prepare("INSERT INTO incidents (id, title, description, status, service, scenario, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)")
    .bind(i.id, i.title, i.description, i.service, i.scenario, i.ownerId, now, now)
    .run();
}

export function getIncident(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
}

export async function listIncidents(db: D1Database, ownerId: string) {
  const { results } = await db
    .prepare("SELECT id, title, status, severity, service, scenario, created_at, updated_at FROM incidents WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(ownerId)
    .all();
  return results;
}

export async function updateIncident(
  db: D1Database,
  id: string,
  fields: Partial<Pick<IncidentRow, "status" | "severity" | "service" | "resolved_at" | "title">>,
) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE incidents SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), Date.now(), id)
    .run();
}

export async function audit(
  db: D1Database,
  e: { incidentId: string | null; actor: string; event: string; detail?: unknown; dedupeKey?: string },
) {
  await db
    .prepare("INSERT INTO audit_log (incident_id, actor, event, detail_json, dedupe_key, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING")
    .bind(e.incidentId, e.actor, e.event, e.detail === undefined ? null : JSON.stringify(e.detail), e.dedupeKey ?? null, Date.now())
    .run();
}

export function latestInvestigation(db: D1Database, incidentId: string) {
  return db.prepare("SELECT * FROM investigations WHERE incident_id = ? ORDER BY started_at DESC LIMIT 1").bind(incidentId).first<InvestigationRow>();
}

export function getInvestigation(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM investigations WHERE id = ?").bind(id).first<InvestigationRow>();
}

export async function updateInvestigation(db: D1Database, id: string, fields: Partial<Omit<InvestigationRow, "id" | "incident_id">>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  await db
    .prepare(`UPDATE investigations SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), id)
    .run();
}

export function rowToEvidence(r: EvidenceDbRow): Evidence & { createdAt: number } {
  return {
    id: r.id,
    source: r.source,
    summary: r.summary,
    raw: safeJsonParse<EvidenceRaw>(r.raw_json, { kind: "gap", data: { source: r.source, error: "unparseable" } }),
    isGap: r.is_gap === 1,
    createdAt: r.created_at,
  };
}

export async function listEvidence(db: D1Database, investigationId: string) {
  const { results } = await db
    .prepare("SELECT id, source, summary, raw_json, is_gap, created_at FROM evidence WHERE investigation_id = ? ORDER BY created_at, id")
    .bind(investigationId)
    .all<EvidenceDbRow>();
  return results.map(rowToEvidence);
}

export async function insertEvidence(db: D1Database, investigationId: string, incidentId: string, items: Evidence[]) {
  if (!items.length) return;
  const now = Date.now();
  await db.batch(
    items.map((e) =>
      db
        .prepare(
          "INSERT INTO evidence (id, investigation_id, incident_id, source, summary, raw_json, is_gap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(e.id, investigationId, incidentId, e.source, e.summary, JSON.stringify(e.raw), e.isGap ? 1 : 0, now),
    ),
  );
}

export async function listHypotheses(db: D1Database, investigationId: string): Promise<Array<RankedHypothesis & { id: string }>> {
  const { results } = await db
    .prepare("SELECT id, title, explanation, category, confidence, evidence_ids, rank FROM hypotheses WHERE investigation_id = ? ORDER BY rank")
    .bind(investigationId)
    .all<HypothesisDbRow>();
  return results.map((h) => ({ ...h, evidence_ids: safeJsonParse<string[]>(h.evidence_ids, []), adjustments: [] }));
}

export async function replaceHypotheses(db: D1Database, investigationId: string, hyps: RankedHypothesis[], idPrefix: string) {
  await db.batch([
    db.prepare("DELETE FROM hypotheses WHERE investigation_id = ?").bind(investigationId),
    ...hyps.map((h) =>
      db
        .prepare("INSERT INTO hypotheses (id, investigation_id, title, explanation, category, confidence, evidence_ids, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`${idPrefix}:${h.rank}`, investigationId, h.title, h.explanation, h.category, h.confidence, JSON.stringify(h.evidence_ids), h.rank),
    ),
  ]);
}

export function getAction(db: D1Database, incidentId: string, actionId: string) {
  return db.prepare("SELECT * FROM actions WHERE id = ? AND incident_id = ?").bind(actionId, incidentId).first<ActionRow>();
}

export async function listActions(db: D1Database, incidentId: string) {
  const { results } = await db.prepare("SELECT * FROM actions WHERE incident_id = ? ORDER BY created_at DESC").bind(incidentId).all<ActionRow>();
  return results;
}

export async function listTimeline(db: D1Database, incidentId: string) {
  const { results } = await db
    .prepare("SELECT id, actor, event, detail_json, ts FROM audit_log WHERE incident_id = ? ORDER BY ts DESC, id DESC LIMIT 100")
    .bind(incidentId)
    .all<{ id: number; actor: string; event: string; detail_json: string | null; ts: number }>();
  return results.reverse().map((r) => ({ id: r.id, actor: r.actor, event: r.event, detail: safeJsonParse(r.detail_json, null), ts: r.ts }));
}

export async function incidentSnapshot(db: D1Database, incident: IncidentRow) {
  const investigation = await latestInvestigation(db, incident.id);
  const [evidence, hypotheses, actions, timeline] = await Promise.all([
    investigation ? listEvidence(db, investigation.id) : Promise.resolve([]),
    investigation ? listHypotheses(db, investigation.id) : Promise.resolve([]),
    listActions(db, incident.id),
    listTimeline(db, incident.id),
  ]);
  return {
    incident,
    investigation: investigation ? { ...investigation, plan: safeJsonParse(investigation.plan_json, null), plan_json: undefined } : null,
    evidence,
    hypotheses,
    actions: actions.map((a) => ({ ...a, result: safeJsonParse(a.result_json, null), result_json: undefined })),
    timeline,
  };
}
