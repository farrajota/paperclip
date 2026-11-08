import { describe, expect, it } from "vitest";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { buildIssueHandoffSummary } from "./issue-handoff-summary";

const policy: IssueExecutionPolicy = {
  mode: "normal",
  commentRequired: true,
  stages: [
    {
      id: "review-stage",
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: "reviewer-member", type: "agent", agentId: "reviewer", userId: null }],
    },
    {
      id: "approval-stage",
      type: "approval",
      approvalsNeeded: 1,
      participants: [{ id: "approver-member", type: "user", userId: "owner", agentId: null }],
    },
  ],
};

function executionState(input: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...input,
  };
}

describe("buildIssueHandoffSummary", () => {
  it("shows active review instructions separately from the next configured stage", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({
        status: "pending",
        currentStageId: "review-stage",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "reviewer" },
        returnAssignee: { type: "agent", agentId: "developer" },
        reviewRequest: { instructions: "Check the updated error handling" },
      }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: 8,
    });

    expect(summary.currentActor).toBe("reviewer");
    expect(summary.nextStage).toBe("Approval");
    expect(summary.nextAudience).toEqual(["owner"]);
    expect(summary.reviewInstructions).toBe("Check the updated error handling");
    expect(summary.nextStageStatus).toBe("configured");
    expect(summary.reviewedRevision).toBeNull();
  });

  it("uses the native returned state and marks the unavailable decision reason unknown", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({
        status: "changes_requested",
        currentStageId: "review-stage",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "reviewer" },
        returnAssignee: { type: "agent", agentId: "developer" },
        reviewRequest: null,
        lastDecisionId: "decision-request-changes",
        lastDecisionOutcome: "changes_requested",
      }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: 9,
    });

    expect(summary.status).toBe("changes_requested");
    expect(summary.currentActor).toBe("developer");
    expect(summary.nextStage).toBe("Review");
    expect(summary.nextAudience).toEqual(["reviewer"]);
    expect(summary.reviewInstructions).toBeNull();
    expect(summary.reworkReasonStatus).toBe("unknown");
    expect(summary.lastDecisionId).toBe("decision-request-changes");
    expect(summary.lastDecisionOutcome).toBe("changes_requested");
    expect(summary.reviewedRevision).toBeNull();
    expect(summary.handoffRevision).toBe(9);
  });

  it("shows the next independent acceptance actor only after the review stage is complete", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({
        status: "pending",
        currentStageId: "approval-stage",
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "owner" },
        returnAssignee: { type: "agent", agentId: "developer" },
        completedStageIds: ["review-stage"],
        lastDecisionId: "decision-review-accepted",
        lastDecisionOutcome: "approved",
      }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: null,
    });

    expect(summary.currentActor).toBe("owner");
    expect(summary.nextStage).toBeNull();
    expect(summary.nextAudience).toEqual([]);
    expect(summary.nextStageStatus).toBe("none");
    expect(summary.reviewedRevision).toBeNull();
    expect(summary.handoffRevision).toBeNull();
    expect(summary.lastDecisionId).toBe("decision-review-accepted");
    expect(summary.status).toBe("pending");
  });

  it("keeps native idle distinct from completed while preserving the configured next audience", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({ status: "idle" }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: null,
    });

    expect(summary.status).toBe("idle");
    expect(summary.currentActor).toBeNull();
    expect(summary.currentActorStatus).toBe("idle");
    expect(summary.nextStage).toBe("Review");
    expect(summary.nextStageStatus).toBe("configured");
    expect(summary.nextAudience).toEqual(["reviewer"]);
    expect(summary.returnDestination).toBeNull();
    expect(summary.reviewedRevision).toBeNull();
    expect(summary.lastDecisionId).toBeNull();
    expect(summary.lastDecisionOutcome).toBeNull();
  });

  it("does not project a next actor or audience after native final acceptance", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: "developer" },
        reviewRequest: null,
        completedStageIds: ["review-stage", "approval-stage"],
        lastDecisionId: "decision-final-acceptance",
        lastDecisionOutcome: "approved",
      }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: 10,
    });

    expect(summary.status).toBe("completed");
    expect(summary.currentActor).toBeNull();
    expect(summary.currentActorStatus).toBe("none");
    expect(summary.nextStage).toBeNull();
    expect(summary.nextAudience).toEqual([]);
    expect(summary.nextStageStatus).toBe("none");
    expect(summary.lastDecisionId).toBe("decision-final-acceptance");
    expect(summary.lastDecisionOutcome).toBe("approved");
  });

  it("does not fall back to the first policy stage when native current-stage identity is unmatched", () => {
    const summary = buildIssueHandoffSummary({
      policy,
      state: executionState({
        status: "pending",
        currentStageId: "removed-stage",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "reviewer" },
      }),
      participantLabel: (principal) => principal.type === "agent" ? principal.agentId ?? "unknown agent" : principal.userId ?? "unknown user",
      handoffRevision: null,
    });

    expect(summary.nextStage).toBeNull();
    expect(summary.nextAudience).toEqual([]);
    expect(summary.nextStageStatus).toBe("unknown");
  });

  it("marks unavailable policy, actor, revision, and return facts unknown", () => {
    const summary = buildIssueHandoffSummary({
      policy: null,
      state: null,
      participantLabel: () => "unused",
      handoffRevision: null,
    });

    expect(summary.currentActor).toBeNull();
    expect(summary.currentActorStatus).toBe("unknown");
    expect(summary.nextStage).toBeNull();
    expect(summary.nextAudience).toEqual([]);
    expect(summary.nextStageStatus).toBe("unknown");
    expect(summary.returnDestination).toBeNull();
    expect(summary.reviewedRevision).toBeNull();
    expect(summary.handoffRevision).toBeNull();
    expect(summary.lastDecisionId).toBeNull();
  });
});

