import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECORD_CAP = 64;
const BYTE_CAP = 32768;
const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/;
const UI_CLI_DIRECTORY = /(?:^|\/)(?:ui|cli)\//;
const PROGRESS_INITIAL = "initialized\n";
const PROGRESS_COMPLETE = "first-complete\n";
const PROGRESS_INCOMPLETE = "first-incomplete\n";
const FAILURE_CATEGORIES = new Set(["assertion", "timeout", "module_resolution", "other"]);

function isUiCliTestFile(file) {
  return UI_CLI_DIRECTORY.test(file) && TEST_FILE.test(file);
}

function sourceTestFiles(repoRoot) {
  const tree = execFileSync("git", ["ls-tree", "-rz", "--full-tree", "HEAD"], {
    cwd: repoRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const entries = new TextDecoder("utf-8", { fatal: true }).decode(tree).split("\0");
  const paths = new Set();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    const file = entry.slice(tab + 1);
    if (isUiCliTestFile(file)) paths.add(file);
  }
  return paths;
}

function modulePath(moduleId, repoRoot, allowedPaths, inventoryAvailable) {
  if (!inventoryAvailable || typeof moduleId !== "string" || moduleId.length === 0) return null;
  const absolute = path.resolve(repoRoot, moduleId);
  const relative = path.relative(path.resolve(repoRoot), absolute).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return null;
  return isUiCliTestFile(relative) && allowedPaths.has(relative) ? relative : null;
}

function categoryFor(errors) {
  for (const error of errors ?? []) {
    const name = typeof error?.name === "string" ? error.name : "";
    const code = typeof error?.code === "string" ? error.code : "";
    if (name === "AssertionError" || code === "ERR_ASSERTION") return "assertion";
    if (name === "TimeoutError" || code === "ERR_TEST_TIMEOUT") return "timeout";
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      return "module_resolution";
    }
  }
  return "other";
}

function encode(record) {
  return `${JSON.stringify(record)}\n`;
}

function emptyReport() {
  return {
    schemaVersion: 1,
    complete: false,
    truncated: false,
    counts: { totalTests: 0, failedTests: 0, failedFiles: 0, unattributedFailures: 0 },
    failures: [],
  };
}

function addCount(counts, key, amount = 1) {
  const value = counts[key] + amount;
  if (!Number.isSafeInteger(value) || value < 0) {
    counts[key] = Number.MAX_SAFE_INTEGER;
    return false;
  }
  counts[key] = value;
  return true;
}

function mergeCounts(previous, next) {
  const counts = {};
  let safe = true;
  for (const key of ["totalTests", "failedTests", "failedFiles", "unattributedFailures"]) {
    const value = previous[key] + next[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      counts[key] = Number.MAX_SAFE_INTEGER;
      safe = false;
    } else {
      counts[key] = value;
    }
  }
  return { counts, safe };
}

function boundedRecord(counts, candidates, complete, previouslyTruncated = false, candidatesOverflow = false) {
  const failures = [];
  let truncated = previouslyTruncated || candidatesOverflow || candidates.length > RECORD_CAP;
  const record = { schemaVersion: 1, complete: false, truncated, counts, failures };
  for (const failure of candidates.slice(0, RECORD_CAP)) {
    failures.push(failure);
    if (Buffer.byteLength(encode(record), "utf8") > BYTE_CAP) {
      failures.pop();
      truncated = true;
      break;
    }
  }
  record.truncated = truncated;
  record.complete = complete && !truncated;
  return record;
}

function addFailure(file, line, category, candidates, failedFiles, counts, state) {
  if (!file) {
    if (!addCount(counts, "unattributedFailures")) state.complete = false;
    return;
  }
  failedFiles.add(file);
  if (candidates.length < RECORD_CAP + 1) candidates.push({ file, line, category });
  else state.candidatesOverflow = true;
}

function validTaskState(state) {
  return state === "passed" || state === "failed" || state === "skipped" || state === "pending";
}

function walkTasks(tasks, file, candidates, failedFiles, counts, state) {
  let failureCount = 0;
  for (const task of tasks) {
    if (task.type === "test") {
      if (!addCount(counts, "totalTests")) state.complete = false;
      const result = task.result();
      if (!validTaskState(result.state)) state.complete = false;
      if (result.state === "pending") state.complete = false;
      if (result.state !== "failed") continue;
      if (!addCount(counts, "failedTests")) state.complete = false;
      failureCount += 1;
      const line = Number.isSafeInteger(task.location?.line) && task.location.line > 0
        ? task.location.line
        : null;
      addFailure(file, line, categoryFor(result.errors), candidates, failedFiles, counts, state);
      continue;
    }

    if (task.type !== "suite") {
      state.complete = false;
      continue;
    }

    const suiteState = task.state();
    if (!validTaskState(suiteState)) state.complete = false;
    if (suiteState === "pending") state.complete = false;
    const nestedFailureCount = walkTasks(task.children.array(), file, candidates, failedFiles, counts, state);
    failureCount += nestedFailureCount;
    const suiteErrors = task.errors();
    if (suiteErrors.length > 0) {
      for (const error of suiteErrors) {
        addFailure(file, null, categoryFor([error]), candidates, failedFiles, counts, state);
        failureCount += 1;
      }
    } else if (suiteState === "failed" && nestedFailureCount === 0) {
      addFailure(file, null, "other", candidates, failedFiles, counts, state);
      failureCount += 1;
    }
  }
  return failureCount;
}

export function projectFailureRecords(
  testModules,
  unhandledErrors,
  allowedPaths,
  reason = "passed",
  inventoryAvailable = true,
  repoRoot = process.cwd(),
) {
  const counts = { totalTests: 0, failedTests: 0, failedFiles: 0, unattributedFailures: 0 };
  const candidates = [];
  const failedFiles = new Set();
  const state = { complete: inventoryAvailable && (reason === "passed" || reason === "failed"), candidatesOverflow: false };

  for (const testModule of testModules) {
    const file = modulePath(testModule.moduleId, repoRoot, allowedPaths, inventoryAvailable);
    const moduleState = testModule.state();
    if (moduleState === "pending" || moduleState === "queued") state.complete = false;
    else if (!validTaskState(moduleState)) state.complete = false;

    const nestedFailureCount = walkTasks(
      testModule.children.array(),
      file,
      candidates,
      failedFiles,
      counts,
      state,
    );
    const moduleErrors = testModule.errors();
    let moduleFailureCount = nestedFailureCount;
    if (moduleErrors.length > 0) {
      for (const error of moduleErrors) {
        addFailure(file, null, categoryFor([error]), candidates, failedFiles, counts, state);
        moduleFailureCount += 1;
      }
    } else if (moduleState === "failed" && nestedFailureCount === 0) {
      addFailure(file, null, "other", candidates, failedFiles, counts, state);
      moduleFailureCount += 1;
    }
    if (moduleFailureCount > 0 && file) failedFiles.add(file);
  }

  if (unhandledErrors.length > 0) {
    if (!addCount(counts, "unattributedFailures", unhandledErrors.length)) state.complete = false;
  }
  counts.failedFiles = failedFiles.size;
  if (reason === "failed" && counts.failedTests === 0 && counts.failedFiles === 0 && counts.unattributedFailures === 0) {
    state.complete = false;
  }
  return boundedRecord(counts, candidates, state.complete && counts.unattributedFailures === 0, false, state.candidatesOverflow);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isValidReport(record, allowedPaths) {
  if (!exactKeys(record, ["schemaVersion", "complete", "truncated", "counts", "failures"])) return false;
  if (record.schemaVersion !== 1 || typeof record.complete !== "boolean" || typeof record.truncated !== "boolean") return false;
  if (!exactKeys(record.counts, ["totalTests", "failedTests", "failedFiles", "unattributedFailures"])) return false;
  for (const value of Object.values(record.counts)) {
    if (!Number.isSafeInteger(value) || value < 0) return false;
  }
  if (record.counts.failedTests > record.counts.totalTests) return false;
  if (!Array.isArray(record.failures) || record.failures.length > RECORD_CAP) return false;
  const files = new Set();
  for (const failure of record.failures) {
    if (!exactKeys(failure, ["file", "line", "category"])) return false;
    if (typeof failure.file !== "string" || !isUiCliTestFile(failure.file) || !allowedPaths.has(failure.file)) return false;
    if (failure.line !== null && (!Number.isSafeInteger(failure.line) || failure.line < 1)) return false;
    if (!FAILURE_CATEGORIES.has(failure.category)) return false;
    files.add(failure.file);
  }
  if (record.counts.failedFiles < files.size) return false;
  if (record.complete && (record.truncated || record.counts.unattributedFailures > 0)) return false;
  if (record.complete && (record.counts.failedFiles !== files.size || record.counts.failedTests > record.failures.length)) return false;
  return true;
}

export function mergeFailureRecords(previous, next, allowedPaths, options = {}) {
  const currentValid = isValidReport(next, allowedPaths);
  const previousValid = previous === null || isValidReport(previous, allowedPaths);
  const historyTrusted = options.historyTrusted !== false && currentValid && previousValid;
  const current = currentValid ? next : emptyReport();
  const prior = previousValid && previous !== null ? previous : emptyReport();
  const { counts, safe: countsSafe } = mergeCounts(prior.counts, current.counts);
  const candidates = [...prior.failures, ...current.failures];
  const complete = historyTrusted && options.priorInvocationComplete !== false && options.finalInvocation !== false &&
    current.complete && countsSafe;
  return boundedRecord(
    counts,
    candidates,
    complete,
    historyTrusted && (prior.truncated || current.truncated),
  );
}

function progressPath(outputPath) {
  return `${outputPath}.progress`;
}

function writeReport(outputPath, report) {
  const content = encode(report);
  if (Buffer.byteLength(content, "utf8") > BYTE_CAP) throw new Error("Native UI failure report exceeded its byte cap.");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, outputPath);
}

function writeProgress(outputPath, status) {
  const temporaryPath = `${progressPath(outputPath)}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, status, "utf8");
  renameSync(temporaryPath, progressPath(outputPath));
}

function readReport(outputPath, allowedPaths) {
  try {
    const content = readFileSync(outputPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > BYTE_CAP || !content.endsWith("\n")) return null;
    const report = JSON.parse(content);
    if (encode(report) !== content || !isValidReport(report, allowedPaths)) return null;
    return report;
  } catch {
    return null;
  }
}

function readProgress(outputPath) {
  try {
    return readFileSync(progressPath(outputPath), "utf8");
  } catch {
    return null;
  }
}

function isPristine(report) {
  return report !== null &&
    report.complete === false &&
    report.truncated === false &&
    report.counts.totalTests === 0 &&
    report.counts.failedTests === 0 &&
    report.counts.failedFiles === 0 &&
    report.counts.unattributedFailures === 0 &&
    report.failures.length === 0;
}

export function initializeNativeUiFailureRecords(outputPath) {
  writeReport(outputPath, emptyReport());
  writeProgress(outputPath, PROGRESS_INITIAL);
}

export function createNativeUiFailureReporter(
  outputPath,
  repoRoot = process.cwd(),
  finalInvocation = process.env.NATIVE_UI_FAILURE_RECORDS_FINAL === "true",
) {
  return class NativeUiFailureReporter {
    async onTestRunEnd(testModules, unhandledErrors, reason) {
      if (typeof outputPath !== "string" || outputPath.length === 0) {
        throw new Error("Native UI failure reporter requires an output path.");
      }

      let allowedPaths = new Set();
      let inventoryAvailable = true;
      try {
        allowedPaths = sourceTestFiles(repoRoot);
      } catch {
        inventoryAvailable = false;
      }

      const current = projectFailureRecords(
        testModules,
        unhandledErrors,
        allowedPaths,
        reason,
        inventoryAvailable,
        repoRoot,
      );
      const status = readProgress(outputPath);
      const priorFromFile = readReport(outputPath, allowedPaths);
      let previous = null;
      let historyTrusted = false;
      let priorInvocationComplete = false;

      if (status === PROGRESS_INITIAL) {
        historyTrusted = isPristine(priorFromFile);
        priorInvocationComplete = historyTrusted;
      } else if (status === PROGRESS_COMPLETE || status === PROGRESS_INCOMPLETE) {
        previous = priorFromFile;
        historyTrusted = previous !== null;
        priorInvocationComplete = status === PROGRESS_COMPLETE;
      }

      const report = mergeFailureRecords(previous, current, allowedPaths, {
        historyTrusted,
        priorInvocationComplete,
        finalInvocation,
      });
      writeReport(outputPath, report);

      if (finalInvocation) {
        try {
          unlinkSync(progressPath(outputPath));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      } else {
        const countMerge = mergeCounts(previous?.counts ?? emptyReport().counts, current.counts);
        const invocationComplete = historyTrusted && priorInvocationComplete && current.complete &&
          countMerge.safe && !report.truncated;
        writeProgress(outputPath, invocationComplete ? PROGRESS_COMPLETE : PROGRESS_INCOMPLETE);
      }
    }
  };
}

export default createNativeUiFailureReporter(
  process.env.NATIVE_UI_FAILURE_RECORDS_OUTPUT,
  process.cwd(),
  process.env.NATIVE_UI_FAILURE_RECORDS_FINAL === "true",
);
