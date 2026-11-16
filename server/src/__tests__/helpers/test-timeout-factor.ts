// A few upstream fixtures enforce wall-clock budgets sized for upstream CI
// hardware. Slower isolated runners (for example gVisor-sandboxed CI) opt in to
// a proportionally larger budget; the exercised workload and assertions are
// unchanged and the default keeps the upstream budget.
export const TEST_TIMEOUT_FACTOR_ENV = "PAPERCLIP_TEST_TIMEOUT_FACTOR";

const MIN_FACTOR = 1;
const MAX_FACTOR = 10;

export function readTestTimeoutFactor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TEST_TIMEOUT_FACTOR_ENV];
  if (raw === undefined || raw.trim() === "") return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor < MIN_FACTOR || factor > MAX_FACTOR) {
    throw new Error(
      `${TEST_TIMEOUT_FACTOR_ENV} must be a number from ${MIN_FACTOR} to ${MAX_FACTOR}; received ${JSON.stringify(raw)}`,
    );
  }
  return factor;
}

export function scaleTestTimeout(baseMs: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(baseMs * readTestTimeoutFactor(env));
}

// Vitest's own default for vi.waitFor (vitest 4.1: `timeout = 1e3`).
export const VITEST_WAIT_FOR_DEFAULT_TIMEOUT_MS = 1_000;

type WaitForOptions = number | { timeout?: number; interval?: number } | undefined;

export function scaleWaitForOptions(
  options: WaitForOptions,
  env: NodeJS.ProcessEnv = process.env,
): { timeout: number; interval?: number } {
  const { timeout = VITEST_WAIT_FOR_DEFAULT_TIMEOUT_MS, ...rest } =
    typeof options === "number" ? { timeout: options } : (options ?? {});
  return { ...rest, timeout: scaleTestTimeout(timeout, env) };
}

const SCALED_WAIT_FOR = Symbol.for("paperclip.test.scaledWaitFor");

type WaitForFn = (callback: () => unknown, options?: WaitForOptions) => Promise<unknown>;
type WaitForTarget = { waitFor: WaitForFn };

// vi.waitFor budgets are not covered by the Vitest config's scaled test and
// hook timeouts, and most calls rely on its fixed 1 s default. Wrapping it once
// per test file scales every budget, default or explicit, by the same factor.
// With no factor set, waitFor is left exactly as upstream ships it.
export function installScaledWaitFor(target: WaitForTarget, env: NodeJS.ProcessEnv = process.env): void {
  if (readTestTimeoutFactor(env) === 1) return;
  const current = target.waitFor as WaitForFn & { [SCALED_WAIT_FOR]?: true };
  if (current[SCALED_WAIT_FOR]) return;
  target.waitFor = Object.assign(
    (callback: () => unknown, options?: WaitForOptions) => current(callback, scaleWaitForOptions(options, env)),
    { [SCALED_WAIT_FOR]: true as const },
  );
}
