import { describe, expect, it } from "vitest";
import { createOutcomeObservationSchema, createOutcomeTargetSchema } from "./governance-outcomes.js";

const target = {
  expectedRevision: 0,
  period: { label: "October", timezone: "America/New_York", intervalStart: "2026-10-01T04:00:00.000Z", intervalEnd: "2026-11-01T04:00:00.000Z" },
  metricKey: "retention", kind: "percentage", unit: "%", direction: "increase", aggregation: "latest",
  population: "eligible accounts", source: "manual", queryVersion: "v1", freshnessHours: 72,
  baselineValue: 20, targetValue: 35,
};

describe("goal outcome target contract", () => {
  it("requires an explicit non-negative optimistic revision", () => {
    expect(createOutcomeTargetSchema.safeParse(target).success).toBe(true);
    expect(createOutcomeTargetSchema.safeParse({ ...target, expectedRevision: undefined }).success).toBe(false);
    expect(createOutcomeTargetSchema.safeParse({ ...target, expectedRevision: -1 }).success).toBe(false);
  });

  it("rejects directionally impossible targets and invalid timezones", () => {
    expect(createOutcomeTargetSchema.safeParse({ ...target, targetValue: 19 }).success).toBe(false);
    expect(createOutcomeTargetSchema.safeParse({ ...target, period: { ...target.period, timezone: "Mars/Olympus" } }).success).toBe(false);
  });
  it("persists a conservative target maturity window and validates availability provenance", () => {
    expect(createOutcomeTargetSchema.parse(target).maturityHours).toBe(24);
    expect(createOutcomeTargetSchema.safeParse({ ...target, maturityHours: 0 }).success).toBe(false);
    const observation = {
      targetId: "00000000-0000-4000-8000-000000000001", source: "manual", sourceRevision: "v1", sourceKey: "snapshot-1",
      value: 1, unit: "%", population: "eligible accounts", windowStart: "2026-10-01T04:00:00.000Z",
      windowEnd: "2026-10-02T04:00:00.000Z", observedAt: "2026-10-01T12:00:00.000Z", availableAt: "2026-10-01T13:00:00.000Z",
    };
    expect(createOutcomeObservationSchema.safeParse(observation).success).toBe(true);
    expect(createOutcomeObservationSchema.safeParse({ ...observation, availableAt: "2026-10-01T11:59:00.000Z" }).success).toBe(false);
  });
});
