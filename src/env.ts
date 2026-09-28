import type { IncidentAgent } from "./agent/incident-agent";
import type { InvestigationParams } from "./workflow/types";

export interface Env {
  AI: Ai;
  DB: D1Database;
  ASSETS: Fetcher;
  INCIDENT_AGENT: DurableObjectNamespace<IncidentAgent>;
  INVESTIGATION: Workflow<InvestigationParams>;
  RATE_LIMITER?: RateLimit;

  API_TOKENS?: string;
  AI_GATEWAY_ID?: string;
  PRIMARY_MODEL?: string;
  FALLBACK_MODEL?: string;
  WAIT_FOR_EFFECT?: string;
}
