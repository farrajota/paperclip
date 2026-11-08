import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const routing = read("../../workflows/ci-routing.yml");
const trusted = read("../../workflows/pr-trusted.yml");
const caller = read("../../workflows/pr.yml");
const review = read("../../workflows/commitperclip-review.yml");
const dependencies = read("../../actions/setup-ci-dependencies/action.yml");

function scopeScript() {
  const start = routing.indexOf("      - name: Select PR CI scope\n");
  assert.ok(start >= 0, "scope step is missing");
  const body = routing.slice(start);
  const runStart = body.indexOf("        run: |\n");
  assert.ok(runStart >= 0, "scope script is missing");
  return body.slice(runStart + "        run: |\n".length)
    .split("\n      - name:")[0]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function runScope({ compare = { files: [{ filename: "server/src/index.ts" }] }, stack = null, baseRef = "zay/main", profile = "false", failCompare = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-routing-test-"));
  const output = path.join(directory, "output");
  try {
    const gh = path.join(directory, "gh");
    writeFileSync(gh, `#!/usr/bin/env bash
[[ "\${GH_FAIL:-}" != true ]] || exit 1
printf '%s\\n' "\$COMPARE_JSON"
`);
    chmodSync(gh, 0o700);
    const result = spawnSync("bash", ["-c", scopeScript()], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "farrajota/paperclip",
        GH_TOKEN: "test-token",
        EVENT_NAME: "pull_request",
        EVENT_BASE_SHA: "a".repeat(40),
        EVENT_HEAD_SHA: "b".repeat(40),
        STACK_JSON: JSON.stringify(stack),
        PR_BASE_REF: baseRef,
        PROFILE_CI: profile,
        COMPARE_JSON: JSON.stringify(compare),
        GH_FAIL: String(failCompare),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("PR CI selects fork-owned workflows and ordinary hosted runners", () => {
  assert.match(caller, /uses: \.\/\.github\/workflows\/pr-trusted\.yml/);
  assert.match(trusted, /uses: \.\/\.github\/workflows\/ci-routing\.yml/);
  assert.match(routing, /^    runs-on: ubuntu-latest$/m);
  // Suites run on the pinned image they were qualified against, not whatever
  // ubuntu-latest currently resolves to.
  assert.match(routing, /runner=ubuntu-24\.04/);
  assert.doesNotMatch(routing, /runner=ubuntu-latest/);
  assert.doesNotMatch(`${caller}\n${trusted}\n${routing}`, /uses: paperclipai\/paperclip|@master/);
});

test("routing uses the trusted event base for profile authorization", () => {
  assert.match(routing, /EVENT_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(routing, /contents\/scripts\/ci-profile\/authorize\.mjs\?ref=\$EVENT_BASE_SHA/);
  assert.doesNotMatch(routing, /refs\/heads\/master|paperclipai\/paperclip/);
});

test("CI scope defaults to full coverage and compares within this repository", () => {
  assert.match(routing, /full_ci='true'/);
  assert.match(routing, /\/repos\/\$GITHUB_REPOSITORY\/compare\/\$EVENT_BASE_SHA\.\.\.\$EVENT_HEAD_SHA/);
  assert.match(routing, /PROFILE_CI.*true/);
  assert.match(trusted, /^  (?:policy|typecheck_release_registry|general_tests|serialized_tests|verify_runner):/m);
  assert.match(trusted, /name: Verify serialized server suites/);
  assert.match(trusted, /name: Verify Paperclip Runner/);
});

test("generated lockfiles are reviewed by frozen installs, never silent resolution", () => {
  assert.match(trusted, /name: Validate generated lockfile\n\s+run: pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dependencies, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(`${trusted}\n${dependencies}`, /resolution-only|no-frozen-lockfile/);
});

test("trusted PR metadata checks use only base source and repository token", () => {
  assert.match(review, /pull_request_target:/);
  assert.match(review, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(review, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(review, /COMMITPERCLIP_KEY|get-bot-token|refs\/heads\/master/);
  assert.match(review, /actions\/dependency-review-action/);
  assert.match(review, /node \.github\/scripts\/run-quality-gates\.mjs/);
});

test("dependency and metadata review failures remain blocking", () => {
  assert.match(review, /continue-on-error: true/);
  assert.match(review, /steps\.quality\.outcome == 'failure'.*steps\.dependency_review\.outcome == 'failure'/);
  assert.match(review, /exit 1/);
});

test("scope skips only safe release-note diffs and profiling restores full CI", () => {
  const releaseNotes = { files: [{ filename: "releases/v2026.10.27.0.md" }] };
  const codeChange = { files: [{ filename: "server/src/index.ts" }] };

  assert.equal(runScope({ compare: releaseNotes }).full_ci, "false");
  assert.equal(runScope({ compare: codeChange }).full_ci, "true");
  assert.equal(runScope({ compare: releaseNotes, profile: "true" }).full_ci, "true");
  assert.equal(runScope({ compare: releaseNotes, failCompare: true }).full_ci, "true");
  assert.equal(runScope({
    stack: { position: 2, size: 3, base: { ref: "zay/main" } },
    baseRef: "stack/lower",
  }).full_ci, "false");
  assert.equal(runScope({
    compare: { files: [
      { filename: "releases/v2026.10.27.0.md" },
      { filename: "server/src/index.ts" },
    ] },
  }).full_ci, "true");
  assert.equal(runScope({
    compare: { files: [{ filename: "releases/v2026.10.27.0.md", previous_filename: "scripts/release.sh" }] },
  }).full_ci, "true");
  assert.equal(runScope({
    compare: { files: Array.from({ length: 300 }, (_, index) => ({ filename: `releases/v${index}.md` })) },
  }).full_ci, "true");
  assert.equal(runScope({
    compare: releaseNotes,
    stack: { position: 0, size: 2, base: { ref: "zay/main" } },
  }).full_ci, "true");
});