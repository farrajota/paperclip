import { describe, expect, it } from "vitest";
import {
  formatInstantForDateTimeLocal,
  issuePlanningInputSchema,
  isIsoCalendarDate,
  isIssueStartEligible,
  resolveDateTimeLocalInput,
  resolvePlanningDateTimeEdit,
} from "./governance-planning.js";

describe("issue planning contract", () => {
  it("validates ISO calendar dates without remapping years below 0100", () => {
    expect(isIsoCalendarDate("0001-01-01")).toBe(true);
    expect(isIsoCalendarDate("0001-02-29")).toBe(false);
    expect(issuePlanningInputSchema.safeParse({
      expectedRevision: 0, timezone: "UTC", dateMode: "all_day", plannedStart: "0001-01-01",
    }).success).toBe(true);
  });
  it("roundtrips selected-zone timed inputs and resolves daylight-saving transitions explicitly", () => {
    const roundtripped = resolveDateTimeLocalInput("2026-11-02T09:00", "America/New_York");
    expect(roundtripped).toBe("2026-11-02T14:00:00.000Z");
    expect(formatInstantForDateTimeLocal(roundtripped, "America/New_York")).toBe("2026-11-02T09:00");
    expect(resolveDateTimeLocalInput("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(() => resolveDateTimeLocalInput("2026-03-08T02:30", "America/New_York"))
      .toThrow("This local time does not exist because of a daylight-saving-time transition.");
  });

  it("preserves unchanged precision and later-fold instants while re-presenting saved times in another zone", () => {
    const precise = "2026-11-02T14:00:45.123456Z";
    expect(formatInstantForDateTimeLocal(precise, "America/New_York")).toBe("2026-11-02T09:00:45.123");
    expect(resolvePlanningDateTimeEdit("2026-11-02T09:00:45.123", "America/New_York", precise)).toBe(precise);
    const laterFold = "2026-11-01T06:30:00Z";
    expect(resolvePlanningDateTimeEdit("2026-11-01T01:30", "America/New_York", laterFold)).toBe(laterFold);
    expect(resolvePlanningDateTimeEdit("2026-11-01T06:30", "UTC", laterFold)).toBe(laterFold);
    expect(resolvePlanningDateTimeEdit("2026-11-01T01:31", "America/New_York", laterFold)).toBe("2026-11-01T05:31:00.000Z");
    expect(resolveDateTimeLocalInput("2026-11-02T09:00:45.123", "America/New_York")).toBe("2026-11-02T14:00:45.123Z");
  });

  it("keeps separate date intent fields and supports date-only all-day values", () => {
    const result = issuePlanningInputSchema.safeParse({
      earliestStart: "2026-11-01", plannedStart: "2026-11-02", plannedFinish: "2026-11-04",
      hardDeadline: "2026-11-05", forecastStart: "2026-11-03", forecastFinish: "2026-11-04",
      actualStart: null, actualFinish: null, dateMode: "all_day", timezone: "America/New_York",
      expectedRevision: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid dates, invalid timezones, negative revisions and inverted ranges", () => {
    expect(issuePlanningInputSchema.safeParse({ expectedRevision: 0, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ expectedRevision: -1, timezone: "UTC" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ expectedRevision: 0, timezone: "UTC", plannedStart: "not-a-date" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ expectedRevision: 0, timezone: "UTC", plannedStart: "2026-11-05T00:00:00Z", plannedFinish: "2026-11-01T00:00:00Z" }).success).toBe(false);
  });
  it("rejects inverted forecast and actual intervals in both date modes", () => {
    const base = { expectedRevision: 0, timezone: "UTC" };
    expect(issuePlanningInputSchema.safeParse({
      ...base, forecastStart: "2026-11-05T12:00:00Z", forecastFinish: "2026-11-05T11:00:00Z",
    }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({
      ...base, dateMode: "all_day", actualStart: "2026-11-05", actualFinish: "2026-11-04",
    }).success).toBe(false);
  });

  it("does not admit work before earliest start, then permits it", () => {
    expect(isIssueStartEligible("2026-11-02T10:00:00.000Z", new Date("2026-11-02T09:59:59.999Z"))).toBe(false);
    expect(isIssueStartEligible("2026-11-02T10:00:00.000Z", new Date("2026-11-02T10:00:00.000Z"))).toBe(true);
    expect(isIssueStartEligible(null, new Date("2026-11-02T10:00:00.000Z"))).toBe(true);
  });
  it("interprets all-day earliest start at local midnight across timezone offsets", () => {
    expect(isIssueStartEligible("2026-11-01", new Date("2026-11-01T03:59:59.999Z"), "America/New_York", "all_day")).toBe(false);
    expect(isIssueStartEligible("2026-11-01", new Date("2026-11-01T04:00:00.000Z"), "America/New_York", "all_day")).toBe(true);
  });
  it("requires offset-qualified instants in timed mode and calendar dates in all-day mode", () => {
    const base = { expectedRevision: 0, timezone: "America/New_York" };
    expect(issuePlanningInputSchema.safeParse({ ...base, earliestStart: "2026-11-01" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ ...base, plannedStart: "2026-02-30T10:00:00-05:00" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ ...base, plannedStart: "2026-11-01T01:30:00" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ ...base, dateMode: "all_day", hardDeadline: "2026-11-01T00:00:00Z" }).success).toBe(false);
    expect(issuePlanningInputSchema.safeParse({ ...base, dateMode: "all_day", hardDeadline: "2026-02-30" }).success).toBe(false);
  });

  it("compares all-day eligibility by selected-zone calendar date through DST transitions", () => {
    expect(isIssueStartEligible("2026-11-01", new Date("2026-11-01T03:59:59.999Z"), "America/New_York", "all_day")).toBe(false);
    expect(isIssueStartEligible("2026-11-01", new Date("2026-11-01T04:00:00.000Z"), "America/New_York", "all_day")).toBe(true);
    expect(isIssueStartEligible("2026-11-01", new Date("2026-11-02T04:59:59.999Z"), "America/New_York", "all_day")).toBe(true);
  });
});
