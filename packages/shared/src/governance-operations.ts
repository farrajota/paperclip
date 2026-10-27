import { z } from "zod";

const reasonText = z.string().trim().min(1).max(2000);
const expectedRevision = z.number().int().min(1);

export const governanceOperationExceptionAdmissionSchema = z.object({
  reason: reasonText,
  ownerUserId: z.string().trim().min(1).max(200),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();
export type GovernanceOperationExceptionAdmission = z.infer<typeof governanceOperationExceptionAdmissionSchema>;

export const governanceOperationExceptionPauseSchema = z.object({
  expectedRevision,
  reason: reasonText,
}).strict();
export type GovernanceOperationExceptionPause = z.infer<typeof governanceOperationExceptionPauseSchema>;

export const governanceOperationExceptionResumeSchema = z.object({ expectedRevision }).strict();
export type GovernanceOperationExceptionResume = z.infer<typeof governanceOperationExceptionResumeSchema>;

export const governanceOperationExceptionResolveSchema = z.object({
  expectedRevision,
  reason: reasonText,
}).strict();
export type GovernanceOperationExceptionResolve = z.infer<typeof governanceOperationExceptionResolveSchema>;

export type GovernanceOperationExceptionEvent = {
  id: string;
  kind: "received" | "admitted" | "paused" | "resumed" | "resolved" | "escalated" | "escalation_blocked";
  actorUserId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type GovernanceOperationException = {
  id: string;
  occurrenceId: string;
  taskIssueId: string | null;
  reason: string;
  ownerUserId: string;
  ownerName: string;
  receivedAt: string;
  admittedAt: string;
  receivedAgeSeconds: number;
  activeAgeSeconds: number;
  deadlineAt: string;
  clockPausedAt: string | null;
  pauseReason: string | null;
  lastResumedAt: string | null;
  state: "open" | "resolved";
  resolvedAt: string | null;
  resolutionNote: string | null;
  escalationGeneration: number;
  escalatedAt: string | null;
  escalationIssueId: string | null;
  escalationRetryAt: string | null;
  escalationBlockReason: string | null;
  revision: number;
  events: GovernanceOperationExceptionEvent[];
};

export type GovernanceOperationsIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  updatedAt: string;
  admissionState: "parked" | "queued" | "running" | "unknown";
  reasons: string[];
  ageSeconds: number;
  reviewParticipant: string | null;
};

export type GovernanceOperationsRun = {
  id: string;
  agentId: string;
  issueId: string | null;
  status: string;
  operationalState: "parked" | "queued" | "running" | "unknown" | "settled";
  reason: string;
  ageSeconds: number;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  providerIdentitySource: "receipt" | "unknown";
  heldCents: string | null;
  liveObservedCents: string | null;
  settledCents: string | null;
  unpriced: boolean;
  recoveryPhase: string | null;
  runtimeMode: "legacy" | "native";
  errorCode: string | null;
  startedAt: string | null;
  scheduledRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  costAccountingPending: boolean;
  costAccountedAt: string | null;
};

export type GovernanceOperationsRoutine = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  nextRunAt: string | null;
  timezone: string | null;
};

export type GovernanceOperationsCase = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  workIssueId: string | null;
  updatedAt: string;
};

export type GovernanceOperationsOccurrence = {
  id: string;
  routineId: string;
  scheduledAt: string;
  disposition: string;
  executionState: string;
  decisionReason: string | null;
  taskId: string | null;
  runId: string | null;
  caseId: string | null;
  ownerUserId: string | null;
  exception: GovernanceOperationException | null;
};

export type GovernanceOperationsDecisionQueue = {
  id: string;
  key: string;
  title: string;
  itemCount: number;
  items: Array<{ id: string; sourceKind: string; sourceId: string; createdAt: string }>;
};

export type GovernanceOperationsRecovery = {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  cause: string;
  status: string;
  updatedAt: string;
};

export type GovernanceOperationsMilestone = {
  id: string;
  caseId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  revision: number | null;
  revisionState: string | null;
  updatedAt: string;
};

export type GovernanceOperationsBudget = {
  id: string;
  scopeType: string;
  scopeName: string;
  metric: string;
  windowKind: string;
  amount: number;
  isActive: boolean;
  hardStopEnabled: boolean;
  enforcementPending: boolean;
  ledgerCents: string;
  liveObservedCents: string;
  effectiveHeldCents: string;
  pendingTerminalRunCount: number;
  unpricedEventCount: number;
  unknownBrowserRunCount: number;
};

export type GovernanceOperationsReadModel = {
  companyId: string;
  generatedAt: string;
  canManageExceptions: boolean;
  clockPolicy: string;
  truncation: { limitPerSource: number; sources: string[]; note: string };
  routines: GovernanceOperationsRoutine[];
  cases: GovernanceOperationsCase[];
  issues: GovernanceOperationsIssue[];
  runs: GovernanceOperationsRun[];
  occurrences: GovernanceOperationsOccurrence[];
  decisionQueues: GovernanceOperationsDecisionQueue[];
  recoveries: GovernanceOperationsRecovery[];
  milestones: GovernanceOperationsMilestone[];
  budgets: GovernanceOperationsBudget[];
  capacity: {
    visibleActiveRuns: number;
    perAgentActiveRuns: Array<{ agentId: string; agentName: string; activeRuns: number }>;
    guarantees: string[];
  };
  policyNotes: {
    ranking: string;
    exclusions: string[];
  };
  financialVisibility: string;
  ownerOptions: Array<{ id: string; name: string }>;
};
