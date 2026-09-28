import type { ScenarioName } from "../telemetry/catalog";

export interface InvestigationParams {
  incidentId: string;
  investigationId: string;
  service: string;
  symptom: string;
  description: string;
  scenario: ScenarioName;
  startTime?: string;
}

export interface ApprovalEventPayload {
  actionId: string;
  approved: boolean;
  decidedBy: string;
}

export const APPROVAL_EVENT = "approval";

export type WorkflowPhase =
  | "triage"
  | "evidence_collected"
  | "hypotheses_ranked"
  | "approval_required"
  | "approval_decided"
  | "action_executed"
  | "verified"
  | "completed"
  | "failed";

export interface WorkflowNotification {
  investigationId: string;
  phase: WorkflowPhase;
  detail?: Record<string, unknown>;
}
