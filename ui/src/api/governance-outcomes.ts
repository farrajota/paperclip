import type { CreateOutcomeCheckin, CreateOutcomeTarget, OutcomeCapabilities, OutcomeObservationInput } from "@paperclipai/shared/governance-outcomes";
import { api } from "./client";

export type GoalOutcomeRead = {
  capabilities: OutcomeCapabilities;
  periods: Array<{ id: string; label: string; timezone: string; intervalStart: string; intervalEnd: string; lifecycle: "draft" | "active" | "closed" }>;
  targets: Array<{
    id: string; periodId: string; metricKey: string; revision: number; kind: "number" | "percentage" | "currency" | "duration" | "count";
    unit: string; direction: "increase" | "decrease" | "range"; aggregation: "latest" | "sum"; population: string; source: string;
    queryVersion: string; freshnessHours: number; maturityHours: number; baselineValue: number | null; targetValue: number | null;
    rangeMin: number | null; rangeMax: number | null; ownerAgentId: string | null;
    guardrails: Array<{ name: string; direction: "min" | "max"; threshold: number }>;
    trajectory: Array<{ at: string; value: number }>; approvedBy: string; createdAt: string;
  }>;
  observations: Array<{
    id: string; targetId: string; source: string; sourceRevision: string; sourceKey: string; value: number; unit: string; population: string;
    windowStart: string; windowEnd: string; observedAt: string; availableAt: string; ingestedAt: string; valid: boolean | string;
    submittedBy: string; submitterType: "agent" | "user"; submitterSource: string; submitterKeyId: string | null; runId: string | null;
    guardrailValues: Record<string, number>; supersedesId: string | null; correctionReason: string | null;
  }>;
  checkins: Array<{
    id: string; targetId: string; health: "on_track" | "at_risk" | "off_track" | "unknown"; evidence: string;
    forecastValue: number | null; uncertainty: string; correctiveIssueId: string | null; nextReviewAt: string; createdBy: string; createdAt: string;
  }>;
  outcomes: Array<{
    target: GoalOutcomeRead["targets"][number]; period: GoalOutcomeRead["periods"][number] | undefined;
    observations: GoalOutcomeRead["observations"];
    health: {
      status: "unknown" | "in_progress" | "achieved" | "guardrail_failed"; value: number | null;
      reason: string | null; observedAt: string | null; freshness: "fresh" | "stale" | "missing";
    };
  }>;
};

export const governanceOutcomesApi = {
  get: (goalId: string) => api.get<GoalOutcomeRead>(`/goals/${goalId}/outcomes`),
  createTarget: (goalId: string, input: CreateOutcomeTarget) => api.post<GoalOutcomeRead["targets"][number]>(`/goals/${goalId}/outcomes/targets`, input),
  addObservation: (goalId: string, input: OutcomeObservationInput) => api.post<{ observation: GoalOutcomeRead["observations"][number]; reused: boolean }>(`/goals/${goalId}/outcomes/observations`, input),
  correctObservation: (goalId: string, input: OutcomeObservationInput & { supersedesId: string; correctionReason: string }) => api.post<{ observation: GoalOutcomeRead["observations"][number]; reused: boolean }>(`/goals/${goalId}/outcomes/observations/corrections`, input),
  addCheckin: (goalId: string, input: CreateOutcomeCheckin) => api.post<GoalOutcomeRead["checkins"][number]>(`/goals/${goalId}/outcomes/checkins`, input),
};
