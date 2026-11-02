import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINARY_NAME = "sandbox-parent-guard-linux-x64-gnu.node";
const METADATA_NAME = "sandbox-parent-guard-compatibility.json";
const require = createRequire(import.meta.url);

type NativeResult = {
  status: number;
  index: number;
  nonDirectory: boolean;
  path?: string;
  code?: string;
  message?: string;
};
type NativeGuard = { guardAncestors(path: string, depth: number): Promise<NativeResult> };

let selected: NativeGuard | null | undefined;
type Compatibility = {
  schemaVersion: 1;
  sourceHash?: string;
  targets: Array<{
    platform: "linux";
    arch: "x64";
    libc: "glibc";
    node: string;
    uv: string;
    glibcFloor: string;
  }>;
};
function parseCompatibility(value: unknown): Compatibility {
  if (value === null || typeof value !== "object" || !("schemaVersion" in value) ||
      value.schemaVersion !== 1 || !("targets" in value) || !Array.isArray(value.targets)) {
    throw new Error(`Invalid sandbox parent guard compatibility metadata: ${METADATA_NAME}`);
  }
  const targets = value.targets as unknown[];
  for (const target of targets) {
    if (target === null || typeof target !== "object") {
      throw new Error(`Malformed sandbox parent guard compatibility target: ${METADATA_NAME}`);
    }
    const entry = target as Record<string, unknown>;
    if (entry.platform !== "linux" || entry.arch !== "x64" || entry.libc !== "glibc" ||
        typeof entry.node !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.node) ||
        typeof entry.uv !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.uv) ||
        typeof entry.glibcFloor !== "string" || !/^\d+\.\d+$/.test(entry.glibcFloor)) {
      throw new Error(`Malformed sandbox parent guard compatibility target: ${METADATA_NAME}`);
    }
  }
  if (targets.length > 0) {
    const sourceHash = (value as Record<string, unknown>).sourceHash;
    if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) {
      throw new Error(`Malformed sandbox parent guard compatibility source identity: ${METADATA_NAME}`);
    }
  }
  return value as Compatibility;
}

function selectNativeGuard(): NativeGuard | null {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const report: unknown = process.report.getReport();
  if (report === null || typeof report !== "object" || !("header" in report)) return null;
  const header = report.header;
  if (header === null || typeof header !== "object" || !("glibcVersionRuntime" in header)) return null;
  const runtimeGlibc = header.glibcVersionRuntime;
  if (typeof runtimeGlibc !== "string") return null;
  const distDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  let metadata: Compatibility;
  try {
    metadata = parseCompatibility(JSON.parse(readFileSync(resolve(distDirectory, METADATA_NAME), "utf8")));
  } catch (error) {
    throw new Error(`Unable to read required sandbox parent guard compatibility metadata: ${String(error)}`, { cause: error });
  }
  const target = metadata.targets.find((entry) => entry.platform === process.platform && entry.arch === process.arch &&
    entry.node === process.versions.node && entry.uv === process.versions.uv &&
    compareVersions(runtimeGlibc, entry.glibcFloor) >= 0);
  if (!target) return null;
  try {
    return require(resolve(distDirectory, BINARY_NAME)) as NativeGuard;
  } catch (error) {
    throw new Error(`Unable to load required sandbox parent guard binary ${BINARY_NAME}: ${String(error)}`, { cause: error });
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  if (a.length !== 2 || b.length !== 2 || a.some((part) => !Number.isInteger(part)) || b.some((part) => !Number.isInteger(part))) {
    throw new Error("Malformed glibc version in sandbox parent guard metadata or runtime report");
  }
  return a[0]! === b[0]! ? a[1]! - b[1]! : a[0]! - b[0]!;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasCanonicalPosixComponents(value: string): boolean {
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  let start = 1;
  for (let end = 1; end <= value.length; end++) {
    if (end !== value.length && value.charCodeAt(end) !== 47) continue;
    const length = end - start;
    if (length === 0 || (length === 1 && value.charCodeAt(start) === 46) ||
        (length === 2 && value.charCodeAt(start) === 46 && value.charCodeAt(start + 1) === 46)) return false;
    start = end + 1;
  }
  return true;
}

// Retain only bounded spelling eligibility, never a filesystem pass result.
let lastEligibleAncestorPath: string | undefined;

export async function assertNativeWorkspaceOverlayAncestors(
  lastAncestorPath: string,
  relative: string,
  depth: number,
): Promise<boolean> {
  if (depth < 1 || depth > 8 || lastAncestorPath.length > 4096) return false;
  if (lastAncestorPath !== lastEligibleAncestorPath) {
    if (!hasCanonicalPosixComponents(lastAncestorPath) || hasUnpairedSurrogate(lastAncestorPath)) return false;
    lastEligibleAncestorPath = lastAncestorPath;
  }
  if (selected === undefined) selected = selectNativeGuard();
  if (!selected) return false;
  const result = await selected.guardAncestors(lastAncestorPath, depth);
  if (result.status < 0) {
    const error = Object.assign(new Error(`${result.code}: ${result.message}, lstat '${result.path}'`), {
      errno: result.status,
      code: result.code,
      syscall: "lstat",
      path: result.path,
    });
    throw error;
  }
  if (result.nonDirectory) throw new Error(`Workspace overlay ancestor is not a directory: ${relative}`);
  return true;
}
