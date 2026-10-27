import type { MilestoneContractInput, MilestoneDecisionInput, MilestoneEvidenceInput, MilestonePromoteInput, MilestoneReadiness } from "@paperclipai/shared/governance-milestones";
import { api } from "./client";

export interface MilestoneHistory {
  milestone: { id: string; caseId: string; issueId: string } | null;
  revisions: Array<{ id: string; revision: number; contract: MilestoneContractInput; state: string; createdAt: string; promotionProof: Record<string, unknown> | null }>;
  evidence: Array<{ id: string; revisionId: string; evidenceVersion: number; deliverableKey: string; evidenceKind: string; artifactId: string; artifactRevision: number | null; artifactHash: string | null; artifactSourceTrust: Record<string, unknown> | null; artifactProvenance: Record<string, unknown>; submittedByUserId: string | null; submittedByAgentId: string | null; createdAt: string }>;
  decisions: Array<{ id: string; revisionId: string; outcome: string; reason: string; evidenceVersion: number; evidenceSnapshotHash: string; reviewerUserId: string | null; reviewerAgentId: string | null; executorAgentId: string | null; executorUserId: string | null; createdAt: string }>;
  followups: Array<{ id: string; acceptedRevisionId: string; actionKey: string; issueId: string; createdAt: string }>;
  readiness?: MilestoneReadiness;
  permissions: { actorType: "board" | "agent" | "none"; canCreate: boolean; canAuthorContract: boolean; canPromote: boolean; canSubmitEvidence: boolean; canReview: boolean; canAccept: boolean };
}

export interface MilestoneDecisionResponse {
  event: { id: string; kind: string; acknowledgedAt: string | null };
  followups: Array<{ actionKey: string; issueId: string }>;
}

export const governanceMilestonesApi = {
  getForCase: (caseId: string) => api.get<MilestoneHistory>(`/cases/${caseId}/milestones`),
  createForCase: (caseId: string) => api.post<{ id: string; caseId: string; issueId: string }>(`/cases/${caseId}/milestones`, {}),
  createRevision: (milestoneId: string, input: MilestoneContractInput) => api.post(`/milestones/${milestoneId}/revisions`, input),
  promoteRevision: (milestoneId: string, revisionId: string, input: MilestonePromoteInput) => api.post(`/milestones/${milestoneId}/revisions/${revisionId}/promote`, input),
  addEvidence: (milestoneId: string, input: MilestoneEvidenceInput) => api.post(`/milestones/${milestoneId}/evidence`, input),
  decide: (milestoneId: string, revisionId: string, input: MilestoneDecisionInput) =>
    api.post<MilestoneDecisionResponse>(`/milestones/${milestoneId}/revisions/${revisionId}/decisions`, input),
  deliverFollowups: (milestoneId: string, eventId: string) =>
    api.post<Array<{ actionKey: string; issueId: string }>>(`/milestones/${milestoneId}/followups`, { eventId }),
};

