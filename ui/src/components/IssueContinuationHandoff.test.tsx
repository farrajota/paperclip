// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueDocument, IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { IssueContinuationHandoff } from "./IssueContinuationHandoff";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const policy: IssueExecutionPolicy = {
  mode: "normal",
  commentRequired: true,
  stages: [
    { id: "review", type: "review", approvalsNeeded: 1, participants: [{ id: "r", type: "agent", agentId: "reviewer", userId: null }] },
    { id: "acceptance", type: "approval", approvalsNeeded: 1, participants: [{ id: "a", type: "user", userId: "approver", agentId: null }] },
  ],
};
const state: IssueExecutionState = {
  status: "changes_requested",
  currentStageId: "review",
  currentStageIndex: 0,
  currentStageType: "review",
  currentParticipant: { type: "agent", agentId: "reviewer" },
  returnAssignee: { type: "agent", agentId: "developer" },
  reviewRequest: null,
  completedStageIds: [],
  lastDecisionId: "decision-123",
  lastDecisionOutcome: "changes_requested",
};
const pendingReviewState: IssueExecutionState = {
  ...state,
  status: "pending",
  reviewRequest: { instructions: "Check the updated error handling" },
  lastDecisionId: null,
  lastDecisionOutcome: null,
};
const completedAcceptanceState: IssueExecutionState = {
  ...state,
  status: "completed",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  reviewRequest: null,
  completedStageIds: ["review", "acceptance"],
  lastDecisionId: "decision-final-acceptance",
  lastDecisionOutcome: "approved",
};
const handoffDocument = {
  id: "handoff-document",
  title: "Review return brief",
  body: "Implement the requested correction.",
  latestRevisionNumber: 9,
  updatedAt: new Date("2026-10-23T12:00:00.000Z"),
} as unknown as IssueDocument;

function renderHandoff(props: ComponentProps<typeof IssueContinuationHandoff>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<IssueContinuationHandoff {...props} />));
  return container;
}

describe("IssueContinuationHandoff", () => {
  it("renders active review instructions without calling them requested rework", () => {
    const view = renderHandoff({ document: handoffDocument, executionPolicy: policy, executionState: pendingReviewState });

    expect(view.textContent).toContain("Agent reviewer");
    expect(view.textContent).toContain("Next stage: Approval");
    expect(view.textContent).toContain("Review instructions: Check the updated error handling");
    expect(view.textContent).not.toContain("Requested rework");
    expect(view.textContent).not.toContain("Rework reason");
  });

  it("renders the native returned actor and durable decision while marking the unavailable reason unknown", () => {
    const view = renderHandoff({ document: handoffDocument, executionPolicy: policy, executionState: state });

    expect(view.textContent).toContain("Agent developer");
    expect(view.textContent).toContain("Next stage: Review");
    expect(view.textContent).toContain("Agent reviewer");
    expect(view.textContent).toContain("Rework reason: Unknown");
    expect(view.textContent).not.toContain("Requested rework");
    expect(view.textContent).toContain("decision-123");
    expect(view.textContent).toContain("Handoff document revision: 9");
    expect(view.textContent).toContain("Reviewed work-product revision: Unknown (not recorded)");
    expect(view.textContent).toContain("not evidence that a prior process stopped");
  });

  it("explains the absence of a workflow actor during idle without claiming completion", () => {
    const view = renderHandoff({
      document: undefined,
      executionPolicy: policy,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    expect(view.textContent).toContain("Execution status: idle");
    expect(view.textContent).toContain("Current responsible actor: None (workflow idle)");
    expect(view.textContent).not.toContain("execution completed");
    expect(view.textContent).toContain("Next stage: Review");
    expect(view.textContent).toContain("Next stage audience: Agent reviewer");
    expect(view.textContent).toContain("Return destination: Unknown");
    expect(view.textContent).toContain("Handoff document revision: Unknown");
    expect(view.textContent).toContain("Reviewed work-product revision: Unknown (not recorded)");
    expect(view.textContent).toContain("Last durable decision: Unknown");
    expect(view.textContent).toContain("an audience, not a confirmed dispatch");
  });

  it("shows terminal acceptance with no next stage or audience", () => {
    const view = renderHandoff({ document: handoffDocument, executionPolicy: policy, executionState: completedAcceptanceState });

    expect(view.textContent).toContain("Execution status: completed");
    expect(view.textContent).toContain("Current responsible actor: None (execution completed)");
    expect(view.textContent).toContain("Next stage: None");
    expect(view.textContent).toContain("Next stage audience: None");
    expect(view.textContent).toContain("decision-final-acceptance");
    expect(view.textContent).not.toContain("Next stage audience: Agent reviewer");
    expect(view.textContent).not.toContain("Next stage audience: User approver");
  });

  it("shows unknown handoff and execution facts rather than hiding or inventing them", () => {
    const view = renderHandoff({ document: null, executionPolicy: null, executionState: null });

    expect(view.textContent).toContain("Execution handoff context");
    expect(view.textContent).toContain("Handoff document: Unknown");
    expect(view.textContent).toContain("Current responsible actor: Unknown");
    expect(view.textContent).toContain("Reviewed work-product revision: Unknown (not recorded)");
    expect(view.textContent).toContain("Last durable decision: Unknown");
  });
});
