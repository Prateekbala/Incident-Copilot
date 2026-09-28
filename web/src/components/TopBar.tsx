import { useEffect, useState } from "react";
import { api, ApiRequestError } from "../api";
import { useToast } from "./Toast";

const SCENARIOS = [
  { id: "n_plus_one_deploy", label: "Scenario A: N+1 deploy" },
  { id: "cron_cpu_spike", label: "Scenario B: cron CPU spike" },
];

interface Props {
  token: string;
  onTokenChange(token: string): void;
}

export function TopBar({ token, onTokenChange }: Props) {
  const toast = useToast();
  const [draftToken, setDraftToken] = useState(token);
  const [scenario, setScenario] = useState(SCENARIOS[0].id);
  const [active, setActive] = useState<string>("loading…");
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    api<{ scenario: string | null }>(token, "/demo/scenario")
      .then((r) => {
        setActive(r.scenario ? `active: ${r.scenario}` : "no scenario seeded");
        if (r.scenario) setScenario(r.scenario);
      })
      .catch((err) => setActive(err instanceof ApiRequestError && err.status === 401 ? "invalid token" : "api unreachable"));
  }, [token]);

  const seed = async () => {
    setSeeding(true);
    try {
      const res = await api<{ scenario: string; counts: { metrics: number; logs: number } }>(token, "/demo/seed", {
        method: "POST",
        body: JSON.stringify({ scenario }),
      });
      setActive(`active: ${res.scenario}`);
      toast.info(`Seeded ${res.scenario}: ${res.counts.metrics} metric points, ${res.counts.logs} log lines`);
    } catch (err) {
      toast.error(`Seed failed: ${(err as Error).message}`);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        🚨 Incident Copilot <span className="muted">on Cloudflare</span>
      </div>
      <div className="controls">
        <label className="muted" htmlFor="token">
          Token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={draftToken}
          onChange={(e) => setDraftToken(e.target.value)}
          onBlur={() => draftToken.trim() !== token && onTokenChange(draftToken.trim())}
        />
        <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={seed} disabled={seeding}>
          {seeding ? "Seeding…" : "Seed scenario"}
        </button>
        <span className="badge">{active}</span>
      </div>
    </header>
  );
}
