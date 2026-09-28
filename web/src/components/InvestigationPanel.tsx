import { useState } from "react";
import { fmtTime } from "../api";
import type { Action, Snapshot, TimelineEntry } from "../types";
import { Markdown } from "./Markdown";
import { StatusBadge } from "./StatusBadge";

type Tab = "overview" | "hypotheses" | "evidence" | "report";

interface Props {
  snapshot: Snapshot | null;
  onDecide(actionId: string, approved: boolean): Promise<void>;
}

export function InvestigationPanel({ snapshot, onDecide }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null);

  const showEvidence = (id: string) => {
    setFocusedEvidence(id);
    setTab("evidence");
  };

  return (
    <aside className="panel">
      <nav className="tabs">
        {(["overview", "hypotheses", "evidence", "report"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {!snapshot ? (
        <div className="card muted">No incident selected.</div>
      ) : tab === "overview" ? (
        <Overview snapshot={snapshot} onDecide={onDecide} />
      ) : tab === "hypotheses" ? (
        <Hypotheses snapshot={snapshot} onShowEvidence={showEvidence} />
      ) : tab === "evidence" ? (
        <EvidenceList snapshot={snapshot} focused={focusedEvidence} />
      ) : (
        <div className="card">
          {snapshot.investigation?.report_md ? <Markdown>{snapshot.investigation.report_md}</Markdown> : <span className="muted">The report appears when the investigation completes.</span>}
        </div>
      )}
    </aside>
  );
}

function Overview({ snapshot, onDecide }: { snapshot: Snapshot; onDecide: Props["onDecide"] }) {
  const { incident, investigation, hypotheses, actions, timeline } = snapshot;
  return (
    <div className="tab">
      <div className="card">
        <h3>Incident state</h3>
        <div className="kv">
          <div className="k">Status</div>
          <div>
            <StatusBadge status={incident.status} />
          </div>
          <div className="k">Severity</div>
          <div>{incident.severity ?? "—"}</div>
          <div className="k">Service</div>
          <div>{incident.service ?? "—"}</div>
          <div className="k">Investigation</div>
          <div>
            {investigation ? (
              <>
                <StatusBadge status={investigation.status} /> {investigation.phase}
              </>
            ) : (
              "—"
            )}
          </div>
          <div className="k">Top hypothesis</div>
          <div>{hypotheses[0] ? `${hypotheses[0].title} (${hypotheses[0].confidence})` : "—"}</div>
        </div>
      </div>

      {actions.map((a) => (
        <ActionCard key={a.id} action={a} onDecide={onDecide} />
      ))}

      <div className="card">
        <h3>Timeline</h3>
        <ol className="timeline">
          {timeline.map((t) => (
            <li key={t.id} className={t.event}>
              <span className="ts">{fmtTime(t.ts)}</span>
              {describeTimeline(t)}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ActionCard({ action: a, onDecide }: { action: Action; onDecide: Props["onDecide"] }) {
  const [busy, setBusy] = useState(false);
  const pending = a.status === "pending_approval";

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await onDecide(a.id, approved);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className={`card ${pending ? "approval" : ""}`}>
      <h3>{pending ? "Approval required" : "Remediation"}</h3>
      <div>
        <strong>{a.type}</strong> <code>{a.target}</code> <StatusBadge status={a.status} />
      </div>
      <div className="small">{a.rationale}</div>
      {a.result && <div className="small muted">{a.result.summary ?? a.result.error}</div>}
      {a.decided_by && (
        <div className="small muted">
          decided by {a.decided_by} at {fmtTime(a.decided_at)}
        </div>
      )}
      {pending && (
        <div className="buttons">
          <button disabled={busy} onClick={() => decide(true)}>
            Approve
          </button>
          <button disabled={busy} className="reject" onClick={() => decide(false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function describeTimeline(t: TimelineEntry) {
  const d = t.detail ?? {};
  switch (t.event) {
    case "phase":
      return (
        <>
          workflow → <strong>{d.phase}</strong>
          {d.count !== undefined && ` (${d.count} evidence)`}
          {d.decision && ` (${d.decision})`}
          {d.recovered !== undefined && ` (recovered: ${String(d.recovered)})`}
          {d.top?.title && `: ${d.top.title}`}
          {d.error && `: ${d.error}`}
        </>
      );
    case "tool_call":
      return (
        <>
          agent tool <code>{d.name}</code> {d.status}
        </>
      );
    case "approval":
      return `${t.actor} ${d.approved ? "approved" : "rejected"} action`;
    case "action_executed":
      return `executed: ${d.summary}`;
    case "action_proposed":
      return `agent proposed ${d.type} ${d.target}`;
    case "investigation_started":
      return `investigation started by ${t.actor} (${d.service})`;
    case "correlated":
      return `correlated via ${d.source} (${d.count} hypotheses)`;
    default:
      return `${t.event} by ${t.actor}`;
  }
}

function Hypotheses({ snapshot, onShowEvidence }: { snapshot: Snapshot; onShowEvidence(id: string): void }) {
  if (!snapshot.hypotheses.length) return <div className="card muted">No hypotheses yet. Start an investigation.</div>;
  return (
    <div className="tab">
      {snapshot.hypotheses.map((h) => (
        <div key={h.id} className="card hyp">
          <div>
            <strong>
              #{h.rank} {h.title}
            </strong>{" "}
            <span className="muted small">{h.category}</span>
          </div>
          <div className="conf">
            <span style={{ width: `${Math.round(h.confidence * 100)}%` }} />
          </div>
          <div className="small muted">confidence {h.confidence}</div>
          <div className="small">{h.explanation}</div>
          <div className="small evrefs">
            {h.evidence_ids.map((id) => (
              <code key={id} className="evref" onClick={() => onShowEvidence(id)}>
                {id}
              </code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EvidenceList({ snapshot, focused }: { snapshot: Snapshot; focused: string | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focused ? [focused] : []));
  if (!snapshot.evidence.length) return <div className="card muted">No evidence collected yet.</div>;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="tab">
      {snapshot.evidence.map((e) => (
        <div
          key={e.id}
          ref={(el) => {
            if (el && e.id === focused) el.scrollIntoView({ block: "center" });
          }}
          className={`card evidence-item ${e.isGap ? "gap" : ""} ${e.id === focused ? "focused" : ""}`}
          onClick={() => toggle(e.id)}
        >
          <div className="small">
            <code>{e.id}</code> <span className="muted">{e.source}</span>
          </div>
          <div className="small">{e.summary}</div>
          {expanded.has(e.id) && <pre>{JSON.stringify(e.raw, null, 2)}</pre>}
        </div>
      ))}
    </div>
  );
}
