import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import type { Env } from "../env";
import type { GatherSource } from "../investigation/gather";
import { errorMessage } from "../lib/errors";
import { correlate, execute, gather, markFailed, propose, recordDecision, recordGap, recordPhase, report, triage, validate, verify } from "./steps";
import { APPROVAL_EVENT, type ApprovalEventPayload, type InvestigationParams, type WorkflowNotification, type WorkflowPhase } from "./types";

const RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "90 seconds",
};
const LLM_RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
  timeout: "120 seconds",
};

export class InvestigationWorkflow extends WorkflowEntrypoint<Env, InvestigationParams> {
  async run(event: WorkflowEvent<InvestigationParams>, step: WorkflowStep) {
    const p = event.payload;

    try {
      const plan = await step.do("triage", RETRY, () => triage(this.env, p));
      await this.notify(p, "triage", { service: plan.service, severity: plan.severity });

      const evidenceIds = (
        await Promise.all(
          plan.toolsToRun.map(async (source: GatherSource) => {
            try {
              return await step.do(`gather-${source}`, RETRY, () => gather(this.env, p, plan, source));
            } catch (err) {
              return await step.do(`gap-${source}`, () => recordGap(this.env, p, source, errorMessage(err)));
            }
          }),
        )
      ).flat();
      await step.do("evidence-collected", () => recordPhase(this.env, p.incidentId, p.investigationId, "evidence_collected", { count: evidenceIds.length }));
      await this.notify(p, "evidence_collected", { count: evidenceIds.length });

      await step.do("correlate", LLM_RETRY, () => correlate(this.env, p, plan));
      const ranked = await step.do("validate-hypotheses", () => validate(this.env, p, plan));
      await this.notify(p, "hypotheses_ranked", { top: ranked[0]?.title ?? null, confidence: ranked[0]?.confidence ?? null });

      const actionIds = await step.do("propose-actions", LLM_RETRY, () => propose(this.env, p));
      const actionId = actionIds[0];

      if (actionId) {
        await this.notify(p, "approval_required", { actionId });

        let approved: boolean | null = null;
        try {
          const evt = await step.waitForEvent<ApprovalEventPayload>("await-approval", { type: APPROVAL_EVENT, timeout: "30 minutes" });
          approved = evt.payload.actionId === actionId ? evt.payload.approved : null;
        } catch {
          approved = null;
        }

        const decision = await step.do("record-decision", () => recordDecision(this.env, p, actionId, approved));
        await this.notify(p, "approval_decided", { actionId, decision });

        if (decision === "approved") {
          const exec = await step.do("execute-action", { retries: { limit: 1, delay: "1 second" }, timeout: "60 seconds" }, () =>
            execute(this.env, p, actionId),
          );
          await this.notify(p, "action_executed", { actionId, summary: exec.summary });

          await step.sleep("wait-for-effect", (this.env.WAIT_FOR_EFFECT || "30 seconds") as WorkflowSleepDuration);

          const recovery = await step.do("verify-recovery", RETRY, () => verify(this.env, p, plan, exec.executedAt));
          await this.notify(p, "verified", { recovered: recovery.recovered });
        }
      }

      await step.do("finalize-report", LLM_RETRY, () => report(this.env, p));
      await this.notify(p, "completed");
    } catch (err) {
      await step.do("mark-failed", () => markFailed(this.env, p, errorMessage(err)));
      await this.notify(p, "failed", { error: errorMessage(err) });
      throw err;
    }
  }

  private async notify(p: InvestigationParams, phase: WorkflowPhase, detail?: Record<string, unknown>) {
    try {
      const stub = this.env.INCIDENT_AGENT.get(this.env.INCIDENT_AGENT.idFromName(p.incidentId));
      const evt: WorkflowNotification = { investigationId: p.investigationId, phase, detail };
      await stub.onWorkflowEvent(p.incidentId, evt);
    } catch (err) {
      console.warn(`[workflow] notify ${phase} failed: ${errorMessage(err)}`);
    }
  }
}
