import type { Env } from "../env";
import { ACTION_TYPES, type ActionType } from "../investigation/analysis";
import { ApiError, errorMessage } from "../lib/errors";
import { ulid } from "../lib/ids";
import { isDatabase, isService } from "../telemetry/catalog";
import { APPROVAL_EVENT, type ApprovalEventPayload } from "../workflow/types";
import { executeAction } from "./executor";
import {
  audit,
  getAction,
  getIncident,
  latestInvestigation,
  rowToEvidence,
  updateIncident,
  updateInvestigation,
  type ActionRow,
} from "./repo";

export async function startInvestigation(
  env: Env,
  args: { incidentId: string; service: string; symptom: string; startTime?: string; actor: string },
): Promise<{ investigationId: string; status: "started" | "already_running" }> {
  const incident = await getIncident(env.DB, args.incidentId);
  if (!incident) throw new ApiError("not_found", "Incident not found");

  const existing = await latestInvestigation(env.DB, args.incidentId);
  if (existing && (existing.status === "running" || existing.status === "awaiting_approval")) {
    return { investigationId: existing.id, status: "already_running" };
  }

  const investigationId = `inv-${ulid()}`;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO investigations (id, incident_id, status, phase, started_at) VALUES (?, ?, 'running', 'queued', ?)")
    .bind(investigationId, args.incidentId, now)
    .run();
  await updateIncident(env.DB, args.incidentId, { status: "investigating", service: args.service });

  try {
    await env.INVESTIGATION.create({
      id: investigationId,
      params: {
        incidentId: args.incidentId,
        investigationId,
        service: args.service,
        symptom: args.symptom,
        description: `${incident.title}\n${incident.description}`.trim(),
        scenario: incident.scenario,
        startTime: args.startTime,
      },
    });
  } catch (err) {
    await updateInvestigation(env.DB, investigationId, { status: "failed", phase: "failed", finished_at: Date.now() });
    await updateIncident(env.DB, args.incidentId, { status: "open" });
    throw new ApiError("internal", `Could not start investigation workflow: ${errorMessage(err)}`);
  }

  await audit(env.DB, {
    incidentId: args.incidentId,
    actor: args.actor,
    event: "investigation_started",
    detail: { investigationId, service: args.service, symptom: args.symptom },
  });
  return { investigationId, status: "started" };
}

export async function proposeChatAction(
  env: Env,
  args: { incidentId: string; type: ActionType; target: string; rationale: string },
): Promise<{ actionId: string; status: "pending_approval" } | { error: string; detail: string }> {
  if (!(ACTION_TYPES as readonly string[]).includes(args.type)) return { error: "invalid_action", detail: `type must be one of ${ACTION_TYPES.join(", ")}` };
  if (!isService(args.target) && !isDatabase(args.target)) return { error: "invalid_target", detail: `Unknown service or database "${args.target}"` };

  const investigation = await latestInvestigation(env.DB, args.incidentId);
  if (!investigation) return { error: "no_investigation", detail: "Start an investigation before proposing remediation." };

  const pending = await env.DB.prepare("SELECT id FROM actions WHERE incident_id = ? AND status = 'pending_approval' LIMIT 1")
    .bind(args.incidentId)
    .first<{ id: string }>();
  if (pending) return { error: "approval_pending", detail: `Action ${pending.id} is already awaiting approval.` };

  const actionId = `act-${ulid()}`;
  await env.DB.prepare(
    "INSERT INTO actions (id, investigation_id, incident_id, source, type, target, rationale, status, created_at) VALUES (?, ?, ?, 'chat', ?, ?, ?, 'pending_approval', ?)",
  )
    .bind(actionId, investigation.id, args.incidentId, args.type, args.target, args.rationale.slice(0, 600), Date.now())
    .run();
  await audit(env.DB, { incidentId: args.incidentId, actor: "agent", event: "action_proposed", detail: { actionId, type: args.type, target: args.target } });
  return { actionId, status: "pending_approval" };
}

export async function decideAction(
  env: Env,
  args: { incidentId: string; actionId: string; approved: boolean; userId: string },
): Promise<{ action: ActionRow; changed: boolean }> {
  const action = await getAction(env.DB, args.incidentId, args.actionId);
  if (!action) throw new ApiError("not_found", "Action not found");

  const newStatus = args.approved ? "approved" : "rejected";
  const res = await env.DB.prepare(
    "UPDATE actions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND incident_id = ? AND status = 'pending_approval'",
  )
    .bind(newStatus, args.userId, Date.now(), args.actionId, args.incidentId)
    .run();
  if (!res.meta.changes) return { action, changed: false };

  await audit(env.DB, { incidentId: args.incidentId, actor: args.userId, event: "approval", detail: { actionId: action.id, approved: args.approved } });

  if (action.source === "workflow") {
    const payload: ApprovalEventPayload = { actionId: action.id, approved: args.approved, decidedBy: args.userId };
    try {
      const instance = await env.INVESTIGATION.get(action.investigation_id);
      await instance.sendEvent({ type: APPROVAL_EVENT, payload });
    } catch (err) {
      await env.DB.prepare("UPDATE actions SET status = 'pending_approval', decided_by = NULL, decided_at = NULL WHERE id = ?").bind(action.id).run();
      throw new ApiError("internal", `Could not deliver approval to the workflow: ${errorMessage(err)}`);
    }
  } else if (args.approved) {
    const incident = await getIncident(env.DB, args.incidentId);
    if (incident) {
      const approved = { ...action, status: "approved" as const, decided_by: args.userId };
      try {
        await executeAction(env.DB, approved, incident.scenario, args.userId);
        await updateIncident(env.DB, args.incidentId, { status: "mitigating" });
      } catch (err) {
        await env.DB.prepare("UPDATE actions SET status = 'failed', result_json = ? WHERE id = ?").bind(JSON.stringify({ error: errorMessage(err) }), action.id).run();
      }
    }
  }

  const updated = (await getAction(env.DB, args.incidentId, args.actionId)) ?? action;
  return { action: updated, changed: true };
}

export async function getEvidence(db: D1Database, incidentId: string, evidenceId: string) {
  const row = await db
    .prepare("SELECT id, source, summary, raw_json, is_gap, created_at FROM evidence WHERE id = ? AND incident_id = ?")
    .bind(evidenceId, incidentId)
    .first<Parameters<typeof rowToEvidence>[0]>();
  return row ? rowToEvidence(row) : null;
}
