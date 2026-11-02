#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "packages/adapter-utils/src/sandbox-parent-guard.c");
const outputDirectory = join(repoRoot, "packages/adapter-utils/dist");
const binaryName = "sandbox-parent-guard-linux-x64-gnu.node";
const metadataName = "sandbox-parent-guard-compatibility.json";

function parseMacros(sourceText) {
  const values = new Map();
  for (const match of sourceText.matchAll(/^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([0-9]+)\b/gm)) values.set(match[1], Number(match[2]));
  return values;
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unexpected version string: ${version}`);
  return match.slice(1).map(Number);
}

function verifyVersionHeaders(nodeInclude) {
  const nodeHeader = readFileSync(join(nodeInclude, "node_version.h"), "utf8");
  const uvHeader = readFileSync(join(nodeInclude, "uv/version.h"), "utf8");
  const nodeMacros = parseMacros(nodeHeader);
  const uvMacros = parseMacros(uvHeader);
  const [nodeMajor, nodeMinor, nodePatch] = versionParts(process.versions.node);
  const [uvMajor, uvMinor, uvPatch] = versionParts(process.versions.uv);
  if (nodeMacros.get("NODE_MAJOR_VERSION") !== nodeMajor || nodeMacros.get("NODE_MINOR_VERSION") !== nodeMinor || nodeMacros.get("NODE_PATCH_VERSION") !== nodePatch) {
    throw new Error("Installed public Node headers do not match the running Node version");
  }
  if (uvMacros.get("UV_VERSION_MAJOR") !== uvMajor || uvMacros.get("UV_VERSION_MINOR") !== uvMinor || uvMacros.get("UV_VERSION_PATCH") !== uvPatch) {
    throw new Error("Installed bundled libuv headers do not match the running libuv version");
  }
}

function verifyGlibc() {
  const runtime = process.report.getReport().header.glibcVersionRuntime;
  if (typeof runtime !== "string") return null;
  const macros = execFileSync("gcc", ["-dM", "-E", "-include", "features.h", "-"], { encoding: "utf8", input: "" });
  const values = parseMacros(macros);
  const headerVersion = `${values.get("__GLIBC__")}.${values.get("__GLIBC_MINOR__")}`;
  if (headerVersion !== runtime) throw new Error(`Installed glibc headers ${headerVersion} do not match runtime ${runtime}`);
  return runtime;
}

function unsupported() {
  mkdirSync(outputDirectory, { recursive: true });
  const metadataPath = join(outputDirectory, metadataName);
  const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, targets: [] }, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, metadataPath);
  rmSync(join(outputDirectory, binaryName), { force: true });
  process.stdout.write("sandbox parent guard: no native target on this build host\n");
}

function build() {
  if (process.platform !== "linux" || process.arch !== "x64") return unsupported();
  const glibc = verifyGlibc();
  if (glibc === null) return unsupported();
  const executable = realpathSync(process.execPath);
  const executablePrefix = dirname(dirname(executable));
  const nodeInclude = join(executablePrefix, "include/node");
  const nodeApi = join(nodeInclude, "node_api.h");
  const uvHeader = join(nodeInclude, "uv/version.h");
  if (!existsSync(nodeApi) || !existsSync(uvHeader)) throw new Error(`Matching public Node/libuv headers are required under ${nodeInclude}`);
  verifyVersionHeaders(nodeInclude);

  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, binaryName);
  const metadataPath = join(outputDirectory, metadataName);
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (existsSync(outputPath) && existsSync(metadataPath)) {
    try {
      const installed = JSON.parse(readFileSync(metadataPath, "utf8"));
      const target = installed.targets?.[0];
      if (installed.schemaVersion === 1 && installed.sourceHash === sourceHash &&
          target?.node === process.versions.node && target?.uv === process.versions.uv &&
          target?.glibcFloor === glibc && target?.platform === "linux" && target?.arch === "x64" && target?.libc === "glibc") return;
    } catch {}
  }

  const token = `${process.pid}.${randomUUID()}`;
  const temporaryBinary = `${outputPath}.${token}.tmp`;
  const temporaryMetadata = `${metadataPath}.${token}.tmp`;
  try {
    execFileSync("gcc", ["-std=gnu11", "-O2", "-fPIC", "-shared", "-DNODE_GYP_MODULE_NAME=sandbox_parent_guard", `-I${nodeInclude}`, source, "-o", temporaryBinary], { stdio: "inherit" });
    const metadata = {
      schemaVersion: 1,
      sourceHash,
      targets: [{
        platform: "linux",
        arch: "x64",
        libc: "glibc",
        node: process.versions.node,
        uv: process.versions.uv,
        glibcFloor: glibc,
      }],
    };
    writeFileSync(temporaryMetadata, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
    renameSync(temporaryBinary, outputPath);
    renameSync(temporaryMetadata, metadataPath);
  } finally {
    rmSync(temporaryBinary, { force: true });
    rmSync(temporaryMetadata, { force: true });
  }
}

build();
