import { useState, type FormEvent } from "react";
import { fmtTime } from "../api";
import type { IncidentSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  incidents: IncidentSummary[];
  selectedId: string | null;
  onSelect(id: string): void;
  onCreate(description: string): Promise<void>;
}

export function Sidebar({ incidents, selectedId, onSelect, onCreate }: Props) {
  const [description, setDescription] = useState("Checkout is throwing 500s and latency is way up since about 20 minutes ago.");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setBusy(true);
    try {
      await onCreate(description.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar">
      <form className="card" onSubmit={submit}>
        <h3>New incident</h3>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what's broken…" />
        <button type="submit" disabled={busy}>
          {busy ? "Opening…" : "Open incident"}
        </button>
      </form>
      <div className="card grow">
        <h3>Incidents</h3>
        <ul className="incident-list">
          {incidents.length === 0 && <li className="muted">No incidents yet</li>}
          {incidents.map((i) => (
            <li key={i.id} className={i.id === selectedId ? "active" : ""} onClick={() => onSelect(i.id)}>
              <div className="t">{i.title}</div>
              <div className="small muted">
                <StatusBadge status={i.status} /> {i.severity ?? ""} · {i.scenario} · {fmtTime(i.created_at)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
