import { describe, expect, it } from "vitest";
import { scaleTestTimeout } from "./test-timeout-factor.js";

describe("scaleTestTimeout", () => {
  it("keeps the upstream budget when the factor is unset", () => {
    expect(scaleTestTimeout(180_000, {})).toBe(180_000);
  });

  it("keeps the upstream budget when the factor is blank", () => {
    expect(scaleTestTimeout(30_000, { PAPERCLIP_TEST_TIMEOUT_FACTOR: " " })).toBe(30_000);
  });

  it("multiplies the budget by an opted-in factor", () => {
    expect(scaleTestTimeout(180_000, { PAPERCLIP_TEST_TIMEOUT_FACTOR: "2" })).toBe(360_000);
  });

  it("rounds fractional results up to whole milliseconds", () => {
    expect(scaleTestTimeout(1_001, { PAPERCLIP_TEST_TIMEOUT_FACTOR: "1.5" })).toBe(1_502);
  });

  it.each(["abc", "0.5", "0", "-2", "11", "Infinity", "NaN"])(
    "rejects factor %s instead of silently using a different budget",
    (value) => {
      expect(() => scaleTestTimeout(1_000, { PAPERCLIP_TEST_TIMEOUT_FACTOR: value })).toThrow(
        /PAPERCLIP_TEST_TIMEOUT_FACTOR must be a number from 1 to 10/,
      );
    },
  );
});
