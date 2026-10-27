import { z } from "zod";

export const routineOccurrenceDispositionSchema = z.enum([
  "obligation",
  "satisfied",
  "skipped",
  "waived",
  "suppressed",
]);
export const routineOccurrenceExecutionStateSchema = z.enum([
  "pending",
  "dispatching",
  "waiting",
  "satisfied",
  "failed",
  "cancelled",
  "unknown",
  "skipped",
]);
export const routineOccurrenceDecisionSchema = z.object({
  disposition: routineOccurrenceDispositionSchema,
  executionState: routineOccurrenceExecutionStateSchema,
  decisionReason: z.string().nullable(),
}).superRefine((decision, context) => {
  if (decision.disposition === "satisfied" && (decision.executionState !== "satisfied" || !decision.decisionReason?.trim())) {
    context.addIssue({ code: "custom", path: ["executionState"], message: "Satisfied obligations require accepted completion evidence" });
  }
  if (["skipped", "waived", "suppressed"].includes(decision.disposition) && !decision.decisionReason?.trim()) {
    context.addIssue({ code: "custom", path: ["decisionReason"], message: "A disposition decision requires an explanation" });
  }
  if (["failed", "cancelled", "unknown", "skipped"].includes(decision.executionState) && !decision.decisionReason?.trim()) {
    context.addIssue({ code: "custom", path: ["decisionReason"], message: "A non-active execution outcome requires an explanation" });
  }
});

export type RoutineOccurrenceDisposition = z.infer<typeof routineOccurrenceDispositionSchema>;
export type RoutineOccurrenceExecutionState = z.infer<typeof routineOccurrenceExecutionStateSchema>;
export const ROUTINE_OCCURRENCE_CATCHUP_BATCH_LIMIT = 25;
export const ROUTINE_OCCURRENCE_CATCHUP_EXECUTION_LIMIT = 25;

export interface RoutineOccurrenceIdentityInput {
  companyId: string;
  routineId: string;
  triggerId: string;
  scheduledAt: Date;
}

export function routineOccurrenceIdentity(input: RoutineOccurrenceIdentityInput): string {
  return `${input.companyId}:${input.routineId}:${input.triggerId}:${input.scheduledAt.toISOString()}`;
}

export interface RoutineOccurrence {
  id: string;
  companyId: string;
  routineId: string;
  triggerId: string;
  scheduledAt: string;
  revisionId: string | null;
  revisionNumber: number;
  occurrenceKey: string;
  disposition: RoutineOccurrenceDisposition;
  executionState: RoutineOccurrenceExecutionState;
  decisionReason: string | null;
  ownerUserId: string | null;
  taskId: string | null;
  runId: string | null;
  approvedWorkflowDocumentId: string | null;
  approvedWorkflowRevisionId: string | null;
  milestoneId: string | null;
  milestoneRevisionId: string | null;
  caseId: string | null;
  caseHandoffVersion: number | null;
  retryAt: string | null;
  dispatchAttempts: number;
  acceptedAt: string | null;
  acceptedTaskStatusVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineOccurrenceAuditEvent {
  id: string;
  action: string;
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  reason: string | null;
  ownerUserId: string | null;
  createdAt: string;
}

export interface RoutineOccurrenceHistoryItem extends RoutineOccurrence {
  decisionHistory: RoutineOccurrenceAuditEvent[];
}

export interface RoutineOccurrencePage {
  items: RoutineOccurrenceHistoryItem[];
  nextCursor: string | null;
  canDecide: boolean;
  catchup: {
    batchLimit: number;
    hasMoreDue: boolean;
    nextScheduledAt: string | null;
    executionLimit: number;
    episodes: Array<{ triggerId: string; cutoff: string; revisionId: string; executionsConsumed: number; latestOnly: boolean }>;
  };
}

export const routineOccurrenceDispositionRequestSchema = z.object({
  disposition: z.enum(["skipped", "waived"]),
  reason: z.string().trim().min(1).max(2000),
  ownerUserId: z.string().uuid().nullable().optional(),
}).strict();
export type RoutineOccurrenceDispositionRequest = z.infer<typeof routineOccurrenceDispositionRequestSchema>;
