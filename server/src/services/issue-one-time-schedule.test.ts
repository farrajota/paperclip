import { describe, expect, it } from "vitest";
import {
  normalizeIssueScheduleTime,
  resolveDueIssueOneTimeSchedule,
  resolveIssueOneTimeScheduleStatus,
} from "./issue-one-time-schedule.js";

const NOW = new Date("2026-10-23T00:00:00.000Z");
const DUE_AT = new Date("2026-10-26T13:00:00.000Z");

describe("issue one-time schedule time normalization", () => {
  it("normalizes an explicit offset to UTC and preserves the entered IANA zone", () => {
    expect(
      normalizeIssueScheduleTime(
        "2026-10-26T09:00:00-04:00",
        "America/New_York",
        NOW,
      ),
    ).toEqual({ dueAt: DUE_AT, timeZone: "America/New_York" });
  });

  it("rejects an unknown zone after a valid future timestamp reaches zone validation", () => {
    expect(() =>
      normalizeIssueScheduleTime(
        "2026-10-26T13:00:00Z",
        "Mars/Olympus",
        NOW,
      ),
    ).toThrow("Invalid IANA timezone");
  });

  it("rejects malformed and non-future timestamps against the injected clock", () => {
    expect(() => normalizeIssueScheduleTime("tomorrow", "UTC", NOW)).toThrow(
      "explicit UTC offset",
    );
    expect(() =>
      normalizeIssueScheduleTime("2026-10-23T00:00:00Z", "UTC", NOW),
    ).toThrow("future");
  });

  it("normalizes offsets that are not whole hours", () => {
    expect(
      normalizeIssueScheduleTime("2026-10-26T18:30:00+05:30", "Asia/Kolkata", NOW),
    ).toEqual({ dueAt: DUE_AT, timeZone: "Asia/Kolkata" });
    expect(
      normalizeIssueScheduleTime("2026-10-26T18:45:00+05:45", "Asia/Kathmandu", NOW),
    ).toEqual({ dueAt: DUE_AT, timeZone: "Asia/Kathmandu" });
  });

  it("rejects out-of-range offset hours and minutes", () => {
    expect(() =>
      normalizeIssueScheduleTime("2026-10-26T13:00:00+24:00", "UTC", NOW),
    ).toThrow("Invalid scheduled timestamp");
    expect(() =>
      normalizeIssueScheduleTime("2026-10-26T13:00:00+05:60", "UTC", NOW),
    ).toThrow("Invalid scheduled timestamp");
  });
});

describe("one-time schedule due claim policy", () => {
  const base = {
    schedule: {
      dueAt: DUE_AT,
      assigneeAgentId: "agent-a",
      cancelledAt: null,
      wakeupRequestId: null,
    },
    issue: {
      exists: true,
      status: "backlog",
      hiddenAt: null,
      assigneeAgentId: "agent-a",
      assigneeUserId: null,
    },
    companyStatus: "active",
    agentCompanyId: "company-a",
    companyId: "company-a",
    agentExists: true,
    now: NOW,
  };

  it("waits before the instant and dispatches an eligible assigned backlog issue at due time", () => {
    expect(resolveDueIssueOneTimeSchedule(base)).toEqual({ outcome: "waiting" });
    expect(
      resolveDueIssueOneTimeSchedule({ ...base, now: DUE_AT }),
    ).toEqual({ outcome: "dispatch" });
  });

  it.each([
    ["inactive company", { companyStatus: "paused" }, "company_inactive"],
    ["deleted issue", { issue: { ...base.issue, exists: false } }, "issue_deleted"],
    ["changed assignee", { issue: { ...base.issue, assigneeAgentId: "agent-b" } }, "assignee_changed"],
    ["human assignee", { issue: { ...base.issue, assigneeUserId: "user-a" } }, "assignee_changed"],
    ["terminal issue", { issue: { ...base.issue, status: "done" } }, "issue_ineligible"],
    ["blocked issue", { issue: { ...base.issue, status: "blocked" } }, "issue_ineligible"],
    ["hidden issue", { issue: { ...base.issue, hiddenAt: NOW } }, "issue_ineligible"],
    ["missing agent", { agentExists: false }, "agent_ineligible"],
    ["cross-company agent", { agentCompanyId: "company-b" }, "agent_ineligible"],
  ] as const)("invalidates a due schedule when %s", (_label, patch, reason) => {
    expect(
      resolveDueIssueOneTimeSchedule({
        ...base,
        ...patch,
        now: DUE_AT,
      }),
    ).toEqual({ outcome: "invalidate", reason });
  });

  it("never creates a second durable wake after a prior claim or cancellation", () => {
    expect(
      resolveDueIssueOneTimeSchedule({
        ...base,
        now: DUE_AT,
        schedule: { ...base.schedule, wakeupRequestId: "wake-1" },
      }),
    ).toEqual({ outcome: "already_claimed" });
    expect(
      resolveDueIssueOneTimeSchedule({
        ...base,
        now: DUE_AT,
        schedule: { ...base.schedule, cancelledAt: NOW },
      }),
    ).toEqual({ outcome: "cancelled" });
  });
});

describe("schedule state derived from native wake and run records", () => {
  const schedule = { cancelledAt: null, wakeupRequestId: "wake-1" };

  it.each([
    ["queued durable wake", { wake: { status: "claimed" }, run: null }, "queued"],
    ["deferred native admission", { wake: { status: "deferred_issue_execution" }, run: null }, "waiting"],
    ["queued heartbeat run", { wake: { status: "coalesced" }, run: { status: "queued" } }, "queued"],
    ["running heartbeat run", { wake: { status: "coalesced" }, run: { status: "running" } }, "running"],
    ["successful heartbeat run", { wake: { status: "coalesced" }, run: { status: "succeeded" } }, "completed"],
    ["failed heartbeat run", { wake: { status: "coalesced" }, run: { status: "failed" } }, "failed"],
    ["cancelled heartbeat run", { wake: { status: "coalesced" }, run: { status: "cancelled" } }, "cancelled"],
    ["skipped native wake", { wake: { status: "skipped" }, run: null }, "failed"],
  ] as const)("projects %s as its real native state", (_label, native, status) => {
    expect(resolveIssueOneTimeScheduleStatus({ schedule, ...native })).toMatchObject({
      status,
    });
  });

  it("keeps a persisted cancellation authoritative after a restart", () => {
    expect(
      resolveIssueOneTimeScheduleStatus({
        schedule: { ...schedule, cancelledAt: NOW },
        wake: { status: "queued" },
        run: { status: "queued" },
      }),
    ).toMatchObject({ status: "cancelled" });
  });
});
