import { z } from "zod";

export const milestoneEvidenceKinds = ["document_revision", "work_product", "issue_completion"] as const;
export type MilestoneEvidenceKind = (typeof milestoneEvidenceKinds)[number];

export const milestoneArtifactReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("document"), documentId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("work_product"),
    workProductId: z.string().uuid(),
    issueId: z.string().uuid(),
    productType: z.enum(["preview_url", "runtime_service", "pull_request", "branch", "commit", "artifact", "document"]),
    provider: z.string().min(1).max(100),
  }).strict(),
]);

export type MilestoneArtifactReference = z.infer<typeof milestoneArtifactReferenceSchema>;

export const milestoneDeliverableSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(300),
  evidenceKind: z.enum(milestoneEvidenceKinds),
  reference: milestoneArtifactReferenceSchema,
  maxAgeHours: z.number().int().positive().max(24 * 365).nullable().default(null),
}).strict().superRefine((value, context) => {
  const matches = (value.evidenceKind === "issue_completion" && value.reference.kind === "task")
    || (value.evidenceKind === "document_revision" && value.reference.kind === "document")
    || (value.evidenceKind === "work_product" && value.reference.kind === "work_product");
  if (!matches) context.addIssue({ code: "custom", path: ["reference"], message: "Evidence kind and resource reference must match" });
});

const executorPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any_internal_agent") }).strict(),
  z.object({ kind: z.literal("assigned_agent"), agentId: z.string().uuid() }).strict(),
]);

const reviewerPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("board_user") }).strict(),
  z.object({ kind: z.literal("independent_internal_agent"), agentId: z.string().uuid() }).strict(),
]);

const milestoneFollowupSchema = z.object({
  actionKey: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
}).strict();

export const milestoneContractInputSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  playbookBinding: z.object({ documentId: z.string().uuid(), documentRevisionId: z.string().uuid() }).strict(),
  requiredDeliverables: z.array(milestoneDeliverableSchema).min(1).max(50),
  executorPolicy: executorPolicySchema,
  reviewerPolicy: reviewerPolicySchema,
  followups: z.array(milestoneFollowupSchema).max(20).default([]),
}).strict().superRefine((value, context) => {
  const keys = value.requiredDeliverables.map((item) => item.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["requiredDeliverables"], message: "Deliverable keys must be unique" });
  const references = value.requiredDeliverables.map((item) => JSON.stringify(item.reference));
  if (new Set(references).size !== references.length) context.addIssue({ code: "custom", path: ["requiredDeliverables"], message: "A resource reference cannot satisfy multiple deliverables" });
  const actionKeys = value.followups.map((item) => item.actionKey);
  if (new Set(actionKeys).size !== actionKeys.length) context.addIssue({ code: "custom", path: ["followups"], message: "Follow-up action keys must be unique" });
});

export const milestonePromoteInputSchema = z.object({
  expectedActiveRevisionId: z.string().uuid().nullable(),
}).strict();

export const milestoneEvidenceInputSchema = z.object({
  deliverableKey: z.string().min(1).max(100),
  evidenceKind: z.enum(milestoneEvidenceKinds),
  artifactId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  expectedEvidenceVersion: z.number().int().nonnegative(),
}).strict();

export const milestoneDecisionInputSchema = z.object({
  outcome: z.enum(["accept", "reject", "revoke"]),
  reason: z.string().min(1).max(5000),
  expectedRevision: z.number().int().positive(),
  expectedEvidenceVersion: z.number().int().nonnegative(),
  expectedEvidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const milestoneFollowupDeliveryInputSchema = z.object({ eventId: z.string().uuid() }).strict();

export interface MilestoneExecutor {
  agentId?: string;
  taskId?: string;
}

export type MilestoneReadinessState = "blocked" | "eligible_for_review" | "accepted_current" | "accepted_stale";
export type MilestoneReadinessReason =
  | "ready"
  | "no_active_contract"
  | "missing_evidence"
  | "stale_evidence"
  | "incomplete_task"
  | "executor_not_allowed"
  | "reviewer_not_allowed"
  | "unverified_evidence"
  | "playbook_stale";

export interface MilestoneReadiness {
  eligible: boolean;
  accepted: boolean;
  executionAllowed: boolean;
  state: MilestoneReadinessState;
  reason: MilestoneReadinessReason;
  milestoneId: string;
  revisionId: string | null;
  contractRevision: number | null;
  evidenceVersion: number;
  evidenceSnapshotHash: string;
  checkedAt: string;
}

export interface MilestoneSummary {
  id: string;
  caseId: string;
  issueId: string;
  title: string;
  currentRevision: number | null;
  status: "draft" | "active" | "accepted" | "rejected" | "revoked" | "stale";
  history: Array<{ revision: number; title: string; state: string; createdAt: string }>;
}

export type MilestoneContractInput = z.input<typeof milestoneContractInputSchema>;
export type MilestonePromoteInput = z.infer<typeof milestonePromoteInputSchema>;
export type MilestoneEvidenceInput = z.infer<typeof milestoneEvidenceInputSchema>;
export type MilestoneDecisionInput = z.infer<typeof milestoneDecisionInputSchema>;
