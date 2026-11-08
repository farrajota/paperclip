import { afterEach, describe, expect, it, vi } from "vitest";

import { TEST_TIMEOUT_FACTOR_ENV } from "./helpers/test-timeout-factor.js";

async function loadServerVitestBudgets() {
  vi.resetModules();
  const config = (await import("../../vitest.config.js")).default;
  const { testTimeout, hookTimeout, teardownTimeout } = config.test ?? {};
  return { testTimeout, hookTimeout, teardownTimeout };
}

describe("server vitest budgets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the upstream budgets when no timeout factor is set", async () => {
    vi.stubEnv(TEST_TIMEOUT_FACTOR_ENV, "");

    await expect(loadServerVitestBudgets()).resolves.toEqual({
      testTimeout: 15_000,
      hookTimeout: 30_000,
      teardownTimeout: 30_000,
    });
  });

  it("scales the per-test, hook and teardown budgets by the opt-in factor", async () => {
    vi.stubEnv(TEST_TIMEOUT_FACTOR_ENV, "2");

    await expect(loadServerVitestBudgets()).resolves.toEqual({
      testTimeout: 30_000,
      hookTimeout: 60_000,
      teardownTimeout: 60_000,
    });
  });

  it("refuses to load with an invalid factor instead of silently using another budget", async () => {
    vi.stubEnv(TEST_TIMEOUT_FACTOR_ENV, "0.5");

    await expect(loadServerVitestBudgets()).rejects.toThrow(
      /PAPERCLIP_TEST_TIMEOUT_FACTOR must be a number from 1 to 10/,
    );
  });
});
