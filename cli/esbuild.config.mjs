/**
 * esbuild configuration for building the paperclipai CLI for npm.
 *
 * Bundles all workspace packages (@paperclipai/*) into a single file.
 * External npm packages remain as regular dependencies.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledCliNpmDependencies } from "../scripts/cli-bundled-npm-dependencies.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway",
  "packages/adapters/hermes",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @paperclipai/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect all external (non-workspace) npm package names
const externals = new Set();
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@paperclipai/") && !bundledCliNpmDependencies.has(name)) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

if (bundledCliNpmDependencies.has("embedded-postgres")) {
  const requireFromDb = createRequire(resolve(repoRoot, "packages/db/package.json"));
  const embeddedPostgresRoot = dirname(requireFromDb.resolve("embedded-postgres"));
  const embeddedPostgresPackage = JSON.parse(
    readFileSync(resolve(embeddedPostgresRoot, "..", "package.json"), "utf8"),
  );
  for (const name of Object.keys(embeddedPostgresPackage.optionalDependencies ?? {})) {
    externals.add(name);
  }
}

/** @type {import('esbuild').BuildOptions} */
const sandboxParentGuardAssets = {
  name: "sandbox-parent-guard-assets",
  setup(build) {
    build.onStart(() => {
      execFileSync(process.execPath, [resolve(repoRoot, "scripts/build-sandbox-parent-guard.mjs")], { stdio: "inherit" });
    });
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const sourceDirectory = resolve(repoRoot, "packages/adapter-utils/dist");
      const outputDirectory = resolve(repoRoot, "cli/dist");
      for (const name of ["sandbox-parent-guard-linux-x64-gnu.node", "sandbox-parent-guard-compatibility.json"]) {
        const source = resolve(sourceDirectory, name);
        if (existsSync(source)) copyFileSync(source, resolve(outputDirectory, name));
        else rmSync(resolve(outputDirectory, name), { force: true });
      }
    });
  },
};

export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
  plugins: [sandboxParentGuardAssets],
};
