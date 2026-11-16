export type IssueOneTimeScheduleStatus =
  | "scheduled"
  | "queued"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type IssueOneTimeScheduleInvalidReason =
  | "company_inactive"
  | "issue_deleted"
  | "assignee_changed"
  | "issue_ineligible"
  | "agent_ineligible";

export type IssueOneTimeScheduleDueDecision =
  | { outcome: "waiting" | "already_claimed" | "cancelled" | "dispatch" }
  | { outcome: "invalidate"; reason: IssueOneTimeScheduleInvalidReason };

export const ISSUE_ONE_TIME_SCHEDULE_ELIGIBLE_STATUS_KEYS: Record<string, true> = {
  backlog: true,
  todo: true,
  in_progress: true,
};
export function isIssueOneTimeScheduleEligibleStatus(
  status: string | null | undefined,
): status is "backlog" | "todo" | "in_progress" {
  return status !== null && status !== undefined &&
    ISSUE_ONE_TIME_SCHEDULE_ELIGIBLE_STATUS_KEYS[status] === true;
}

export interface NormalizedIssueScheduleTime {
  dueAt: Date;
  timeZone: string;
}
export function normalizeIssueScheduleTime(
  input: string,
  timeZone: string,
  now = new Date(),
): NormalizedIssueScheduleTime {
  const timestamp = input.trim();
  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) {
    throw new Error("A future timestamp with an explicit UTC offset is required");
  }
  // Groups: 1-6 date/time, 7 the whole zone suffix, 8 its sign, 9-10 offset hours/minutes.
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? "0");
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) :
    [4, 6, 9, 11].includes(month) ? 30 :
      month >= 1 && month <= 12 ? 31 : 0;
  if (
    day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    (offsetHourText !== undefined &&
      (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))
  ) {
    throw new Error("Invalid scheduled timestamp");
  }
  const dueAt = new Date(timestamp);
  if (!Number.isFinite(dueAt.getTime())) throw new Error("Invalid scheduled timestamp");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(dueAt);
  } catch {
    throw new Error("Invalid IANA timezone");
  }
  if (dueAt.getTime() <= now.getTime()) {
    throw new Error("Scheduled timestamp must be in the future");
  }
  return { dueAt, timeZone };
}

export function resolveDueIssueOneTimeSchedule(input: {
  schedule: {
    dueAt: Date;
    assigneeAgentId: string;
    cancelledAt: Date | null;
    wakeupRequestId: string | null;
  };
  issue: {
    exists: boolean;
    status: string | null;
    hiddenAt: Date | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  companyStatus: string | null;
  agentCompanyId: string | null;
  companyId: string;
  agentExists: boolean;
  now: Date;
}): IssueOneTimeScheduleDueDecision {
  if (input.schedule.cancelledAt) return { outcome: "cancelled" };
  if (input.schedule.wakeupRequestId) return { outcome: "already_claimed" };
  if (input.schedule.dueAt.getTime() > input.now.getTime()) {
    return { outcome: "waiting" };
  }
  if (input.companyStatus !== "active") {
    return { outcome: "invalidate", reason: "company_inactive" };
  }
  if (!input.issue.exists) {
    return { outcome: "invalidate", reason: "issue_deleted" };
  }
  if (
    input.issue.assigneeAgentId !== input.schedule.assigneeAgentId ||
    input.issue.assigneeUserId !== null
  ) {
    return { outcome: "invalidate", reason: "assignee_changed" };
  }
  if (
    input.issue.hiddenAt !== null ||
    !input.issue.status ||
    !isIssueOneTimeScheduleEligibleStatus(input.issue.status)
  ) {
    return { outcome: "invalidate", reason: "issue_ineligible" };
  }
  if (!input.agentExists || input.agentCompanyId !== input.companyId) {
    return { outcome: "invalidate", reason: "agent_ineligible" };
  }
  return { outcome: "dispatch" };
}

export function resolveIssueOneTimeScheduleStatus(input: {
  schedule: {
    cancelledAt: Date | null;
    cancellationReason?: string | null;
    wakeupRequestId: string | null;
  };
  wake: { status: string; error?: string | null; runId?: string | null } | null;
  run: { status: string; error?: string | null } | null;
}): { status: IssueOneTimeScheduleStatus; error: string | null } {
  if (input.schedule.cancelledAt) {
    return {
      status: "cancelled",
      error: input.schedule.cancellationReason ?? null,
    };
  }
  if (!input.schedule.wakeupRequestId) return { status: "scheduled", error: null };
  const error = input.run?.error ?? input.wake?.error ?? null;
  if (input.run?.status === "running") return { status: "running", error };
  if (input.run?.status === "queued") return { status: "queued", error };
  if (input.run?.status === "succeeded") return { status: "completed", error };
  if (input.run && ["failed", "timed_out"].includes(input.run.status)) {
    return { status: "failed", error };
  }
  if (input.run && ["cancelled", "interrupted"].includes(input.run.status)) {
    return { status: "cancelled", error };
  }
  if (input.wake?.status === "cancelled") return { status: "cancelled", error };
  if (["failed", "skipped"].includes(input.wake?.status ?? "")) {
    return { status: "failed", error };
  }
  if (input.wake?.status === "deferred_issue_execution") {
    return { status: "waiting", error };
  }
  if (["queued", "claimed", "coalesced"].includes(input.wake?.status ?? "")) {
    return { status: "queued", error };
  }
  return { status: "waiting", error };
}
