import { describe, expect, it } from "vitest";
import {
  routineOccurrenceDecisionSchema,
  routineOccurrenceIdentity,
} from "@paperclipai/shared/governance-occurrences";
import { nextCronTickInTimeZone } from "./routines.js";

describe("routine occurrence contracts", () => {
  it("uses the original schedule instant in a stable trigger-scoped identity", () => {
    const identity = {
      companyId: "company-1",
      routineId: "routine-1",
      triggerId: "trigger-1",
      scheduledAt: new Date("2026-10-26T08:00:00.000Z"),
    };
    expect(routineOccurrenceIdentity(identity)).toBe(
      routineOccurrenceIdentity({ ...identity, scheduledAt: new Date(identity.scheduledAt) }),
    );
    expect(routineOccurrenceIdentity(identity)).not.toBe(
      routineOccurrenceIdentity({ ...identity, triggerId: "trigger-2" }),
    );
    expect(routineOccurrenceIdentity(identity)).not.toBe(
      routineOccurrenceIdentity({ ...identity, scheduledAt: new Date("2026-10-26T09:00:00.000Z") }),
    );
  });

  it("keeps occurrence disposition separate from execution lifecycle", () => {
    expect(routineOccurrenceDecisionSchema.parse({
      disposition: "obligation",
      executionState: "waiting",
      decisionReason: null,
    })).toEqual({ disposition: "obligation", executionState: "waiting", decisionReason: null });
    expect(routineOccurrenceDecisionSchema.parse({
      disposition: "suppressed",
      executionState: "skipped",
      decisionReason: "paused",
    }).disposition).toBe("suppressed");
    expect(() => routineOccurrenceDecisionSchema.parse({
      disposition: "satisfied",
      executionState: "waiting",
      decisionReason: null,
    })).toThrow();
  });
});

describe("bounded routine cron search", () => {
  it("consumes a shared minute budget and stops before the exclusive end", () => {
    const budget = { remainingMinutes: 4 };

    expect(nextCronTickInTimeZone("5 * * * *", "UTC", new Date("2026-10-26T00:00:00.000Z"), {
      before: new Date("2026-10-26T00:10:00.000Z"),
      budget,
    })).toBeNull();
    expect(budget.remainingMinutes).toBe(0);

    const endBudget = { remainingMinutes: 10 };
    expect(nextCronTickInTimeZone("5 * * * *", "UTC", new Date("2026-10-26T00:04:00.000Z"), {
      before: new Date("2026-10-26T00:05:00.000Z"),
      budget: endBudget,
    })).toBeNull();
    expect(endBudget.remainingMinutes).toBe(10);
  });

  it("validates bounded search dates and budgets while preserving the unbounded call form", () => {
    expect(nextCronTickInTimeZone("* * * * *", "UTC", new Date("2026-10-26T00:00:00.000Z")))
      .toEqual(new Date("2026-10-26T00:01:00.000Z"));
    expect(() => nextCronTickInTimeZone("* * * * *", "UTC", new Date("2026-10-26T00:00:00.000Z"), {
      before: new Date(Number.NaN),
      budget: { remainingMinutes: 1 },
    })).toThrow();
    expect(() => nextCronTickInTimeZone("* * * * *", "UTC", new Date("2026-10-26T00:00:00.000Z"), {
      before: new Date("2026-10-26T00:10:00.000Z"),
      budget: { remainingMinutes: 1.5 },
    })).toThrow();
  });
});
