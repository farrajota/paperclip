import assert from "node:assert/strict";
import test from "node:test";
import { mergeFailureRecords, projectFailureRecords } from "./native-ui-failure-reporter.mjs";

const tracked = new Set([
  "packages/ui/src/panel.test.ts",
  "packages/ui/src/import.test.ts",
  "packages/cli/src/command.test.ts",
  "packages/server/src/server.test.ts",
]);
const error = (name, code) => ({
  name,
  code,
  message: "private-error-message",
  stack: "private-stack",
  id: "private-error-id",
});
const testCase = (state, line, errors = []) => ({
  type: "test",
  name: "private-test-title",
  location: line === null ? undefined : { line, column: 1 },
  result: () => ({ state, errors }),
});
const suite = (children, state = "passed", errors = []) => ({
  type: "suite",
  children: { array: () => children },
  state: () => state,
  errors: () => errors,
});
const module = (moduleId, children = [], state = "passed", errors = []) => ({
  type: "module",
  moduleId,
  children: { array: () => children },
  state: () => state,
  errors: () => errors,
});

test("projects nested failed tests to verified paths, source lines, and fixed categories", () => {
  const record = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", [
      suite([
        testCase("failed", 12, [error("AssertionError", "ERR_ASSERTION")]),
        suite([testCase("failed", 27, [error("TimeoutError")])]),
        testCase("failed", null, [error("Error", "ERR_MODULE_NOT_FOUND")]),
        testCase("failed", 0, [error("Error")]),
        testCase("passed", 38),
      ]),
    ], "failed"),
  ], [], tracked, "failed", true, "/repo");

  assert.deepEqual(record, {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    counts: { totalTests: 5, failedTests: 4, failedFiles: 1, unattributedFailures: 0 },
    failures: [
      { file: "packages/ui/src/panel.test.ts", line: 12, category: "assertion" },
      { file: "packages/ui/src/panel.test.ts", line: 27, category: "timeout" },
      { file: "packages/ui/src/panel.test.ts", line: null, category: "module_resolution" },
      { file: "packages/ui/src/panel.test.ts", line: null, category: "other" },
    ],
  });
  const json = JSON.stringify(record);
  for (const privateValue of ["private-test-title", "private-error-message", "private-stack", "private-error-id"]) {
    assert.equal(json.includes(privateValue), false);
  }
});

test("rejects untracked, out-of-scope, and traversal locations without leaking paths", () => {
  const record = projectFailureRecords([
    module("/repo/packages/server/src/server.test.ts", [testCase("failed", 9)]),
    module("/repo/not-tracked/packages/ui/src/private.test.ts", [testCase("failed", 2)]),
    module("/outside/packages/ui/src/panel.test.ts", [testCase("failed", 3)]),
  ], [], tracked, "failed", true, "/repo");

  assert.equal(record.counts.failedTests, 3);
  assert.equal(record.counts.failedFiles, 0);
  assert.equal(record.counts.unattributedFailures, 3);
  assert.deepEqual(record.failures, []);
  const json = JSON.stringify(record);
  for (const privatePath of ["server.test.ts", "private.test.ts", "outside"]) assert.equal(json.includes(privatePath), false);
});

test("counts module and nested-suite failures even when their child tests passed", () => {
  const record = projectFailureRecords([
    module("/repo/packages/ui/src/import.test.ts", [
      suite([testCase("passed", 5)], "failed", [error("AssertionError", "ERR_ASSERTION")]),
      testCase("passed", 10),
    ], "failed", [error("Error", "ERR_MODULE_NOT_FOUND")]),
    module("/repo/packages/cli/src/command.test.ts", [testCase("passed", 3)], "failed"),
  ], [], tracked, "failed", true, "/repo");

  assert.deepEqual(record.counts, {
    totalTests: 3,
    failedTests: 0,
    failedFiles: 2,
    unattributedFailures: 0,
  });
  assert.deepEqual(record.failures, [
    { file: "packages/ui/src/import.test.ts", line: null, category: "assertion" },
    { file: "packages/ui/src/import.test.ts", line: null, category: "module_resolution" },
    { file: "packages/cli/src/command.test.ts", line: null, category: "other" },
  ]);
  assert.equal(record.complete, true);
});

test("counts module-import and unhandled failures without inventing locations", () => {
  const record = projectFailureRecords(
    [module("/repo/packages/ui/src/import.test.ts", [], "failed", [error("Error", "ERR_MODULE_NOT_FOUND")])],
    [error("Error", "ERR_MODULE_NOT_FOUND"), error("Error")],
    tracked,
    "failed",
    true,
    "/repo",
  );

  assert.deepEqual(record.counts, {
    totalTests: 0,
    failedTests: 0,
    failedFiles: 1,
    unattributedFailures: 2,
  });
  assert.deepEqual(record.failures, [
    { file: "packages/ui/src/import.test.ts", line: null, category: "module_resolution" },
  ]);
  assert.equal(record.complete, false);
});

test("does not turn an unexplained failed run into a complete zero-failure report", () => {
  const record = projectFailureRecords([], [], tracked, "failed", true, "/repo");
  assert.equal(record.counts.failedTests, 0);
  assert.equal(record.counts.unattributedFailures, 0);
  assert.equal(record.complete, false);
});

test("marks pending, interrupted, unattributed, and unavailable-inventory reports incomplete", () => {
  const pending = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", [testCase("pending", null)]),
  ], [], tracked, "passed", true, "/repo");
  assert.equal(pending.counts.totalTests, 1);
  assert.equal(pending.complete, false);

  const interrupted = projectFailureRecords([], [], tracked, "interrupted", true, "/repo");
  assert.equal(interrupted.complete, false);

  const missingInventory = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", [testCase("failed", 4)]),
  ], [], new Set(), "failed", false, "/repo");
  assert.equal(missingInventory.counts.unattributedFailures, 1);
  assert.deepEqual(missingInventory.failures, []);
  assert.equal(missingInventory.complete, false);
});

test("caps records and marks the bounded report incomplete", () => {
  const record = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", Array.from({ length: 70 }, (_, index) => testCase("failed", index + 1))),
  ], [], tracked, "failed", true, "/repo");

  assert.equal(record.counts.failedTests, 70);
  assert.equal(record.failures.length, 64);
  assert.equal(record.truncated, true);
  assert.equal(record.complete, false);
  assert.ok(Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8") <= 32768);
});

test("caps the complete newline-terminated UTF-8 report by bytes", () => {
  const file = `packages/ui/${"é".repeat(500)}.test.ts`;
  const record = projectFailureRecords([
    module(`/repo/${file}`, Array.from({ length: 64 }, () => testCase("failed", null))),
  ], [], new Set([file]), "failed", true, "/repo");

  const bytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
  assert.ok(record.failures.length < 64);
  assert.equal(record.truncated, true);
  assert.equal(record.complete, false);
  assert.ok(bytes <= 32768);
});

test("keeps multi-project completeness false until the final invocation finishes", () => {
  const ui = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", [testCase("passed", 12)]),
  ], [], tracked, "passed", true, "/repo");
  const firstInvocation = mergeFailureRecords(null, ui, tracked, {
    historyTrusted: true,
    priorInvocationComplete: true,
    finalInvocation: false,
  });
  assert.equal(firstInvocation.complete, false);

  const cli = projectFailureRecords([
    module("/repo/packages/cli/src/command.test.ts", [testCase("passed", 8)]),
  ], [], tracked, "passed", true, "/repo");
  const finalReport = mergeFailureRecords(firstInvocation, cli, tracked, {
    historyTrusted: true,
    priorInvocationComplete: true,
    finalInvocation: true,
  });
  assert.deepEqual(finalReport.counts, {
    totalTests: 2,
    failedTests: 0,
    failedFiles: 0,
    unattributedFailures: 0,
  });
  assert.equal(finalReport.complete, true);
});

test("keeps earlier incomplete and truncated evidence sticky across project aggregation", () => {
  const incomplete = projectFailureRecords([
    module("/repo/packages/ui/src/panel.test.ts", [testCase("pending", null)]),
  ], [], tracked, "passed", true, "/repo");
  const first = mergeFailureRecords(null, incomplete, tracked, {
    historyTrusted: true,
    priorInvocationComplete: true,
    finalInvocation: false,
  });
  const current = projectFailureRecords([], [], tracked, "passed", true, "/repo");
  const finalAfterIncomplete = mergeFailureRecords(first, current, tracked, {
    historyTrusted: true,
    priorInvocationComplete: false,
    finalInvocation: true,
  });
  assert.equal(finalAfterIncomplete.complete, false);

  const truncated = {
    schemaVersion: 1,
    complete: false,
    truncated: true,
    counts: { totalTests: 0, failedTests: 0, failedFiles: 0, unattributedFailures: 0 },
    failures: [],
  };
  const finalAfterTruncation = mergeFailureRecords(truncated, current, tracked, {
    historyTrusted: true,
    priorInvocationComplete: false,
    finalInvocation: true,
  });
  assert.equal(finalAfterTruncation.truncated, true);
  assert.equal(finalAfterTruncation.complete, false);
});

test("does not carry unvalidated prior fields or paths into aggregate output", () => {
  const prior = {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    counts: { totalTests: 0, failedTests: 0, failedFiles: 0, unattributedFailures: 0 },
    failures: [{ file: "packages/server/src/server.test.ts", line: 2, category: "other" }],
    title: "private-test-title",
  };
  const current = projectFailureRecords([], [], tracked, "passed", true, "/repo");
  const merged = mergeFailureRecords(prior, current, tracked, {
    historyTrusted: false,
    priorInvocationComplete: false,
    finalInvocation: true,
  });

  assert.deepEqual(merged.counts, current.counts);
  assert.deepEqual(merged.failures, []);
  assert.equal(merged.complete, false);
  assert.equal(JSON.stringify(merged).includes("private-test-title"), false);
});
