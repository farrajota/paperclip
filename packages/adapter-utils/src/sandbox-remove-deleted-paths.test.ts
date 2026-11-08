import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildRemoveDeletedPathsCommand } from "./sandbox-managed-runtime.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function fixture(paths: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remove-deleted-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  for (const relative of paths) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), "deleted\n");
  }
  const manifest = path.join(root, "deleted.nul");
  await writeFile(manifest, paths.map((relative) => `${relative}\0`).join(""));
  return { root, workspace, manifest };
}

async function exists(file: string) {
  return stat(file).then(() => true, () => false);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("buildRemoveDeletedPathsCommand", () => {
  it("removes every listed path across batches, preserving whitespace in names", async () => {
    const paths = [
      ...Array.from({ length: 150 }, (_, index) => `lane/${index}/file ${index}.txt`),
      " padded name ",
      "line\nbreak",
    ];
    const { workspace, manifest } = await fixture(paths);
    await writeFile(path.join(workspace, "kept.txt"), "kept\n");

    await execFileAsync("sh", ["-c", buildRemoveDeletedPathsCommand({ remoteDir: workspace, manifestPath: manifest })]);

    for (const relative of paths) expect(await exists(path.join(workspace, relative))).toBe(false);
    expect(await readFile(path.join(workspace, "kept.txt"), "utf8")).toBe("kept\n");
    expect(await exists(manifest)).toBe(false);
  });

  it("refuses a batch with a symlinked ancestor without deleting through it", async () => {
    const { root, workspace, manifest } = await fixture(["safe/first.txt"]);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "victim.txt"), "keep\n");
    await symlink(outside, path.join(workspace, "linked"));
    await writeFile(manifest, "safe/first.txt\0linked/victim.txt\0");

    const result = execFileAsync("sh", ["-c", buildRemoveDeletedPathsCommand({ remoteDir: workspace, manifestPath: manifest })]);

    await expect(result).rejects.toMatchObject({ code: expect.any(Number) });
    expect(await readFile(path.join(outside, "victim.txt"), "utf8")).toBe("keep\n");
    expect(await exists(path.join(workspace, "safe/first.txt"))).toBe(true);
  });

  // Each process spawn is expensive in sandboxed runtimes (gVisor); one rm per
  // path made a 40,000-path deletion take minutes.
  it("spawns rm once per batch rather than once per path", async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `many/${index}.txt`);
    const { root, workspace, manifest } = await fixture(paths);
    const bin = path.join(root, "bin");
    const log = path.join(root, "rm-calls.log");
    await mkdir(bin);
    const realRm = (await execFileAsync("sh", ["-c", "command -v rm"])).stdout.trim();
    await writeFile(path.join(bin, "rm"), `#!/bin/sh\necho call >> '${log}'\nexec '${realRm}' "$@"\n`);
    await chmod(path.join(bin, "rm"), 0o755);

    await execFileAsync("sh", ["-c", buildRemoveDeletedPathsCommand({ remoteDir: workspace, manifestPath: manifest })], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    for (const relative of paths) expect(await exists(path.join(workspace, relative))).toBe(false);
    const calls = (await readFile(log, "utf8")).trim().split("\n").length;
    // Three 64-path batches plus the final manifest removal.
    expect(calls).toBeLessThanOrEqual(4);
  });
});
