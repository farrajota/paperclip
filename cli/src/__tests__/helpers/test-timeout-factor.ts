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
