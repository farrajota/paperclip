import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import { promises as fsPromises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";
import {
  captureDirectorySnapshot,
  directorySnapshotSha256,
  disposeDirectorySnapshot,
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  mergeDirectoryWithBaseline,
  parseDirectorySnapshot,
  serializeDirectorySnapshot,
  withDirectoryMergeLock,
  WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
  type DirectorySnapshot,
} from "./workspace-restore-merge.js";

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("round-trips a deterministic durable snapshot and rejects traversal", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-snapshot-"),
    );
    cleanupDirs.push(rootDir);
    await mkdir(path.join(rootDir, "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "b.txt"), "bravo\n", "utf8");
    await writeFile(path.join(rootDir, "nested", "a.txt"), "alpha\n", "utf8");

    const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });
    const serialized = serializeDirectorySnapshot(snapshot);
    if (serialized.version !== 1) throw new Error("Expected legacy in-memory snapshot");
    const restored = parseDirectorySnapshot(serialized);

    expect(serialized.entries.map(([relativePath]) => relativePath)).toEqual([
      "b.txt",
      "nested",
      "nested/a.txt",
    ]);
    expect(restored).not.toBeNull();
    expect(directorySnapshotSha256(restored!)).toBe(
      directorySnapshotSha256(snapshot),
    );
    expect(
      parseDirectorySnapshot({
        ...serialized,
        entries: [["../escape", serialized.entries[0]![1]]],
      }),
    ).toBeNull();
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it("preserves a host file replacing a deleted baseline directory and continues the restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-conflict-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const sourceDir = path.join(rootDir, "source");
    await mkdir(path.join(targetDir, "replaced", "nested"), { recursive: true });
    await mkdir(sourceDir);
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [], diskBacked: true });
    try {
      await rm(path.join(targetDir, "replaced"), { recursive: true });
      await writeFile(path.join(targetDir, "replaced"), "host change");
      await writeFile(path.join(sourceDir, "other.txt"), "sandbox change");
      await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
      expect(await readFile(path.join(targetDir, "replaced"), "utf8")).toBe("host change");
      expect(await readFile(path.join(targetDir, "other.txt"), "utf8")).toBe("sandbox change");
    } finally { await disposeDirectorySnapshot(baseline); }
  });

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hashes bytes appended after lstat beyond the small-file stream threshold", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-growth-"));
    const filePath = path.join(rootDir, "small-at-lstat.txt");
    const original = "tiny";
    const grown = "g".repeat(64 * 1024);
    await writeFile(filePath, original, "utf8");

    const realLstat = fsPromises.lstat;
    const lstatSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (observedPath) => {
      const stats = await realLstat(observedPath);
      if (observedPath === filePath) await fsPromises.appendFile(filePath, grown, "utf8");
      return stats;
    });
    let snapshot: DirectorySnapshot | null = null;
    try {
      snapshot = await captureDirectorySnapshot(rootDir, { exclude: [], diskBacked: true });
      expect(snapshot.entries.get("small-at-lstat.txt")).toEqual({
        kind: "file",
        mode: (await realLstat(filePath)).mode,
        hash: createHash("sha256").update(original + grown).digest("hex"),
      });
    } finally {
      lstatSpy.mockRestore();
      await disposeDirectorySnapshot(snapshot);
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  it("settles earlier file hashes before reporting a later discovery failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-settlement-"));
    cleanupDirs.push(rootDir);
    await writeFile(path.join(rootDir, "first.txt"), "first", "utf8");
    await writeFile(path.join(rootDir, "second.txt"), "second", "utf8");

    const hashError = new Error("earlier hash failed");
    const discoveryError = new Error("later entry could not be inspected");
    let firstFilePath: string | undefined;
    let closeStarted!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => { closeStarted = resolve; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const failedHandle = {
      read: async () => { throw hashError; },
      close: async () => { closeStarted(); await closeGate; },
    } as unknown as FileHandle;

    const realLstat = fsPromises.lstat;
    const lstatSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (observedPath) => {
      const stats = await realLstat(observedPath);
      if (typeof observedPath === "string" && path.dirname(observedPath) === rootDir && stats.isFile()) {
        if (firstFilePath) throw discoveryError;
        firstFilePath = observedPath;
      }
      return stats;
    });
    const realOpen = fsPromises.open;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation((observedPath, flags, mode) => {
      if (observedPath === firstFilePath) return Promise.resolve(failedHandle);
      return realOpen(observedPath, flags, mode);
    });

    const capture = captureDirectorySnapshot(rootDir, { exclude: [] });
    let settled = false;
    void capture.then(() => { settled = true; }, () => { settled = true; });
    try {
      await closeStartedPromise;
      expect(settled).toBe(false);
      releaseClose();
      await expect(capture).rejects.toBe(hashError);
    } finally {
      releaseClose();
      openSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it("waits for pending small-file closes before rolling back a disk-backed snapshot after writer failure", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-pending-tail-"));
    cleanupDirs.push(rootDir);
    const directoryNames = ["a".repeat(220), "b".repeat(220), "c".repeat(220)];
    const directory = path.join(rootDir, ...directoryNames);
    await mkdir(directory, { recursive: true });

    const fileName = (index: number) => `f${String(index).padStart(4, "0")}${"x".repeat(215)}`;
    let directoryRelative = "";
    const directoryRelativePaths: string[] = [];
    for (const name of directoryNames) {
      directoryRelative = directoryRelative ? path.posix.join(directoryRelative, name) : name;
      directoryRelativePaths.push(directoryRelative);
    }
    const firstFilePath = path.join(directory, fileName(0));
    await writeFile(firstFilePath, "");
    const mode = (await lstat(firstFilePath)).mode;
    const directoryRecordBytes = directoryRelativePaths.reduce(
      (total, relative) => total + Buffer.byteLength(relative) + Buffer.byteLength(JSON.stringify({ kind: "dir" })),
      0,
    );
    const fileRelative = path.posix.join(directoryRelative, fileName(0));
    const fileRecordBytes = Buffer.byteLength(fileRelative)
      + Buffer.byteLength(JSON.stringify({ kind: "file", mode, hash: "0".repeat(64) }));
    // Match the manifest writer's reserve-check interval without adding a test hook.
    const diskCheckIntervalBytes = 1024 * 1024;
    const failingRecordIndex = Math.ceil((diskCheckIntervalBytes - directoryRecordBytes) / fileRecordBytes);
    const fileCount = failingRecordIndex + 3;
    for (let index = 1; index < fileCount; index += 1) {
      await writeFile(path.join(directory, fileName(index)), "");
    }

    const reserveBytes = 256 * 1024 * 1024;
    const available = nodeFs.statfsSync(os.tmpdir(), { bigint: true });
    const healthyCapacity = {
      ...available,
      bsize: 1n,
      bavail: BigInt(reserveBytes) + 16n * 1024n * 1024n,
    };
    vi.stubEnv("PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES", String(reserveBytes));

    let resolveReserveFailure!: () => void;
    const reserveFailureObserved = new Promise<void>((resolve) => { resolveReserveFailure = resolve; });
    let initialCapacityCheck = true;
    const statfsSpy = vi.spyOn(nodeFs, "statfsSync").mockImplementation(() => {
      if (initialCapacityCheck) {
        initialCapacityCheck = false;
        return healthyCapacity as never;
      }
      resolveReserveFailure();
      return { ...healthyCapacity, bavail: 0n } as never;
    });

    let manifestDirectory: string | undefined;
    const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
    const mkdtempSpy = vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (prefix, options) => {
      const created = await realMkdtemp(prefix, options);
      manifestDirectory = String(created);
      return created;
    });

    let resolveTailClosesStarted!: () => void;
    const tailClosesStarted = new Promise<void>((resolve) => { resolveTailClosesStarted = resolve; });
    let releaseTailClose!: () => void;
    const tailCloseGate = new Promise<void>((resolve) => { releaseTailClose = resolve; });
    let tailCloseStartedCount = 0;
    let tailCloseFinishedCount = 0;
    const realOpen = fsPromises.open;
    let openedFileCount = 0;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation((observedPath, flags, openMode) => {
      const openIndex = ++openedFileCount;
      return realOpen(observedPath, flags, openMode).then((file) => {
        if (openIndex <= failingRecordIndex || openIndex > failingRecordIndex + 3) return file;
        return {
          read: file.read.bind(file),
          close: async () => {
            tailCloseStartedCount += 1;
            if (tailCloseStartedCount === 3) resolveTailClosesStarted();
            await tailCloseGate;
            await file.close();
            tailCloseFinishedCount += 1;
          },
        } as unknown as FileHandle;
      });
    });

    const manifestRemovals: string[] = [];
    let removalBeforeTailCloses = false;
    const realRm = fsPromises.rm.bind(fsPromises);
    const rmSpy = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === manifestDirectory) {
        manifestRemovals.push(String(target));
        if (tailCloseFinishedCount !== 3) removalBeforeTailCloses = true;
      }
      await realRm(target, options);
    });

    let publishedSnapshot: DirectorySnapshot | null = null;
    const capture = captureDirectorySnapshot(rootDir, { exclude: [], diskBacked: true }).then((snapshot) => {
      publishedSnapshot = snapshot;
      return snapshot;
    });
    let captureSettled = false;
    void capture.then(() => { captureSettled = true; }, () => { captureSettled = true; });

    try {
      const observation = await Promise.race([
        Promise.all([reserveFailureObserved, tailClosesStarted]).then(() => "writer-failed-with-tail-pending" as const),
        capture.then(() => "capture-settled" as const, () => "capture-settled" as const),
      ]);
      expect(observation).toBe("writer-failed-with-tail-pending");
      expect(captureSettled).toBe(false);
      expect(manifestRemovals).toEqual([]);

      releaseTailClose();
      let captureError: unknown;
      try {
        await capture;
      } catch (error) {
        captureError = error;
      }
      expect(captureError).toMatchObject({
        code: "workspace_git_scan_failed",
        message: "Workspace manifest storage is below its free-space reserve",
      });
      expect(publishedSnapshot).toBeNull();
      expect(tailCloseFinishedCount).toBe(3);
      expect(removalBeforeTailCloses).toBe(false);
      expect(manifestRemovals).toEqual([manifestDirectory]);
      await expect(stat(manifestDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseTailClose();
      await capture.catch(() => undefined);
      rmSpy.mockRestore();
      openSpy.mockRestore();
      mkdtempSpy.mockRestore();
      statfsSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  describe("classifyWorkspaceRestoreFailure", () => {
    it.each([
      "Daytona syncOut refusing tarball with an unparseable entry listing: private listing",
      "Daytona syncOut refusing unparseable or ambiguous symlink entry: private listing",
      "Daytona syncOut refusing unparseable or ambiguous hardlink entry: private listing",
      "Daytona syncOut refusing tarball member that escapes the extraction dir: ../private",
      "Daytona syncOut refusing tarball link whose target escapes the extraction dir: link -> /private",
      "Daytona sync source path is not a confined absolute path: ../private",
      "Daytona sync source path escapes the workspace remote dir: /private",
      ...[40, 41, 42, 44, 45].map((code) => `Daytona outbound symlink-escape guard command failed (exit ${code}): private detail`),
    ])("holds the deterministic confinement refusal: %s", (message) => {
      expect(classifyWorkspaceRestoreFailure(new Error(message))).toBe("restore_unsafe_archive");
      expect(describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(new Error(message)))).not.toContain("private");
    });

    it("preserves the generic policy for other outbound command failures", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("Daytona outbound symlink-escape guard command failed (exit 1): transport failed"))).toBe("restore_failed");
    });

    it("maps an EACCES error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("permission denied");
      error.code = "EACCES";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps an EPERM error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("operation not permitted");
      error.code = "EPERM";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps the lock-timeout code to restore_lock_timeout", () => {
      const error: NodeJS.ErrnoException = new Error("Timed out waiting for workspace restore lock at /some/path");
      error.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_lock_timeout");
    });

    it("maps an unrecognized error, a string, and null to the default restore_failed code", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("some other failure"))).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure("a plain string")).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure(null)).toBe("restore_failed");
    });
  });

  describe("describeWorkspaceRestoreFailure", () => {
    it("returns one fixed diagnostic line per allowlisted code, and no other text", () => {
      expect(describeWorkspaceRestoreFailure("restore_permission_denied")).toBe(
        "the restore could not write to the workspace (permission denied)",
      );
      expect(describeWorkspaceRestoreFailure("restore_lock_timeout")).toBe(
        "the restore timed out waiting for the workspace merge lock",
      );
      expect(describeWorkspaceRestoreFailure("restore_failed")).toBe("the restore failed");
    });

    it("never reflects a sentinel host path or process id, however the caught error is classified", () => {
      const sentinelPath = "/srv/telemetry-backend";
      const sentinelPid = String(process.pid);
      const error: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, mkdir '${sentinelPath}.paperclip-restore.lock' (pid ${sentinelPid})`,
      );
      error.code = "EACCES";

      const line = describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(error));

      expect(line).not.toContain(sentinelPath);
      expect(line).not.toContain(sentinelPid);
      expect(line).not.toContain(error.message);
    });
  });

  describe("instance-scoped directory merge lock", () => {
    // Points PAPERCLIP_HOME (and, where noted, PAPERCLIP_INSTANCE_ID) at a
    // temporary directory so the lock root never touches the real Paperclip
    // instance, then restores the previous values. Mirrors the save-and-restore
    // pattern in acpx-engine/execute.test.ts.
    let previousHome: string | undefined;
    let previousInstanceId: string | undefined;

    function useTempPaperclipHome(homeDir: string, instanceId: string): void {
      previousHome = process.env.PAPERCLIP_HOME;
      previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    }

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      previousHome = undefined;
      previousInstanceId = undefined;
    });

    it.skipIf(process.platform === "win32")(
      "restores successfully when the parent directory of the target is not writable",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        // The old lock sat beside the target, so it needed mkdir rights in the
        // target's parent. The new lock root lives under PAPERCLIP_HOME instead,
        // so a read-only parent must no longer block a restore.
        const readOnlyParent = path.join(rootDir, "read-only-parent");
        const targetDir = path.join(readOnlyParent, "target");
        const sourceDir = path.join(rootDir, "source");
        await mkdir(targetDir, { recursive: true });
        await mkdir(sourceDir, { recursive: true });

        const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
        await writeFile(path.join(sourceDir, "new-file.md"), "new content\n", "utf8");

        await chmod(readOnlyParent, 0o500);
        try {
          await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
        } finally {
          // Restore write access so the outer afterEach can remove rootDir.
          await chmod(readOnlyParent, 0o700).catch(() => undefined);
        }

        await expect(readFile(path.join(targetDir, "new-file.md"), "utf8")).resolves.toBe("new content\n");
      },
    );

    it.skipIf(process.platform === "win32")(
      "acquires the same lock for two alias paths that resolve to one canonical target",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        const paperclipHome = path.join(rootDir, "paperclip-home");
        useTempPaperclipHome(paperclipHome, "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");

        let lockNameViaTarget = "";
        await withDirectoryMergeLock(targetDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaTarget = entries[0] ?? "";
        });

        let lockNameViaAlias = "";
        await withDirectoryMergeLock(aliasDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaAlias = entries[0] ?? "";
        });

        expect(lockNameViaTarget).not.toBe("");
        expect(lockNameViaAlias).toBe(lockNameViaTarget);
      },
    );

    it("rejects a lock root that already exists as a symlink", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(locksDir, { recursive: true });
      await mkdir(decoyDir, { recursive: true });
      await symlink(decoyDir, path.join(locksDir, "directory-merge"));

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("rejects a lock root that already exists as a non-directory", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(path.join(locksDir, "directory-merge"), "not a directory\n", "utf8");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("closes the create/validate TOCTOU window: rejects a lock root a racing writer swapped for a symlink during creation", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(decoyDir, { recursive: true });
      // Pre-create the lock root's parent, so the mock below only has to
      // reproduce what `fs.mkdir({ recursive: true })` does to the leaf path.
      await mkdir(path.join(paperclipHome, "instances", "test-instance", "locks"), { recursive: true });

      // Real `fs.mkdir({ recursive: true })` does not fail on a leaf that
      // already exists as a symlink to a real directory. This stub reproduces
      // exactly that: it plants a symlink to the attacker-controlled decoy
      // directory in the window between the resolver's own "does the root
      // exist yet" check and its own `mkdir` call, then resolves the way a
      // real `mkdir` would (silently) — proving the resolver must validate
      // what `mkdir` actually left behind, not trust that the call resolved.
      const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementationOnce(async (dirPath) => {
        await symlink(decoyDir, dirPath as string);
        return undefined;
      });

      try {
        await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
          /not a plain directory/,
        );
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it("keeps the private lock database and removes diagnostic ownership after release", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      let entriesDuringLock: string[] = [];
      await withDirectoryMergeLock(targetDir, async () => {
        entriesDuringLock = await readdir(lockRootDir);
      });

      expect((await stat(lockRootDir)).mode & 0o777).toBe(0o700);
      expect(entriesDuringLock.filter((name) => name.endsWith(".owner.json"))).toHaveLength(1);
      const entriesAfterRelease = await readdir(lockRootDir);
      expect(entriesAfterRelease).toHaveLength(1);
      expect(entriesAfterRelease[0]).toMatch(/\.lock\.sqlite$/);
      expect((await stat(path.join(lockRootDir, entriesAfterRelease[0]!))).mode & 0o777).toBe(0o600);
    });

    it("classifies the real lock-timeout error by its stable code, never by the message text", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      // Pre-create the lock directory a live process holds, so `isLockStale`
      // never reports it stale and the retry loop can only leave through the
      // deadline check. The owner pid is this test process, which stays alive.
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      const heldLockDir = path.join(lockRootDir, `${lockKey}.lock`);
      await mkdir(heldLockDir, { recursive: true });
      await writeFile(
        path.join(heldLockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );

      // Reach the real deadline without a real 30-second wait: the first
      // `Date.now()` call computes the deadline (unchanged), and every call
      // after reports a time far past it, so the retry loop's own deadline
      // check — not a mocked message or a shortened constant — throws.
      const realNow = Date.now();
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementationOnce(() => realNow)
        .mockImplementation(() => Number.MAX_SAFE_INTEGER);
      let caughtError: NodeJS.ErrnoException | undefined;
      try {
        await withDirectoryMergeLock(targetDir, async () => undefined);
      } catch (error) {
        caughtError = error as NodeJS.ErrnoException;
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.code).toBe(WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE);
      // The classifier reads only `code`; prove the message text carries no
      // trace of the classified outcome, so a message-text match could not
      // have produced this result.
      expect(caughtError?.message).not.toContain("restore_lock_timeout");
      expect(classifyWorkspaceRestoreFailure(caughtError)).toBe("restore_lock_timeout");
      expect(caughtError).toMatchObject({ workspaceRestoreLock: {
        ownerState: "alive", ownerSameProcess: true, knownLocalHolder: false,
      } });
    });

    it("reports a known live holder without releasing it when a contender times out", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-holder-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockRoot = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge");
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        try {
          await expect(withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
              knownLocalHolder: true, ownerPredatesProcess: false, operation: "agent_directory_release" },
          });
        } finally { clock.mockRestore(); }
        expect(contender).not.toHaveBeenCalled();
        expect((await readdir(lockRoot)).filter((name) => name.endsWith(".owner.json"))).toHaveLength(1);
      });
      expect(await readdir(lockRoot)).toEqual([expect.stringMatching(/\.lock\.sqlite$/)]);
    });

    it("delivers the timeout when the diagnostic owner read stalls and ignores its late rejection", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-stall-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        let markReadStarted!: (signal: AbortSignal) => void;
        const readStarted = new Promise<AbortSignal>((resolve) => { markReadStarted = resolve; });
        let rejectStalledRead!: (error: Error) => void;
        const stalledRead = new Promise<string>((_resolve, reject) => { rejectStalledRead = reject; });
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation((file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            markReadStarted(options.signal);
            return stalledRead;
          });
        try {
          const pending = withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")
            .catch((error: unknown) => error);
          const signal = await readStarted;
          await vi.advanceTimersByTimeAsync(100);
          const error = await pending;
          expect(error).toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "unknown", knownLocalHolder: true,
              operation: "agent_directory_release" },
          });
          expect(signal.aborted).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
          rejectStalledRead(new Error("late filesystem failure"));
          await Promise.resolve();
          expect(contender).not.toHaveBeenCalled();
          expect(error).toMatchObject({ workspaceRestoreLock: { ownerState: "unknown" } });
        } finally {
          vi.useRealTimers();
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it.each([
      { label: "malformed JSON", raw: "{invalid-json", code: undefined, ownerState: "invalid" },
      { label: "a missing file", raw: undefined, code: "ENOENT", ownerState: "missing" },
      { label: "an unreadable file", raw: undefined, code: "EACCES", ownerState: "unknown" },
    ])("distinguishes $label in the diagnostic read", async ({ raw, code, ownerState }) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-state-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation(async (file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            if (code) throw Object.assign(new Error("owner read failed"), { code });
            return raw!;
          });
        try {
          await expect(withDirectoryMergeLock(targetDir, contender)).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState, knownLocalHolder: true },
          });
          expect(contender).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it("reports an owner older than this process without reclaiming a live PID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-older-owner-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockKey = createHash("sha256").update(await realpath(targetDir)).digest("hex");
      const lockDir = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge", `${lockKey}.lock`);
      await mkdir(lockDir, { recursive: true });
      const now = Date.now();
      const owner = JSON.stringify({ pid: process.pid, createdAt: new Date(now - process.uptime() * 1000 - 10_000).toISOString(), private: "private owner payload" });
      await writeFile(path.join(lockDir, "owner.json"), owner);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now)
        .mockReturnValueOnce(now).mockReturnValueOnce(now + 30_001);
      let caught: unknown;
      try { await withDirectoryMergeLock(targetDir, async () => { throw new Error("must not acquire"); }); }
      catch (error) { caught = error; }
      finally { clock.mockRestore(); }
      expect(caught).toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
        workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
          knownLocalHolder: false, ownerPredatesProcess: true } });
      const diagnostic = (caught as { workspaceRestoreLock: Record<string, unknown> }).workspaceRestoreLock;
      expect(Object.keys(diagnostic).sort()).toEqual(["knownLocalHolder", "ownerAgeMs", "ownerPredatesProcess", "ownerSameProcess", "ownerState", "waitMs"]);
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain(lockDir);
      expect(await readFile(path.join(lockDir, "owner.json"), "utf8")).toBe(owner);
    });

    it.skipIf(process.platform === "win32")(
      "serializes two concurrent writers that address one target through different aliases",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        let active = false;
        let overlapCount = 0;
        let completedCount = 0;
        const runWriter = (dir: string) =>
          withDirectoryMergeLock(dir, async () => {
            if (active) overlapCount += 1;
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            active = false;
            completedCount += 1;
          });

        await Promise.all([runWriter(targetDir), runWriter(aliasDir)]);

        expect(overlapCount).toBe(0);
        expect(completedCount).toBe(2);
      },
    );
  });

  describe("caller-provided env for the lock root", () => {
    // These tests never touch `process.env`. They prove `withDirectoryMergeLock`
    // resolves the lock root from a caller's own `env` object — the shape every
    // environment-parameterized Codex credential call site holds — instead of
    // always reading `process.env`.

    it("two callers that pass the same env with a temporary PAPERCLIP_HOME take the same lock under that home", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");

      let lockNameFirstCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameFirstCaller = entries[0] ?? "";
        },
        env,
      );

      let lockNameSecondCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameSecondCaller = entries[0] ?? "";
        },
        env,
      );

      expect(lockNameFirstCaller).not.toBe("");
      expect(lockNameSecondCaller).toBe(lockNameFirstCaller);
      expect(lockRootDir.startsWith(explicitHome + path.sep)).toBe(true);
    });

    it("does not write a lock entry under process.env.PAPERCLIP_HOME when the caller passes its own env", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");

      // Resolved with no `env` argument, so it reads `process.env` exactly the way
      // the real instance root does — unaffected by the explicit `env` above.
      const realInstanceRoot = resolvePaperclipInstanceRootForAdapter();
      const realLockPath = path.join(realInstanceRoot, "locks", "directory-merge", `${lockKey}.lock`);

      await withDirectoryMergeLock(targetDir, async () => undefined, env);

      await expect(lstat(realLockPath)).rejects.toThrow();

      const explicitLockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");
      await expect(stat(explicitLockRootDir)).resolves.toBeTruthy();
    });

    it("resolves the lock root under the default instance id when the caller env sets PAPERCLIP_HOME but not PAPERCLIP_INSTANCE_ID, ignoring process.env.PAPERCLIP_INSTANCE_ID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome };

      const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_INSTANCE_ID = "wrong-instance";
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "PAPERCLIP_HOME set,
        // PAPERCLIP_INSTANCE_ID unset" — the expected default instance id.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ homeDir: explicitHome, env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");
        const wrongInstanceLockRootDir = path.join(explicitHome, "instances", "wrong-instance", "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, env);

        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
        await expect(stat(wrongInstanceLockRootDir)).rejects.toThrow();
      } finally {
        if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
        else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      }
    });

    it("does not read process.env.PAPERCLIP_HOME when the caller env sets neither variable", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const fakeProcessHome = path.join(rootDir, "process-home");
      const fallbackOsHome = path.join(rootDir, "os-home");
      await mkdir(fallbackOsHome, { recursive: true });

      const previousHome = process.env.PAPERCLIP_HOME;
      process.env.PAPERCLIP_HOME = fakeProcessHome;
      // Stand in for the real host home directory, so the "no env at all"
      // fallback lands under a temp dir instead of the real ~/.paperclip.
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fallbackOsHome);
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "neither variable set" —
        // the expected fallback root under the mocked home directory.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, {});

        await expect(stat(fakeProcessHome)).rejects.toThrow();
        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
      } finally {
        homedirSpy.mockRestore();
        if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
        else process.env.PAPERCLIP_HOME = previousHome;
      }
    });
  });
});

describe("conflict-preserving directory restore", () => {
  it("preflights competing edits before applying any other change and deduplicates replay", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-cas-")));
    const source = path.join(root, "source"), target = path.join(root, "target");
    try {
      await mkdir(target);
      await writeFile(path.join(target, "conflict"), "baseline");
      const baseline = await captureDirectorySnapshot(target);
      await fsPromises.cp(target, source, { recursive: true });
      await writeFile(path.join(source, "conflict"), "incoming");
      await writeFile(path.join(source, "independent"), "also incoming");
      await writeFile(path.join(target, "conflict"), "board");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["conflict"] });
      await expect(stat(path.join(target, "independent"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(target, "conflict"), "baseline");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject", afterApply: async () => { throw new Error("receipt interrupted"); } })).rejects.toThrow("receipt interrupted");
      await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" });
      expect(await readFile(path.join(target, "independent"), "utf8")).toBe("also incoming");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves a newly added child when another run removes or replaces its parent", async () => {
    const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-delete-cas-")));
    const source = path.join(root, "source"), target = path.join(root, "target");
    try {
      await mkdir(path.join(target, "folder"), { recursive: true });
      const baseline = await captureDirectorySnapshot(target);
      await mkdir(source);
      await writeFile(path.join(target, "folder", "new"), "concurrent");
      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" })).rejects.toMatchObject({ paths: ["folder/new"] });
      expect(await readFile(path.join(target, "folder", "new"), "utf8")).toBe("concurrent");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


it("strict preflight preserves excluded descendants when a directory becomes a file", async () => {
  const root = await fsPromises.realpath(await mkdtemp(path.join(os.tmpdir(), "directory-excluded-cas-")));
  const target = path.join(root, "target"), source = path.join(root, "source");
  await mkdir(path.join(target, "folder", "node_modules"), { recursive: true });
  await writeFile(path.join(target, "folder", "node_modules", "keep"), "excluded contents");
  const baseline = await captureDirectorySnapshot(target, { exclude: ["*/node_modules"], diskBacked: true });
  try {
    await mkdir(source);
    await writeFile(path.join(source, "folder"), "replacement");
    await writeFile(path.join(source, "independent"), "must not partially apply");
    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" }))
      .rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: expect.arrayContaining(["folder/node_modules/keep"]) });
    expect(await readFile(path.join(target, "folder", "node_modules", "keep"), "utf8")).toBe("excluded contents");
    await expect(stat(path.join(target, "independent"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await disposeDirectorySnapshot(baseline); await rm(root, { recursive: true, force: true }); }
});
