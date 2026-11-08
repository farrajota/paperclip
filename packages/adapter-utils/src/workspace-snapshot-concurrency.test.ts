import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDirectorySnapshot,
  disposeDirectorySnapshot,
  type SnapshotEntry,
} from "./workspace-restore-merge.js";

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-concurrency-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(createReadStream).mockImplementation(originalFs.createReadStream);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("bounded workspace snapshot reads", () => {
  it("preserves file hashes, modes, nested paths, exclusions, and symlink entries across batches", async () => {
    const root = await fixture();
    const outside = await fixture();
    const expected = new Map<string, SnapshotEntry>();
    for (const directory of ["nested", "nested/deeper"]) {
      await fs.mkdir(path.join(root, directory));
      expected.set(directory, { kind: "dir" });
    }
    for (let index = 0; index < 73; index++) {
      const relative = `${index < 35 ? "" : "nested/deeper/"}${index % 3 === 0 ? "line\nbreak" : "-space name"}-${index}`;
      const content = Buffer.from(`snapshot ${index}\0bytes`);
      const filePath = path.join(root, relative);
      await fs.writeFile(filePath, content);
      await fs.chmod(filePath, index % 2 === 0 ? 0o600 : 0o444);
      expected.set(relative, {
        kind: "file", mode: (await fs.lstat(filePath)).mode,
        hash: createHash("sha256").update(content).digest("hex"),
      });
    }
    await fs.writeFile(path.join(outside, "private"), "outside bytes");
    await fs.symlink(outside, path.join(root, "outside-link"));
    expected.set("outside-link", { kind: "symlink", target: outside });
    for (const ignored of ["excluded", "ignored"]) {
      await fs.mkdir(path.join(root, ignored));
      await fs.writeFile(path.join(root, ignored, "private"), "omitted bytes");
    }
    for (const diskBacked of [false, true]) {
      const snapshot = await captureDirectorySnapshot(root, {
        exclude: ["excluded"], ignoredPaths: ["ignored"], diskBacked,
      });
      try {
        expect(new Map(snapshot.entries)).toEqual(expected);
      } finally {
        await disposeDirectorySnapshot(snapshot);
      }
    }
  });

  it("overlaps reads within a fixed bound even across nested directories", async () => {
    const root = await fixture();
    for (const directory of ["", "nested", "nested/deeper"]) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await Promise.all(Array.from({ length: 35 }, (_, index) =>
        fs.writeFile(path.join(root, directory, `file-${index}`), String(index))));
    }
    let active = 0;
    let peak = 0;
    vi.mocked(createReadStream).mockImplementation((...args) => {
      const stream = originalFs.createReadStream(...args);
      stream.pause();
      active++;
      peak = Math.max(peak, active);
      const settled = () => { active--; };
      stream.once("end", settled);
      stream.once("error", settled);
      setTimeout(() => stream.resume(), 10);
      return stream;
    });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (observedPath, flags, mode) => {
      const file = await open(observedPath, flags, mode);
      if (!String(observedPath).startsWith(`${root}${path.sep}`)) return file;
      return {
        read: async (...args: Parameters<typeof file.read>) => {
          active++;
          peak = Math.max(peak, active);
          try {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return await file.read(...args);
          } finally {
            active--;
          }
        },
        close: file.close.bind(file),
      } as unknown as typeof file;
    });
    const snapshot = await captureDirectorySnapshot(root, { diskBacked: true });
    try {
      expect(snapshot.entries.size).toBe(107);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(16);
      expect(active).toBe(0);
    } finally {
      await disposeDirectorySnapshot(snapshot);
    }
  });

  it("overlaps streamed files above the small-file cutoff within the original read bound", async () => {
    const root = await fixture();
    const expectedHashes = new Map<string, string>();
    for (let index = 0; index < 17; index++) {
      const relative = `large-${index}`;
      const bytes = Buffer.alloc(64 * 1024 + 1, index);
      await fs.writeFile(path.join(root, relative), bytes);
      expectedHashes.set(relative, createHash("sha256").update(bytes).digest("hex"));
    }
    let active = 0;
    let peak = 0;
    vi.mocked(createReadStream).mockImplementation((...args) => {
      const stream = originalFs.createReadStream(...args);
      stream.pause();
      active++;
      peak = Math.max(peak, active);
      const settled = () => { active--; };
      stream.once("end", settled);
      stream.once("error", settled);
      setTimeout(() => stream.resume(), 10);
      return stream;
    });
    const snapshot = await captureDirectorySnapshot(root, { diskBacked: true });
    try {
      expect(new Map([...snapshot.entries].map(([relative, entry]) => [
        relative, entry.kind === "file" ? entry.hash : null,
      ]))).toEqual(expectedHashes);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(16);
      expect(active).toBe(0);
    } finally {
      await disposeDirectorySnapshot(snapshot);
    }
  });

  it("settles started metadata reads before propagating a peer failure", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "denied"), "denied");
    await fs.writeFile(path.join(root, "pending"), "pending");
    const lstat = fs.lstat.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending = false;
    let active = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === path.join(root, "denied")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      active++;
      pending = true;
      try {
        await gate;
        return await lstat(...args);
      } finally {
        active--;
      }
    });
    let settled = false;
    const result = captureDirectorySnapshot(root, { diskBacked: true }).then(
      () => { settled = true; return null; },
      error => { settled = true; return error; },
    );
    try {
      await vi.waitFor(() => expect(pending).toBe(true));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect(await result).toMatchObject({ code: "EACCES" });
    expect(active).toBe(0);
  });

  it("settles delayed peer content reads before returning a content failure", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "failed"), "failed");
    await fs.writeFile(path.join(root, "pending"), "pending bytes");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let peerReadStarted!: () => void;
    const peerReadGate = new Promise<void>(resolve => { peerReadStarted = resolve; });
    let pending = false;
    let failed = false;
    let active = 0;
    vi.mocked(createReadStream).mockImplementation((...args) => {
      const stream = originalFs.createReadStream(...args);
      stream.pause();
      active++;
      stream.once("end", () => { active--; });
      stream.once("error", () => { active--; failed = true; });
      if (String(args[0]) === path.join(root, "failed")) {
        void setImmediate().then(() => stream.destroy(Object.assign(new Error("read failed"), { code: "EIO" })));
      } else {
        pending = true;
        void gate.then(() => stream.resume());
      }
      return stream;
    });
    const open = fs.open.bind(fs);
    const readError = Object.assign(new Error("read failed"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementation(async (observedPath, flags, mode) => {
      const file = await open(observedPath, flags, mode);
      if (!String(observedPath).startsWith(`${root}${path.sep}`)) return file;
      return {
        read: async (...args: Parameters<typeof file.read>) => {
          active++;
          try {
            if (String(observedPath) === path.join(root, "failed")) {
              await peerReadGate;
              failed = true;
              throw readError;
            }
            pending = true;
            peerReadStarted();
            await gate;
            return await file.read(...args);
          } finally {
            active--;
          }
        },
        close: file.close.bind(file),
      } as unknown as typeof file;
    });
    let settled = false;
    const result = captureDirectorySnapshot(root, { diskBacked: true }).then(
      () => { settled = true; return null; },
      error => { settled = true; return error; },
    );
    try {
      await vi.waitFor(() => expect(failed && pending).toBe(true));
      expect(settled).toBe(false);
      expect(active).toBe(1);
    } finally {
      release();
      peerReadStarted();
      await result;
    }
    expect(await result).toMatchObject({ code: "EIO" });
    expect(active).toBe(0);
  });
});
