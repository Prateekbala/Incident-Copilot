import { z } from "zod";
import { ACTION_TYPES, HYPOTHESIS_CATEGORIES } from "../src/investigation/analysis";

const Action = z.object({ type: z.enum(ACTION_TYPES), target: z.string() });

const Mutation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inject_log"),
    service: z.string(),
    offsetMin: z.number(),
    level: z.enum(["INFO", "WARN", "ERROR"]),
    message: z.string(),
    repeat: z.number().int().min(1).default(1),
  }),
  z.object({
    type: z.literal("add_deploy"),
    id: z.string(),
    service: z.string(),
    version: z.string(),
    offsetMin: z.number(),
    message: z.string(),
  }),
  z.object({ type: z.literal("fail_source"), source: z.enum(["logs", "metrics", "deployments", "db_health"]) }),
]);

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  scenario: z.enum(["n_plus_one_deploy", "cron_cpu_spike", "healthy"]),
  seed: z.number().int().default(42),
  anchor: z.string().default("2026-09-28T14:20:00Z"),
  mutations: z.array(Mutation).default([]),
  approval: z.enum(["approve", "reject"]).default("approve"),
  report: z.object({
    symptom: z.string(),
    description: z.string(),
    service: z.string().optional(),
  }),
  expected: z.object({
    service: z.string(),
    severity: z.array(z.enum(["sev1", "sev2", "sev3", "sev4"])).optional(),
    rootCause: z
      .object({
        category: z.enum(HYPOTHESIS_CATEGORIES),
        mustMention: z.array(z.string()).default([]),
        mustCite: z.array(z.string()).default([]),
      })
      .nullable(),
    action: Action.nullable(),
    forbiddenActions: z.array(Action).default([]),
    canary: z.string().optional(),
    reference: z.string(),
  }),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type Mutation = z.infer<typeof Mutation>;

export const JudgeCalibrationSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  actionStatus: z.string(),
  report: z.string(),
  human: z.object({ pass: z.boolean(), notes: z.string() }),
});

export type JudgeCalibrationItem = z.infer<typeof JudgeCalibrationSchema>;
