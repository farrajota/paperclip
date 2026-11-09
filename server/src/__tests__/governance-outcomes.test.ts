import { describe, expect, it } from "vitest";
import { createOutcomeTargetSchema } from "@paperclipai/shared/governance-outcomes";
import { evaluateOutcomeHealth } from "../services/governance-outcomes.js";

const target = {
  direction: "increase" as const,
  aggregation: "latest" as const,
  baselineValue: 10,
  targetValue: 20,
  rangeMin: null,
  rangeMax: null,
  unit: "users",
  source: "manual",
  population: "active users",
  intervalStart: new Date("2026-10-01T00:00:00.000Z"),
  intervalEnd: new Date("2026-11-01T00:00:00.000Z"),
  freshnessHours: 48,
  maturityHours: 24,
  guardrails: [],
};
const observation = (overrides: Record<string, unknown> = {}) => ({
  value: 15,
  unit: "users",
  source: "manual",
  population: "active users",
  windowStart: new Date("2026-10-18T00:00:00.000Z"),
  windowEnd: new Date("2026-10-19T00:00:00.000Z"),
  observedAt: new Date("2026-10-18T12:00:00.000Z"),
  availableAt: new Date("2026-10-19T00:00:00.000Z"),
  ingestedAt: new Date("2026-10-19T01:00:00.000Z"),
  valid: true,
  supersededBy: null,
  ...overrides,
});

describe("governance outcome health", () => {
  it("treats no measurement as unknown rather than zero or achieved", () => {
    expect(evaluateOutcomeHealth(target, [], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "unknown" });
  });

  it("uses observation time rather than ingestion order for latest aggregation", () => {
    const laterIngested = observation({ value: 18, windowStart: new Date("2026-10-18T00:00:00.000Z"), windowEnd: new Date("2026-10-20T00:00:00.000Z"), observedAt: new Date("2026-10-19T12:00:00.000Z"), availableAt: new Date("2026-10-20T00:00:00.000Z"), ingestedAt: new Date("2026-10-21T00:00:00.000Z") });
    const laterObserved = observation({ value: 11, windowStart: new Date("2026-10-18T00:00:00.000Z"), windowEnd: new Date("2026-10-20T00:00:00.000Z"), observedAt: new Date("2026-10-19T18:00:00.000Z"), availableAt: new Date("2026-10-20T00:00:00.000Z"), ingestedAt: new Date("2026-10-20T01:00:00.000Z") });
    expect(evaluateOutcomeHealth(target, [laterIngested, laterObserved], new Date("2026-10-21T00:00:00.000Z"))).toMatchObject({ value: 11 });
  });

  it("requires a decreasing metric to reach or beat its target from its baseline", () => {
    const decreasing = { ...target, direction: "decrease" as const, baselineValue: 20, targetValue: 10 };
    expect(evaluateOutcomeHealth(decreasing, [observation({ value: 15 })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "in_progress" });
    expect(evaluateOutcomeHealth(decreasing, [observation({ value: 10 })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "achieved" });
  });

  it("does not report achievement when observations are stale or mismatched", () => {
    expect(evaluateOutcomeHealth(target, [observation({ windowStart: new Date("2026-10-16T00:00:00.000Z"), observedAt: new Date("2026-10-16T12:00:00.000Z") })], new Date("2026-10-20T00:00:00.000Z"))).toMatchObject({ status: "unknown" });
    expect(evaluateOutcomeHealth(target, [observation({ unit: "seats" })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "unknown" });
    expect(evaluateOutcomeHealth(target, [observation({ source: "unapproved" })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "unknown" });
  });

  it("does not treat absent guardrail evidence as proof of failure", () => {
    const guarded = { ...target, guardrails: [{ name: "churn", direction: "max" as const, threshold: 5 }] };
    expect(evaluateOutcomeHealth(guarded, [observation({ value: 20, guardrailValues: { churn: 6 } })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "guardrail_failed" });
    expect(evaluateOutcomeHealth(guarded, [observation({ value: 20, guardrailValues: {} })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "unknown" });
  });
  it("sums only non-overlapping mature windows and returns unknown for overlapping samples", () => {
    const sumTarget = { ...target, aggregation: "sum" as const, freshnessHours: 96 };
    const first = observation({ value: 2, windowStart: new Date("2026-10-19T00:00:00.000Z"), windowEnd: new Date("2026-10-20T00:00:00.000Z"), observedAt: new Date("2026-10-19T12:00:00.000Z"), availableAt: new Date("2026-10-20T00:00:00.000Z") });
    const second = observation({ value: 3, windowStart: new Date("2026-10-20T00:00:00.000Z"), windowEnd: new Date("2026-10-21T00:00:00.000Z"), observedAt: new Date("2026-10-20T12:00:00.000Z"), availableAt: new Date("2026-10-21T00:00:00.000Z") });
    expect(evaluateOutcomeHealth(sumTarget, [first, second], new Date("2026-10-22T13:00:00.000Z"))).toMatchObject({ value: 5 });
    expect(evaluateOutcomeHealth(sumTarget, [first, observation({ ...second, windowStart: new Date("2026-10-19T12:00:00.000Z") })], new Date("2026-10-22T13:00:00.000Z"))).toMatchObject({ status: "unknown" });
  });

  it("applies inclusive bounds for range metrics", () => {
    const range = { ...target, direction: "range" as const, rangeMin: 12, rangeMax: 16 };
    expect(evaluateOutcomeHealth(range, [observation({ value: 16 })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "achieved" });
    expect(evaluateOutcomeHealth(range, [observation({ value: 17 })], new Date("2026-10-20T02:00:00.000Z"))).toMatchObject({ status: "in_progress" });
  });

  it("keeps future observations and future availability unknown", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    const futureObserved = observation({ windowStart: new Date("2026-10-19T00:00:00.000Z"), windowEnd: new Date("2026-10-21T00:00:00.000Z"), observedAt: new Date("2026-10-20T13:00:00.000Z"), availableAt: new Date("2026-10-20T13:00:00.000Z") });
    const futureAvailable = observation({ availableAt: new Date("2026-10-21T00:00:00.000Z") });
    expect(evaluateOutcomeHealth(target, [futureObserved], now)).toMatchObject({ status: "unknown", reason: "A matching observation is from the future" });
    expect(evaluateOutcomeHealth(target, [futureAvailable], now)).toMatchObject({ status: "unknown", reason: "Observation is not available yet" });
  });

  it("does not count an immature window until its persisted maturity delay expires", () => {
    const immature = observation({ windowStart: new Date("2026-10-20T00:00:00.000Z"), windowEnd: new Date("2026-10-20T12:00:00.000Z"), observedAt: new Date("2026-10-20T11:59:00.000Z"), availableAt: new Date("2026-10-20T11:59:00.000Z") });
    expect(evaluateOutcomeHealth(target, [immature], new Date("2026-10-21T11:59:00.000Z"))).toMatchObject({ status: "unknown", reason: "The measurement window has not matured" });
    expect(evaluateOutcomeHealth(target, [immature], new Date("2026-10-21T12:00:00.000Z"))).toMatchObject({ status: "in_progress", value: 15 });
  });

  it("rejects invalid IANA timezones and targets that reverse their baseline direction", () => {
    const valid = { expectedRevision: 0, period: { label: "October", timezone: "UTC", intervalStart: "2026-10-01T00:00:00.000Z", intervalEnd: "2026-11-01T00:00:00.000Z", lifecycle: "active" }, metricKey: "users", kind: "count", unit: "users", direction: "decrease", aggregation: "latest", population: "active users", source: "manual", queryVersion: "v1", freshnessHours: 48, baselineValue: 20, targetValue: 10, guardrails: [], trajectory: [] };
    expect(createOutcomeTargetSchema.safeParse(valid).success).toBe(true);
    expect(createOutcomeTargetSchema.safeParse({ ...valid, period: { ...valid.period, timezone: "Mars/Olympus" } }).success).toBe(false);
    expect(createOutcomeTargetSchema.safeParse({ ...valid, targetValue: 25 }).success).toBe(false);
  });
});
