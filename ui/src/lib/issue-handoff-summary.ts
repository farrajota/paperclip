import type {
  IssueExecutionPolicy,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
} from "@paperclipai/shared";

export type IssueHandoffSummary = {
  status: IssueExecutionState["status"] | null;
  currentActor: string | null;
  currentActorStatus: "known" | "none" | "idle" | "unknown";
  nextStage: "Review" | "Approval" | null;
  nextStageStatus: "configured" | "none" | "unknown";
  nextAudience: string[];
  returnDestination: string | null;
  reviewInstructions: string | null;
  reworkReasonStatus: "not_applicable" | "unknown";
  handoffRevision: number | null;
  /** No native association identifies which work-product revision a decision reviewed. */
  reviewedRevision: null;
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionState["lastDecisionOutcome"];
};

export function buildIssueHandoffSummary(input: {
  policy: IssueExecutionPolicy | null | undefined;
  state: IssueExecutionState | null | undefined;
  participantLabel: (principal: IssueExecutionStagePrincipal) => string;
  handoffRevision: number | null;
}): IssueHandoffSummary {
  const { policy, state } = input;
  const activeStageIndex = state?.currentStageId && policy
    ? policy.stages.findIndex((stage) => stage.id === state.currentStageId)
    : -1;
  const hasUnknownActiveStage = Boolean(state?.currentStageId) && activeStageIndex < 0;
  const hasMissingActiveStage =
    (state?.status === "pending" || state?.status === "changes_requested") &&
    !state.currentStageId;

  let nextStage: IssueExecutionPolicy["stages"][number] | null = null;
  let nextStageStatus: IssueHandoffSummary["nextStageStatus"];
  if (state?.status === "completed") {
    nextStageStatus = "none";
  } else if (!policy || hasUnknownActiveStage || hasMissingActiveStage) {
    nextStageStatus = "unknown";
  } else if (state?.status === "changes_requested") {
    nextStage = policy.stages[activeStageIndex] ?? null;
    nextStageStatus = nextStage ? "configured" : "none";
  } else {
    const firstNextIndex = activeStageIndex >= 0 ? activeStageIndex + 1 : 0;
    nextStage = policy.stages.find(
      (stage, index) => index >= firstNextIndex && !state?.completedStageIds?.includes(stage.id),
    ) ?? null;
    nextStageStatus = nextStage ? "configured" : "none";
  }

  const responsiblePrincipal = state?.status === "changes_requested"
    ? state.returnAssignee
    : state?.status === "pending"
      ? state.currentParticipant
      : null;
  const currentActorStatus = state?.status === "completed"
    ? "none"
    : state?.status === "idle"
      ? "idle"
      : responsiblePrincipal
        ? "known"
        : "unknown";
  const hasChangeRequest =
    state?.status === "changes_requested" ||
    state?.lastDecisionOutcome === "changes_requested";

  return {
    status: state?.status ?? null,
    currentActor: responsiblePrincipal ? input.participantLabel(responsiblePrincipal) : null,
    currentActorStatus,
    nextStage: nextStage?.type === "review" ? "Review" : nextStage?.type === "approval" ? "Approval" : null,
    nextStageStatus,
    nextAudience: nextStage?.participants.map(input.participantLabel) ?? [],
    returnDestination: state?.returnAssignee ? input.participantLabel(state.returnAssignee) : null,
    reviewInstructions: state?.status === "pending"
      ? state.reviewRequest?.instructions.trim() || null
      : null,
    reworkReasonStatus: hasChangeRequest ? "unknown" : "not_applicable",
    handoffRevision: input.handoffRevision,
    reviewedRevision: null,
    lastDecisionId: state?.lastDecisionId ?? null,
    lastDecisionOutcome: state?.lastDecisionOutcome ?? null,
  };
}
