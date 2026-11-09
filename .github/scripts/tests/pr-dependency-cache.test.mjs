import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
const jobs = [...workflow.matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|$(?![\s\S]))/gm)];
const action = readFileSync(new URL("../../actions/setup-ci-dependencies/action.yml", import.meta.url), "utf8");
const consumers = jobs.filter(([, , body]) => body.includes("uses: ./.github/actions/setup-ci-dependencies"));

test("PR workflows use the shared read-only dependency action in every consumer", () => {
  assert.deepEqual(consumers.map(([, job]) => job), [
    "typecheck_release_registry", "general_tests", "verify_paperclip_runner", "build",
    "verify_serialized_server", "canary_dry_run", "e2e_shards",
  ]);
  assert.doesNotMatch(workflow, /^ +cache: pnpm$/m);
  assert.doesNotMatch(workflow, /uses: actions\/cache(?:@|\/save@)/);
  for (const [, job, body] of jobs) {
    for (const step of body.split("      - name:").filter((step) => step.includes("uses: actions/setup-node@"))) {
      assert.match(step, /package-manager-cache: false/, job);
    }
  }
  for (const [, job, body] of consumers) {
    const checkout = body.indexOf("uses: actions/checkout@");
    const node = body.indexOf("uses: actions/setup-node@");
    const pnpm = body.indexOf("uses: pnpm/action-setup@");
    const install = body.indexOf("uses: ./.github/actions/setup-ci-dependencies");
    assert.ok(checkout >= 0 && checkout < node && node < pnpm && pnpm < install, job);
    assert.match(body.slice(checkout, node), /persist-credentials: false/, job);
    assert.match(body.slice(node, pnpm), /node-version: 24/, job);
    assert.match(body.slice(pnpm, install), /version: 9\.15\.4/, job);
    assert.doesNotMatch(body.slice(install).split("      - name:")[0], /save-cache:\s*['"]?true/, job);
    assert.doesNotMatch(body, /pnpm install --(?:no-frozen-lockfile|resolution-only)/, job);
  }
});

test("shared action restores the store before a frozen-only install without PR cache writes", () => {
  const locate = action.indexOf("    - name: Locate pnpm store");
  const restore = action.indexOf("    - name: Restore pnpm store (read only)");
  const install = action.indexOf("    - name: Install dependencies");
  const next = action.indexOf("    - name: Restore certified", install);
  assert.ok(locate >= 0 && locate < restore && restore < install && install < next);
  assert.match(action.slice(locate, restore), /pnpm store path --silent/);
  assert.match(action.slice(locate, restore), /node -p 'process.arch'/);
  const cache = action.slice(restore, install);
  assert.match(cache, /uses: actions\/cache\/restore@[a-f0-9]{40}/);
  assert.ok(cache.includes("key: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-${{ hashFiles(format('{0}/pnpm-lock.yaml', inputs.working-directory)) }}"));
  assert.ok(cache.includes("restore-keys: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-"));
  const installStep = action.slice(install, next);
  assert.match(installStep, /if: steps\.installed\.outputs\.cache-hit != 'true'/);
  assert.match(installStep, /^\s+pnpm install --frozen-lockfile\s*$/m);
  assert.doesNotMatch(action, /--no-frozen-lockfile|--resolution-only/);
  assert.match(action, /save-cache:\n\s+description:[^\n]*\n\s+default: 'false'/);
  for (const step of action.split("    - name: Save ").slice(1)) {
    assert.match(step, /inputs\.save-cache == 'true'/);
    assert.match(step, /github\.event_name == 'push'/);
    assert.match(step, /steps\.install\.outputs\.frozen == 'true'/);
  }
});

test("policy independently validates the lockfile with a pinned frozen install", () => {
  const policy = jobs.find(([, name]) => name === "policy")[2];
  assert.doesNotMatch(policy, /uses: actions\/cache|cache: pnpm|setup-ci-dependencies/);
  assert.match(policy, /node-version: 24/);
  assert.match(policy, /version: 9\.15\.4/);
  assert.match(policy, /name: Validate generated lockfile\n\s+run: pnpm install --frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(policy, /--no-frozen-lockfile|--resolution-only/);
});
