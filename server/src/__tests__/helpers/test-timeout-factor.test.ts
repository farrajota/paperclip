import { describe, expect, it } from "vitest";
import { installScaledWaitFor, scaleTestTimeout, scaleWaitForOptions } from "./test-timeout-factor.js";

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

describe("scaleWaitForOptions", () => {
  const doubled = { PAPERCLIP_TEST_TIMEOUT_FACTOR: "2" };

  it("scales Vitest's 1 s default when no options are given", () => {
    expect(scaleWaitForOptions(undefined, doubled)).toEqual({ timeout: 2_000 });
  });

  it("scales a numeric timeout", () => {
    expect(scaleWaitForOptions(300, doubled)).toEqual({ timeout: 600 });
  });

  it("scales the default and keeps the polling interval when only the interval is given", () => {
    expect(scaleWaitForOptions({ interval: 10 }, doubled)).toEqual({ interval: 10, timeout: 2_000 });
  });

  it("scales an explicit timeout and keeps the polling interval", () => {
    expect(scaleWaitForOptions({ timeout: 5_000, interval: 25 }, doubled)).toEqual({
      timeout: 10_000,
      interval: 25,
    });
  });

  it("keeps a zero timeout at zero", () => {
    expect(scaleWaitForOptions({ timeout: 0 }, doubled)).toEqual({ timeout: 0 });
  });
});

describe("installScaledWaitFor", () => {
  function recordingTarget() {
    const calls: unknown[] = [];
    const waitFor = (_callback: () => unknown, options?: unknown) => {
      calls.push(options);
      return Promise.resolve("done");
    };
    return { target: { waitFor }, original: waitFor, calls };
  }

  it("leaves waitFor untouched when the factor is unset", () => {
    const { target, original } = recordingTarget();
    installScaledWaitFor(target, {});
    expect(target.waitFor).toBe(original);
  });

  it("passes scaled options to the original waitFor and returns its result", async () => {
    const { target, calls } = recordingTarget();
    installScaledWaitFor(target, { PAPERCLIP_TEST_TIMEOUT_FACTOR: "2" });
    await expect(target.waitFor(() => undefined)).resolves.toBe("done");
    await target.waitFor(() => undefined, { timeout: 3_000, interval: 5 });
    expect(calls).toEqual([{ timeout: 2_000 }, { timeout: 6_000, interval: 5 }]);
  });

  it("does not scale twice when installed twice", async () => {
    const { target, calls } = recordingTarget();
    installScaledWaitFor(target, { PAPERCLIP_TEST_TIMEOUT_FACTOR: "2" });
    installScaledWaitFor(target, { PAPERCLIP_TEST_TIMEOUT_FACTOR: "2" });
    await target.waitFor(() => undefined, 500);
    expect(calls).toEqual([{ timeout: 1_000 }]);
  });
});
