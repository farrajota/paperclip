import type {
  GovernanceCalendarResult,
  GovernancePlanableTasksResult,
  IssuePlanningInput,
  IssuePlanningRecord,
} from "@paperclipai/shared/governance-planning";

export async function fetchGovernanceCalendar(companyId: string, params: URLSearchParams): Promise<GovernanceCalendarResult> {
  const response = await fetch(`/api/companies/${companyId}/governance-calendar?${params.toString()}`);
  if (!response.ok) throw new Error(`Calendar request failed (${response.status})`);
  return response.json() as Promise<GovernanceCalendarResult>;
}

export async function fetchPlanableTasks(companyId: string, params: URLSearchParams): Promise<GovernancePlanableTasksResult> {
  const response = await fetch(`/api/companies/${companyId}/governance-calendar/tasks?${params.toString()}`);
  if (!response.ok) throw new Error(`Task selector request failed (${response.status})`);
  return response.json() as Promise<GovernancePlanableTasksResult>;
}

export async function fetchIssuePlanning(issueId: string): Promise<IssuePlanningRecord | null> {
  const response = await fetch(`/api/issues/${issueId}/planning`);
  if (!response.ok) throw new Error(`Planning request failed (${response.status})`);
  return response.json() as Promise<IssuePlanningRecord | null>;
}

export async function saveIssuePlanning(issueId: string, input: IssuePlanningInput): Promise<IssuePlanningRecord> {
  const response = await fetch(`/api/issues/${issueId}/planning`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (response.status === 409) throw new Error("Planning changed elsewhere. Reload before saving.");
  if (!response.ok) throw new Error(`Planning update failed (${response.status})`);
  return response.json() as Promise<IssuePlanningRecord>;
}
