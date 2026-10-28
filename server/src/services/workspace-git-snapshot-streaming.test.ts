import { Console } from "node:console";
import { execFile, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { disposeGitWorkspaceSnapshot, readGitWorkspaceSnapshot, runLocalGit, setExpensiveWorkspaceGitExecutor, type GitWorkspaceSnapshot } from "@paperclipai/adapter-utils/git-workspace-sync";
import { isPathManifest, workspacePaths } from "@paperclipai/adapter-utils/workspace-manifest";
import { prepareSandboxManagedRuntime, type PreparedSandboxManagedRuntime, type SandboxManagedRuntimeClient } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { createWorkspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";

enum StreamDiagnosticPhase {
  FixtureReady = "fixture_ready",
  StandaloneUntrackedScan = "standalone_untracked_scan",
  ScheduledUntrackedScan = "scheduled_untracked_scan",
  StageReady = "stage_ready",
  StageAndContentChecks = "stage_and_content_checks",
  SnapshotCleanup = "snapshot_cleanup",
  IgnoredScan = "ignored_scan",
  InitialTrackingCommit = "initial_tracking_commit",
  ChangedFilesWritten = "changed_files_written",
  ChangedScan = "changed_scan",
  FixtureDeletionComplete = "fixture_deletion_complete",
  DeletionScanComplete = "deletion_scan_complete",
}
const exec = promisify(execFile);
async function execute(command: string, args: string[], options: ExecFileOptions = {}): Promise<void> {
  try { await exec(command, args, options); }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    throw new Error(`Fixture command failed: ${String(error)}\n${stderr.slice(-8192)}`, { cause: error });
  }
}

type PostCommandStage = "initial" | "deletion";
type PostCommandOperation = "git_extract" | "overlay_extract" | "delete_paths";
type PostCommandEdge = "enter" | "exit";
type PostCommandOutcome = "pending" | "resolved" | "rejected";

let postCommandConsole: Console | null = null;
try {
  postCommandConsole = new Console({ stdout: process.stderr, stderr: process.stderr, ignoreErrors: true });
} catch { /* Optional diagnostics must not affect fixture execution. */ }
let postCommandRecordCount = 0;
let postCommandByteCount = 0;

function emitPostCommandObservation(
  stage: PostCommandStage,
  operation: PostCommandOperation,
  edge: PostCommandEdge,
  outcome: PostCommandOutcome,
  elapsedMs: number | null,
): void {
  try {
    if (!postCommandConsole || postCommandRecordCount >= 10) return;
    const record = JSON.stringify({ event: "post_command_observation", stage, operation, edge, outcome, elapsedMs });
    const byteLength = Buffer.byteLength(record, "utf8") + 1;
    if (byteLength > 256 || postCommandByteCount + byteLength > 2560) return;
    postCommandRecordCount += 1;
    postCommandByteCount += byteLength;
    postCommandConsole.log(record);
  } catch { /* Optional diagnostics must not affect fixture execution. */ }
}

function readPostCommandClock(): number | null {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : null;
  } catch { return null; }
}

function elapsedPostCommandMs(start: number | null): number | null {
  if (start === null) return null;
  const end = readPostCommandClock();
  if (end === null) return null;
  const rawElapsed = end - start;
  if (!Number.isFinite(rawElapsed) || rawElapsed < 0) return null;
  const elapsed = Math.round(rawElapsed);
  return Number.isSafeInteger(elapsed) ? elapsed : null;
}

function postCommandOperation(stage: PostCommandStage, position: number): PostCommandOperation | null {
  if (position === 0) return "git_extract";
  if (position === 1) return "overlay_extract";
  if (stage === "deletion" && position === 2) return "delete_paths";
  return null;
}
const directories: string[] = [];
const snapshots: GitWorkspaceSnapshot[] = [];
const runtimes: PreparedSandboxManagedRuntime[] = [];
afterEach(async () => {
  setExpensiveWorkspaceGitExecutor(null);
  for (const runtime of runtimes.splice(0)) await runtime.cleanupWorkspaceSnapshot();
  for (const snapshot of snapshots.splice(0)) await disposeGitWorkspaceSnapshot(snapshot);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
}, 60_000);

function localClient(commands: string[], stage: PostCommandStage): SandboxManagedRuntimeClient {
  return {
    makeDir: async (dir) => { await fs.mkdir(dir, { recursive: true }); },
    writeFile: async (file, bytes) => { await fs.writeFile(file, Buffer.from(bytes)); },
    readFile: async (file) => fs.readFile(file),
    listFiles: async (dir) => fs.readdir(dir),
    remove: async (file) => { await fs.rm(file, { recursive: true, force: true }); },
    run: async (command, options) => { await execute("sh", ["-c", command], { timeout: options.timeoutMs }); },
    syncIn: async (operations) => {
      for (const operation of operations) {
        const createdDirectories = new Set<string>();
        for (let start = 0; start < operation.files.length; start += 100) {
          const files = operation.files.slice(start, start + 100);
          const newDirectories = [...new Set(files.map((mapping) => path.dirname(mapping.targetPath)))].filter((dir) => !createdDirectories.has(dir));
          const directoryResults = await Promise.allSettled(newDirectories.map(async (dir) => { await fs.mkdir(dir, { recursive: true }); createdDirectories.add(dir); }));
          const directoryFailure = directoryResults.find((result) => result.status === "rejected");
          if (directoryFailure) throw directoryFailure.reason;
          const copyResults = await Promise.allSettled(files.map((mapping) => fs.copyFile(mapping.sourcePath, mapping.targetPath)));
          const copyFailure = copyResults.find((result) => result.status === "rejected");
          if (copyFailure) throw copyFailure.reason;
        }
        let commandPosition = 0;
        for (const command of operation.postUploadCommands ?? []) {
          const label = postCommandOperation(stage, commandPosition);
          commandPosition += 1;
          commands.push(command.command);
          if (label) emitPostCommandObservation(stage, label, "enter", "pending", null);
          const start = label ? readPostCommandClock() : null;
          try {
            await execute("sh", ["-c", command.command], { maxBuffer: 64 * 1024, timeout: command.timeoutMs });
          } catch (error) {
            if (label) emitPostCommandObservation(stage, label, "exit", "rejected", elapsedPostCommandMs(start));
            throw error;
          }
          if (label) emitPostCommandObservation(stage, label, "exit", "resolved", elapsedPostCommandMs(start));
        }
      }
      return { operations: [] };
    },
  };
}

// macOS adds per-file process and filesystem overhead to the real deletion lane.
const realGitTimeoutMs = process.platform === "darwin" ? 300_000 : 180_000;
it("streams and stages all four real Git filename lanes above 32 MiB through the shared scheduler", async () => {
  const diagnosticStartedAt = performance.now();
  let diagnosticRecordCount = 0;
  let diagnosticBytes = 0;
  const emitDiagnostic = (record: object) => {
    try {
      const line = JSON.stringify(record);
      const bytes = Buffer.byteLength(line) + 1;
      if (diagnosticRecordCount >= 18 || diagnosticBytes + bytes > 4096) return;
      console.log(line);
      diagnosticRecordCount++;
      diagnosticBytes += bytes;
    } catch {
      // Diagnostics must not change the fixture's result or error.
    }
  };
  const observePhase = (phase: StreamDiagnosticPhase) => {
    emitDiagnostic({
      event: "native_stream_bounded_diagnostic",
      phase,
      elapsedMs: Math.floor(performance.now() - diagnosticStartedAt),
    });
  };
  const timeExistingSpan = <T>(stage: "initial" | "deletion", name: string, work: () => Promise<T>): Promise<T> => {
    const span = name === "snapshot.baseline" ? "baseline"
      : name === "pack" ? "pack"
      : name === "stage.workspace" ? "workspace"
      : null;
    if (span === null) return work();
    let startedAt: number | undefined;
    try { startedAt = performance.now(); } catch { /* Optional timing only. */ }
    return (async () => {
      try {
        return await work();
      } finally {
        try {
          if (startedAt !== undefined) {
            const elapsedMs = Math.floor(performance.now() - startedAt);
            if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
              emitDiagnostic({ event: "native_stream_stage_diagnostic", stage, span, elapsedMs });
            }
          }
        } catch {
          // Diagnostic timing must not replace the awaited span's result or error.
        }
      }
    })();
  };
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-stream-git-")));
  directories.push(root);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_EMAIL: "test@example.test" };
  const git = (args: string[]) => runLocalGit(repo, args, { env, timeout: 120_000, maxBuffer: 64 * 1024 });
  await git(["init"]);
  await git(["commit", "--allow-empty", "-qm", "fixture"]);
  // Leave room for the fixture/staging root below macOS's 1,024-byte path
  // limit while keeping each 40,000-name Git lane above the 32 MiB boundary.
  const parent = path.join(repo, ...Array.from({ length: 3 }, () => "nested-".repeat(30)), "storybook-output");
  await fs.mkdir(parent, { recursive: true });
  const shortParent = path.join(root, "generated");
  // Only fixture setup/update/deletion uses this short path. Restore the same
  // directory before every Git, snapshot, transfer and assertion boundary.
  const withShortParent = async (operation: () => Promise<void>) => {
    await fs.rename(parent, shortParent);
    try {
      await operation();
    } catch (error) {
      try {
        await fs.rename(shortParent, parent);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Fixture operation and generated-directory restoration failed");
      }
      throw error;
    }
    await fs.rename(shortParent, parent);
  };
  const fileName = (index: number) => `${"asset-".repeat(36)}${index}.js`;
  const fileContent = Buffer.from("base");
  const changedContent = Buffer.from("changed");
  const contentSource = path.join(root, "file-content");
  const writeFiles = async (content: Buffer) => {
    // Keep the real files independent, but submit one copy instead of a
    // separate open/write/close promise sequence for each tiny payload.
    await fs.writeFile(contentSource, content);
    await withShortParent(async () => {
      for (let start = 0; start < 40_000; start += 100) {
        const results = await Promise.allSettled(Array.from({ length: 100 }, (_, offset) => fs.copyFile(contentSource, path.join(shortParent, fileName(start + offset)))));
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    });
  };
  await writeFiles(fileContent);
  const unusual = [" space ", "line\nbreak", "-option", "雪-💾", "wild[?]*"];
  const unusualWriteResults = await Promise.allSettled(unusual.map((name) => fs.writeFile(path.join(repo, name), name)));
  const unusualWriteFailure = unusualWriteResults.find((result) => result.status === "rejected");
  if (unusualWriteFailure) throw unusualWriteFailure.reason;
  const scheduler = createWorkspaceGitOperationScheduler({ concurrency: 2, queueCapacity: 8 });
  const bindScheduler = () => setExpensiveWorkspaceGitExecutor((input) => scheduler.run({
    workspacePath: input.localDir, args: input.args, operation: input.operation,
    timeoutMs: input.timeout, onStdout: input.onStdout, signal: input.signal, cacheTtlMs: 0,
    maxStdoutBytes: 1, maxStderrBytes: 64 * 1024,
  }));
  observePhase(StreamDiagnosticPhase.FixtureReady);
  const scan = async () => {
    const result = await readGitWorkspaceSnapshot(repo);
    expect(result).not.toBeNull();
    snapshots.push(result!);
    expect(JSON.stringify(result).length).toBeLessThan(4096);
    return result!;
  };
  const checkLargeLane = (paths: GitWorkspaceSnapshot["overlayPaths"]) => {
    let count = 0, bytes = 0;
    for (const relative of workspacePaths(paths)) {
      if (!relative.endsWith(".js")) continue;
      count++;
      bytes += Buffer.byteLength(relative) + 1;
    }
    expect(count).toBe(40_000);
    expect(bytes).toBe(34_988_890);
    expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
  };
  // Standalone callers must use the same streaming semantics.
  setExpensiveWorkspaceGitExecutor(null);
  const standalone = await scan();
  checkLargeLane(standalone.overlayPaths);
  await disposeGitWorkspaceSnapshot(standalone);
  observePhase(StreamDiagnosticPhase.StandaloneUntrackedScan);
  bindScheduler();
  const snapshot = await scan();
  checkLargeLane(snapshot.overlayPaths);
  observePhase(StreamDiagnosticPhase.ScheduledUntrackedScan);
  await fs.writeFile(path.join(parent, "late.js"), "must not stage");
  const commands: string[] = [];
  const remote = path.join(root, "remote");
  const stage = async (gitSnapshot: GitWorkspaceSnapshot, stageLabel: "initial" | "deletion") => {
    const runtime = await prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 120_000, apiKey: null },
      client: localClient(commands, stageLabel), adapterKey: "stream-test", workspaceLocalDir: repo, workspaceGitSnapshot: gitSnapshot,
      runtimeSpan: (name, work) => timeExistingSpan(stageLabel, name, work),
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = await stage(snapshot, "initial");
  observePhase(StreamDiagnosticPhase.StageReady);
  const remoteParent = path.join(remote, path.relative(repo, parent));
  const shortRemoteParent = path.join(root, "staged-check");
  const checkStagedFiles = async () => {
    await fs.rename(remoteParent, shortRemoteParent);
    try {
      let stagedCount = 0;
      let stagedBatch: string[] = [];
      const checkStagedBatch = async () => {
        const results = await Promise.allSettled(stagedBatch.map((name) => fs.readFile(path.join(shortRemoteParent, name))));
        for (let index = 0; index < results.length; index++) {
          const result = results[index]!;
          if (result.status === "rejected") throw result.reason;
          if (!result.value.equals(fileContent)) throw new Error(`Staged file has unexpected content: ${stagedBatch[index]}`);
        }
        stagedCount += stagedBatch.length;
        stagedBatch = [];
      };
      for await (const entry of await fs.opendir(shortRemoteParent)) {
        stagedBatch.push(entry.name);
        if (stagedBatch.length === 100) await checkStagedBatch();
      }
      if (stagedBatch.length > 0) await checkStagedBatch();
      expect(stagedCount).toBe(40_000);
    } catch (error) {
      try {
        await fs.rename(shortRemoteParent, remoteParent);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Staged-file assertion and remote-directory restoration failed");
      }
      throw error;
    }
    await fs.rename(shortRemoteParent, remoteParent);
  };
  await checkStagedFiles();
  const unusualReadResults = await Promise.allSettled(unusual.map((name) => fs.readFile(path.join(remote, name), "utf8")));
  for (let index = 0; index < unusualReadResults.length; index++) {
    const result = unusualReadResults[index]!;
    if (result.status === "rejected") throw result.reason;
    expect(result.value).toBe(unusual[index]);
  }
  observePhase(StreamDiagnosticPhase.StageAndContentChecks);
  const manifestFile = isPathManifest(snapshot.overlayPaths) ? snapshot.overlayPaths.filePath : "";
  await runtime.cleanupWorkspaceSnapshot();
  await expect(fs.stat(manifestFile)).rejects.toMatchObject({ code: "ENOENT" });
  observePhase(StreamDiagnosticPhase.SnapshotCleanup);
  await fs.rm(path.join(parent, "late.js"));

  await fs.writeFile(path.join(repo, ".gitignore"), "*.js\n");
  const ignored = await scan();
  checkLargeLane(ignored.ignoredPaths);
  await disposeGitWorkspaceSnapshot(ignored);
  observePhase(StreamDiagnosticPhase.IgnoredScan);
  await fs.rm(path.join(repo, ".gitignore"));
  await git(["add", "--", "."]);
  await git(["commit", "-qm", "track generated files"]);
  observePhase(StreamDiagnosticPhase.InitialTrackingCommit);
  await writeFiles(changedContent);
  observePhase(StreamDiagnosticPhase.ChangedFilesWritten);
  const changed = await scan();
  checkLargeLane(changed.overlayPaths);
  await disposeGitWorkspaceSnapshot(changed);
  observePhase(StreamDiagnosticPhase.ChangedScan);
  // The generated names are already known; avoid recursively rediscovering
  // and statting every file, or traversing the long parents for each unlink.
  await withShortParent(async () => {
    for (let start = 0; start < 40_000; start += 100) {
      const results = await Promise.allSettled(Array.from({ length: 100 }, (_, offset) => fs.unlink(path.join(shortParent, fileName(start + offset)))));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }
  });
  await fs.rmdir(parent);
  observePhase(StreamDiagnosticPhase.FixtureDeletionComplete);
  const deleted = await scan();
  checkLargeLane(deleted.deletedPaths);
  await stage(deleted, "deletion");
  let remaining = 0;
  for await (const _entry of await fs.opendir(remoteParent)) remaining++;
  expect(remaining).toBe(0);
  expect(commands.every((command) => command.length < 16 * 1024)).toBe(true);
  expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, inFlightCount: 0, cacheBytes: 0 });
  observePhase(StreamDiagnosticPhase.DeletionScanComplete);
}, realGitTimeoutMs);
