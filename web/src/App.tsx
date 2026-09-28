import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chat } from "./components/Chat";
import { InvestigationPanel } from "./components/InvestigationPanel";
import { Sidebar } from "./components/Sidebar";
import { useToast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { useIncident } from "./hooks/useIncident";
import type { IncidentSummary } from "./types";

const ULID = /^[0-9A-Z]{26}$/;

export function App() {
  const toast = useToast();
  const [token, setToken] = useState(() => localStorage.getItem("token") || "dev-token");
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => (ULID.test(location.hash.slice(1)) ? location.hash.slice(1) : null));
  const incident = useIncident(selectedId, token);

  const loadIncidents = useCallback(async () => {
    try {
      const res = await api<{ incidents: IncidentSummary[] }>(token, "/incidents");
      setIncidents(res.incidents);
    } catch {
      setIncidents([]);
    }
  }, [token]);

  useEffect(() => {
    void loadIncidents();
  }, [loadIncidents]);

  const status = incident.snapshot?.incident.status;
  useEffect(() => {
    if (status) void loadIncidents();
  }, [status, loadIncidents]);

  const select = (id: string) => {
    setSelectedId(id);
    history.replaceState(null, "", `#${id}`);
  };

  const create = async (description: string) => {
    try {
      const { id } = await api<{ id: string }>(token, "/incidents", { method: "POST", body: JSON.stringify({ description }) });
      await loadIncidents();
      select(id);
      await api(token, `/incidents/${id}/messages`, { method: "POST", body: JSON.stringify({ text: description }) });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const changeToken = (t: string) => {
    localStorage.setItem("token", t);
    setToken(t);
  };

  return (
    <>
      <TopBar token={token} onTokenChange={changeToken} />
      <main className="layout">
        <Sidebar incidents={incidents} selectedId={selectedId} onSelect={select} onCreate={create} />
        <Chat
          token={token}
          incidentId={selectedId}
          snapshot={incident.snapshot}
          items={incident.items}
          connected={incident.connected}
          onSend={incident.send}
          onStartInvestigation={incident.startInvestigation}
        />
        <InvestigationPanel snapshot={incident.snapshot} onDecide={incident.decide} />
      </main>
    </>
  );
}
