import { MINUTE, iso } from "../lib/time";
import { isDatabase, isService, type ServiceName } from "../telemetry/catalog";
import type { DbHealthSummary, DeploymentSummary, LogSummary, MetricSummary } from "../telemetry/types";

export type EvidenceSource = "logs" | "metrics" | "deployments" | "db_health" | "verification";
export const HYPOTHESIS_CATEGORIES = ["deploy", "database", "batch_job", "capacity", "dependency", "other"] as const;
export type HypothesisCategory = (typeof HYPOTHESIS_CATEGORIES)[number];
export const ACTION_TYPES = ["rollback", "scale_up", "restart"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type EvidenceRaw =
  | { kind: "logs"; data: LogSummary }
  | { kind: "metrics"; data: MetricSummary }
  | { kind: "deployment"; data: DeploymentSummary }
  | { kind: "db_health"; data: DbHealthSummary }
  | { kind: "gap"; data: { source: string; error: string } }
  | { kind: "verification"; data: RecoveryResult };

export interface Evidence {
  id: string;
  source: EvidenceSource;
  summary: string;
  raw: EvidenceRaw;
  isGap: boolean;
}

export interface HypothesisDraft {
  title: string;
  explanation: string;
  category: HypothesisCategory;
  confidence: number;
  evidence_ids: string[];
}

export interface RankedHypothesis extends HypothesisDraft {
  rank: number;
  adjustments: string[];
}

export interface ProposedAction {
  type: ActionType;
  target: string;
  rationale: string;
}

export interface InvestigationPlan {
  service: ServiceName;
  symptom: string;
  severity: "sev1" | "sev2" | "sev3" | "sev4";
  window: { start: number; end: number };
  toolsToRun: Array<"logs" | "metrics" | "deployments" | "db_health">;
  source: "llm" | "fallback";
}


export function describeLogs(s: LogSummary): string {
  const levels = Object.entries(s.byLevel)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const top = s.signatures
    .filter((sig) => sig.level === "ERROR" || sig.level === "WARN")
    .slice(0, 3)
    .map((sig) => `${sig.level} x${sig.count} since ${iso(sig.firstSeen)}: "${sig.sample.slice(0, 140)}"`)
    .join("; ");
  return `Logs ${s.service}: ${s.total} lines (${levels || "none"}). ${top ? `Top: ${top}` : "No warnings or errors."}`;
}

export function describeMetric(m: MetricSummary): string {
  if (!m.points) return `Metric ${m.service}.${m.metric}: no data in window.`;
  const onset = m.onset ? `anomaly onset ${iso(m.onset)}` : "no sustained anomaly";
  const delta = m.deltaPct === null ? "" : ` (${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}% vs baseline)`;
  return `Metric ${m.service}.${m.metric}: baseline ${m.baseline}${m.unit}, peak ${m.peak}${m.unit}, current ${m.current}${m.unit}${delta}; ${onset}.`;
}

export function describeDeployment(d: DeploymentSummary, onset: number | null): string {
  const rel =
    onset === null ? "" : d.ts <= onset ? ` — ${Math.round((onset - d.ts) / MINUTE)} min before incident onset` : ` — ${Math.round((d.ts - onset) / MINUTE)} min after incident onset`;
  return `Deploy ${d.service}@${d.version} at ${iso(d.ts)} by ${d.author ?? "unknown"} (${d.status ?? "unknown"}): "${d.message ?? ""}"${rel}.`;
}

export function describeDb(s: DbHealthSummary): string {
  if (!s.points || !s.baseline || !s.peak || !s.current) return `DB ${s.database}: no data in window.`;
  const flags = [s.saturation.connections && "CONNECTION POOL SATURATED", s.saturation.cpu && "CPU SATURATED"].filter(Boolean).join(", ");
  return (
    `DB ${s.database}: connections ${s.baseline.active_connections}→${s.peak.active_connections}/${s.peak.max_connections}, ` +
    `CPU ${s.baseline.cpu_pct}%→${s.peak.cpu_pct}%, slow queries ${s.baseline.slow_queries}→${s.peak.slow_queries}/min, ` +
    `replication lag ${s.baseline.replication_lag_ms}→${s.peak.replication_lag_ms}ms` +
    (s.onset ? `; saturation onset ${iso(s.onset)}` : "") +
    (flags ? ` [${flags}]` : "")
  );
}


export function incidentOnset(evidence: Evidence[], service: string): number | null {
  const onsets = evidence
    .filter((e): e is Evidence & { raw: { kind: "metrics"; data: MetricSummary } } => e.raw.kind === "metrics")
    .filter((e) => e.raw.data.service === service && (e.raw.data.metric === "error_rate" || e.raw.data.metric === "p95_latency"))
    .map((e) => e.raw.data.onset)
    .filter((t): t is number => t !== null);
  if (onsets.length) return Math.min(...onsets);

  const errorStarts = evidence
    .filter((e): e is Evidence & { raw: { kind: "logs"; data: LogSummary } } => e.raw.kind === "logs" && e.raw.data.service === service)
    .flatMap((e) => e.raw.data.signatures.filter((s) => s.level === "ERROR").map((s) => s.firstSeen));
  return errorStarts.length ? Math.min(...errorStarts) : null;
}

const byKind = <K extends EvidenceRaw["kind"]>(evidence: Evidence[], kind: K) =>
  evidence.filter((e) => !e.isGap && e.raw.kind === kind) as Array<Evidence & { raw: Extract<EvidenceRaw, { kind: K }> }>;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;


const DEPLOY_SUSPECT_MIN = 15;
const DEPLOY_UNLIKELY_MIN = 20;
const NO_ANOMALY_CAP = 0.3;

export function heuristicHypotheses(evidence: Evidence[], service: string): HypothesisDraft[] {
  const onset = incidentOnset(evidence, service);
  const metrics = byKind(evidence, "metrics").filter((e) => e.raw.data.service === service && e.raw.data.onset !== null);
  const metricIds = metrics.map((e) => e.id);
  const deploys = byKind(evidence, "deployment");
  const dbs = byKind(evidence, "db_health");
  const logs = byKind(evidence, "logs");
  const primaryLogs = logs.filter((e) => e.raw.data.service === service);
  const otherLogs = logs.filter((e) => e.raw.data.service !== service);

  const out: HypothesisDraft[] = [];
  const explainedDbs = new Set<string>();

  for (const dep of deploys) {
    const d = dep.raw.data;
    if (onset === null || d.ts > onset) continue;
    const gapMin = (onset - d.ts) / MINUTE;

    if (gapMin <= DEPLOY_SUSPECT_MIN) {
      let confidence = 0.55;
      const cites = [dep.id, ...metricIds];
      const why = [`${d.service}@${d.version} was deployed ${Math.round(gapMin)} min before the ${service} anomaly began.`];

      const saturatedDb = dbs.find((db) => db.raw.data.saturation.connections && (db.raw.data.onset ?? Infinity) >= d.ts);
      if (saturatedDb) {
        confidence += 0.2;
        cites.push(saturatedDb.id);
        explainedDbs.add(saturatedDb.id);
        why.push(`${saturatedDb.raw.data.database} connection pool saturated after the deploy.`);
      }
      const queryPattern = primaryLogs.find((l) => l.raw.data.signatures.some((s) => /n\+1|queries for|pool/i.test(s.sample)));
      if (queryPattern) {
        confidence += 0.1;
        cites.push(queryPattern.id);
        why.push("Logs show a per-request query fan-out / pool timeouts consistent with an N+1 query.");
      }
      out.push({
        title: `Deploy ${d.service}@${d.version} introduced a regression`,
        explanation: why.join(" "),
        category: "deploy",
        confidence,
        evidence_ids: cites,
      });
    } else if (d.service === service) {
      out.push({
        title: `Deploy ${d.service}@${d.version} (unlikely cause)`,
        explanation: `The deploy landed ${Math.round(gapMin)} min before onset and metrics stayed at baseline in between, so it is unlikely to be the trigger.`,
        category: "deploy",
        confidence: 0.15,
        evidence_ids: [dep.id],
      });
    }
  }

  for (const db of dbs) {
    const s = db.raw.data;
    if (explainedDbs.has(db.id)) continue;

    if (s.saturation.cpu) {
      const dbOnset = s.onset ?? onset ?? 0;
      const job = otherLogs.find((l) =>
        l.raw.data.signatures.some((sig) => sig.firstSeen >= dbOnset - 10 * MINUTE && sig.firstSeen <= dbOnset + 5 * MINUTE),
      );
      if (job) {
        const recentDeploy = deploys.some((d) => onset !== null && d.raw.data.ts <= onset && (onset - d.raw.data.ts) / MINUTE <= DEPLOY_SUSPECT_MIN);
        out.push({
          title: `${job.raw.data.service} job saturating ${s.database} CPU`,
          explanation: `${job.raw.data.service} started heavy work on ${s.database} right before CPU hit ${s.peak?.cpu_pct}% and ${service} latency rose; slow queries and replication lag climbed together.`,
          category: "batch_job",
          confidence: recentDeploy ? 0.65 : 0.8,
          evidence_ids: [db.id, job.id, ...metricIds],
        });
      } else {
        out.push({
          title: `${s.database} CPU saturation`,
          explanation: `${s.database} CPU peaked at ${s.peak?.cpu_pct}% around the incident onset; no single trigger was identified.`,
          category: "database",
          confidence: 0.45,
          evidence_ids: [db.id, ...metricIds],
        });
      }
    } else if (s.saturation.connections) {
      out.push({
        title: `${s.database} connection pool exhaustion`,
        explanation: `${s.database} ran at ${s.peak?.active_connections}/${s.peak?.max_connections} connections during the incident.`,
        category: "database",
        confidence: 0.4,
        evidence_ids: [db.id, ...metricIds],
      });
    }
  }

  if (!out.length) {
    out.push({
      title: "Cause unknown: insufficient evidence",
      explanation: "No deploy, database or batch-job signal lines up with the anomaly. Further manual investigation is needed.",
      category: "other",
      confidence: 0.1,
      evidence_ids: metricIds.length ? metricIds : evidence.filter((e) => !e.isGap).map((e) => e.id).slice(0, 1),
    });
  }
  return out;
}


export function validateHypotheses(drafts: HypothesisDraft[], evidence: Evidence[], service: string, maxKeep = 4): RankedHypothesis[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const onset = incidentOnset(evidence, service);
  const kept: RankedHypothesis[] = [];

  for (const draft of drafts) {
    const adjustments: string[] = [];
    const cited = [...new Set(draft.evidence_ids)].filter((id) => byId.has(id) && !byId.get(id)!.isGap);
    const dropped = draft.evidence_ids.length - cited.length;
    if (!cited.length) continue;
    if (dropped > 0) adjustments.push(`removed ${dropped} invalid citation(s)`);

    let confidence = clamp01(Number.isFinite(draft.confidence) ? draft.confidence : 0.3);
    const category = (HYPOTHESIS_CATEGORIES as readonly string[]).includes(draft.category) ? draft.category : "other";

    if (onset === null && confidence > NO_ANOMALY_CAP) {
      confidence = NO_ANOMALY_CAP;
      adjustments.push(`no anomaly detected in ${service} metrics or error logs (capped at ${NO_ANOMALY_CAP})`);
    }

    if (category === "deploy") {
      const dep = cited.map((id) => byId.get(id)!).find((e) => e.raw.kind === "deployment");
      if (!dep || dep.raw.kind !== "deployment") {
        confidence *= 0.5;
        adjustments.push("deploy hypothesis cites no deployment evidence (×0.5)");
      } else if (onset !== null) {
        const gapMin = (onset - dep.raw.data.ts) / MINUTE;
        if (gapMin < 0) {
          confidence = Math.min(confidence, 0.05);
          adjustments.push("deploy happened after onset (capped at 0.05)");
        } else if (gapMin > DEPLOY_UNLIKELY_MIN) {
          confidence *= 0.4;
          adjustments.push(`deploy precedes onset by ${Math.round(gapMin)} min (×0.4)`);
        } else if (gapMin <= DEPLOY_SUSPECT_MIN) {
          confidence = Math.min(0.95, confidence + 0.05);
          adjustments.push(`deploy within ${Math.round(gapMin)} min of onset (+0.05)`);
        }
      }
    }

    if (category === "batch_job" || category === "database") {
      const db = cited.map((id) => byId.get(id)!).find((e) => e.raw.kind === "db_health");
      if (db && db.raw.kind === "db_health") {
        const s = db.raw.data;
        if (!s.saturation.cpu && !s.saturation.connections) {
          confidence *= 0.5;
          adjustments.push("cited database shows no saturation (×0.5)");
        } else if (onset !== null && s.onset !== null && Math.abs(s.onset - onset) <= 10 * MINUTE) {
          confidence = Math.min(0.95, confidence + 0.05);
          adjustments.push("database saturation coincides with onset (+0.05)");
        }
      }
    }

    kept.push({ ...draft, category, evidence_ids: cited, confidence: round2(confidence), rank: 0, adjustments });
  }

  return kept
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxKeep)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}


const MIN_ACTION_CONFIDENCE = 0.5;

export function ruleBasedAction(hypotheses: RankedHypothesis[], evidence: Evidence[]): ProposedAction | null {
  const top = hypotheses[0];
  if (!top || top.confidence < MIN_ACTION_CONFIDENCE) return null;
  const cited = top.evidence_ids.map((id) => evidence.find((e) => e.id === id)).filter((e): e is Evidence => !!e);

  if (top.category === "deploy") {
    const dep = cited.find((e) => e.raw.kind === "deployment");
    if (dep?.raw.kind === "deployment") {
      return {
        type: "rollback",
        target: dep.raw.data.service,
        rationale: `Roll back ${dep.raw.data.service} from ${dep.raw.data.version} to the previous version: ${top.title} (confidence ${top.confidence}).`,
      };
    }
  }
  if (top.category === "batch_job" || top.category === "database") {
    const db = cited.find((e) => e.raw.kind === "db_health");
    if (db?.raw.kind === "db_health" && db.raw.data.saturation.cpu) {
      return {
        type: "scale_up",
        target: db.raw.data.database,
        rationale: `Scale up ${db.raw.data.database} to absorb the CPU saturation: ${top.title} (confidence ${top.confidence}).`,
      };
    }
  }
  return null;
}

export function vetAction(candidate: unknown, hypotheses: RankedHypothesis[], evidence: Evidence[]): ProposedAction | null {
  if (!candidate || typeof candidate !== "object") return null;
  const c = candidate as Record<string, unknown>;
  const type = c.type as ActionType;
  const target = c.target;
  const rationale = typeof c.rationale === "string" ? c.rationale.slice(0, 600) : "";
  const top = hypotheses[0];
  if (!top || top.confidence < MIN_ACTION_CONFIDENCE) return null;
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return null;
  if (!isService(target) && !isDatabase(target)) return null;

  const supported = hypotheses.filter((h) => h.confidence >= MIN_ACTION_CONFIDENCE).flatMap((h) => h.evidence_ids);
  const supportedEvidence = evidence.filter((e) => supported.includes(e.id));
  if (type === "rollback") {
    const hasDeploy = supportedEvidence.some((e) => e.raw.kind === "deployment" && e.raw.data.service === target);
    if (!hasDeploy) return null;
  }
  if (type === "scale_up" && isDatabase(target)) {
    const hasDb = supportedEvidence.some((e) => e.raw.kind === "db_health" && e.raw.data.database === target);
    if (!hasDb) return null;
  }
  return { type, target: target as string, rationale: rationale || `${type} ${target} based on: ${top.title}` };
}


export interface RecoveryCheck {
  metric: string;
  baseline: number | null;
  incidentPeak: number | null;
  after: number | null;
  recovered: boolean;
}

export interface RecoveryResult {
  service: string;
  recovered: boolean;
  checks: RecoveryCheck[];
  note?: string;
}

const RECOVERY_TOLERANCE: Record<string, number> = { error_rate: 1, p95_latency: 80 };

export function evaluateRecovery(service: string, pairs: Array<{ metric: string; before: MetricSummary; afterValues: number[] }>): RecoveryResult {
  const checks: RecoveryCheck[] = pairs.map(({ metric, before, afterValues }) => {
    const after = afterValues.length ? afterValues.reduce((a, b) => a + b, 0) / afterValues.length : null;
    const baseline = before.baseline;
    const recovered =
      after !== null && baseline !== null && after <= baseline * 1.5 + (RECOVERY_TOLERANCE[metric] ?? 0);
    return { metric, baseline, incidentPeak: before.peak, after: after === null ? null : round2(after), recovered };
  });
  const recovered = checks.length > 0 && checks.every((c) => c.recovered);
  return {
    service,
    recovered,
    checks,
    note: checks.some((c) => c.after === null) ? "No post-remediation datapoints yet" : undefined,
  };
}


export interface ReportInput {
  incidentTitle: string;
  plan: InvestigationPlan | null;
  evidence: Evidence[];
  hypotheses: RankedHypothesis[];
  action: { type: string; target: string; status: string; rationale: string } | null;
  recovery: RecoveryResult | null;
}

export function templateReport(r: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# Incident report: ${r.incidentTitle}`, "");
  if (r.plan) {
    lines.push(`**Service:** ${r.plan.service}  `, `**Severity:** ${r.plan.severity}  `, `**Symptom:** ${r.plan.symptom}`, "");
  }
  lines.push("## Ranked hypotheses", "");
  if (!r.hypotheses.length) lines.push("No hypothesis was supported by the collected evidence.");
  for (const h of r.hypotheses) {
    lines.push(`${h.rank}. **${h.title}** (confidence ${h.confidence}, ${h.category})`, `   ${h.explanation}`, `   Evidence: ${h.evidence_ids.map((id) => `\`${id}\``).join(", ")}`);
  }
  lines.push("", "## Evidence", "");
  for (const e of r.evidence) lines.push(`- \`${e.id}\` ${e.isGap ? "⚠️ GAP: " : ""}${e.summary}`);
  lines.push("", "## Remediation", "");
  if (!r.action) lines.push("No remediation was proposed (confidence too low or no safe action applies).");
  else lines.push(`- ${r.action.type} \`${r.action.target}\` — status **${r.action.status}**`, `- Rationale: ${r.action.rationale}`);
  if (r.recovery) {
    lines.push("", "## Verification", "", `Recovered: **${r.recovery.recovered ? "yes" : "no"}**`);
    for (const c of r.recovery.checks) lines.push(`- ${c.metric}: baseline ${c.baseline}, peak ${c.incidentPeak}, after ${c.after ?? "n/a"} → ${c.recovered ? "OK" : "NOT RECOVERED"}`);
  }
  const gaps = r.evidence.filter((e) => e.isGap);
  if (gaps.length) {
    lines.push("", "## Could not check", "");
    for (const g of gaps) lines.push(`- ${g.summary}`);
  }
  lines.push("", "_Generated from a deterministic template because the AI model was unavailable._");
  return lines.join("\n");
}
