export type IncidentStatus = "open" | "investigating" | "mitigating" | "resolved";
export type ActionStatus = "pending_approval" | "approved" | "rejected" | "executed" | "failed" | "timed_out";

export interface IncidentSummary {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: string | null;
  service: string | null;
  scenario: string;
  created_at: number;
  updated_at: number;
}

export interface Incident extends IncidentSummary {
  description: string;
  owner_id: string;
  resolved_at: number | null;
}

export interface Investigation {
  id: string;
  incident_id: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  phase: string | null;
  plan: { service: string; severity: string; symptom: string; source: string } | null;
  report_md: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface Evidence {
  id: string;
  source: string;
  summary: string;
  raw: unknown;
  isGap: boolean;
  createdAt: number;
}

export interface Hypothesis {
  id: string;
  rank: number;
  title: string;
  explanation: string;
  category: string;
  confidence: number;
  evidence_ids: string[];
}

export interface Action {
  id: string;
  investigation_id: string;
  source: "workflow" | "chat";
  type: string;
  target: string;
  rationale: string;
  status: ActionStatus;
  decided_by: string | null;
  decided_at: number | null;
  result: { summary?: string; error?: string } | null;
  created_at: number;
}

export interface TimelineEntry {
  id: number;
  actor: string;
  event: string;
  detail: Record<string, any> | null;
  ts: number;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
  created_at: number;
}

export interface Snapshot {
  incident: Incident;
  investigation: Investigation | null;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  actions: Action[];
  timeline: TimelineEntry[];
  messages: StoredMessage[];
}

export type ToolStatus = "running" | "ok" | "error";

export type ServerEvent =
  | { type: "history"; messages: StoredMessage[] }
  | { type: "user_message"; message: StoredMessage }
  | { type: "assistant_message"; message: StoredMessage }
  | { type: "assistant_delta"; messageId: number; text: string }
  | { type: "assistant_done"; messageId: number; message: StoredMessage | null }
  | { type: "tool_call"; id: string; name: string; args: unknown; status: ToolStatus; result?: unknown }
  | { type: "investigation_progress"; phase: string; detail: Record<string, unknown> }
  | { type: "approval_request"; action: Action }
  | { type: "state_update"; state: unknown }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "pong" };
