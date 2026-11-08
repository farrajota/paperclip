import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { bootstrapCeoInvite } from "./auth-bootstrap-ceo.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";
import {
  describeLocalInstancePaths,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { assertForegroundRunAllowed } from "../services/service-manager.js";
import { removeRuntimeInfoForPid, writeRuntimeInfo } from "../runtime-info.js";
import { printUpdateNotice } from "../update-notice.js";
import { ensureWorktreeSeeded } from "./worktree.js";

export interface RunOptions {
  config?: string;
  instance?: string;
  repair?: boolean;
  yes?: boolean;
  bind?: "loopback" | "lan" | "tailnet";
  force?: boolean;
  /** Internal lifecycle option used by foreground-only commands. */
  installService?: boolean;
  /** Internal lifecycle option for isolated instances that cannot collide with a managed service. */
  skipServiceManagerCheck?: boolean;
  /** Internal label override for commands that reuse the foreground run path. */
  introLabel?: string;
  /** Runs after the server is listening and all normal post-start initialization has completed. */
  afterStart?: (server: StartedServer) => Promise<void>;
}

export interface StartedServer {
  apiUrl: string;
  databaseUrl: string;
  host: string;
  listenPort: number;
  shutdown?: (signal?: "SIGINT" | "SIGTERM") => Promise<void>;
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const instanceId = resolvePaperclipInstanceId(opts.instance);
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  if (!opts.skipServiceManagerCheck) {
    await assertForegroundRunAllowed(instanceId, opts.force);
  }

  const homeDir = resolvePaperclipHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  process.env.PAPERCLIP_CONFIG = configPath;
  loadPaperclipEnvFile(configPath);
  await printUpdateNotice(configPath);

  p.intro(pc.bgCyan(pc.black(` ${opts.introLabel ?? "paperclipai run"} `)));
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if ((!process.stdin.isTTY || !process.stdout.isTTY) && !opts.yes) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("paperclipai onboard")} once, then retry ${pc.cyan("paperclipai run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({
      config: configPath,
      invokedByRun: true,
      bind: opts.bind,
      yes: opts.yes,
      installService: opts.installService,
    });
  }

  const seedResult = await ensureWorktreeSeeded({ config: configPath });
  if (seedResult.seeded) {
    p.log.success("Completed deferred worktree database seed.");
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({
    config: configPath,
    repair: opts.repair ?? true,
    yes: opts.yes ?? true,
  });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking issues. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Paperclip server...");
  const startedServer = await importServerEntry();
  writeRuntimeInfo({
    schemaVersion: 1,
    instanceId,
    pid: process.pid,
    host: startedServer.host,
    port: startedServer.listenPort,
    dashboardUrl: startedServer.apiUrl.replace(/\/api\/?$/, ""),
    startedAt: new Date().toISOString(),
  });
  process.once("exit", () => removeRuntimeInfoForPid(process.pid, instanceId));

  if (shouldGenerateBootstrapInviteAfterStart(config)) {
    p.log.step("Generating bootstrap CEO invite");
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: startedServer.databaseUrl,
      baseUrl: resolveBootstrapInviteBaseUrl(config, startedServer),
    });
  }

  if (opts.afterStart) {
    try {
      await opts.afterStart(startedServer);
    } catch (error) {
      await startedServer.shutdown?.("SIGTERM");
      throw error;
    }
  }
}

function resolveBootstrapInviteBaseUrl(
  config: PaperclipConfig,
  startedServer: StartedServer,
): string {
  const explicitBaseUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    (config.auth.baseUrlMode === "explicit" ? config.auth.publicBaseUrl : undefined);

  if (typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }

  return startedServer.apiUrl.replace(/\/api$/, "");
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.PAPERCLIP_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@paperclipai/server/src/index.ts")) {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
  }
}
const STARTUP_TIMING_FLAG = "PAPERCLIP_TEST_CLI_STARTUP_TIMINGS";
const STARTUP_TIMING_PREFIX = "PAPERCLIP_TEST_CLI_STARTUP ";
const MAX_STARTUP_TIMING_MS = 3_600_000;

function startupTimingsEnabled(): boolean {
  return process.env[STARTUP_TIMING_FLAG] === "1";
}

function startupElapsedMs(startedAt: number): number {
  try {
    const elapsedMs = Math.floor(Date.now() - startedAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
    return Math.min(elapsedMs, MAX_STARTUP_TIMING_MS);
  } catch {
    return 0;
  }
}

function writeStartupTiming(checkpoint: string, outcome: "enter" | "pass" | "throw", elapsedMs: number): void {
  try {
    // Keep diagnostic write errors local without adding a stdout error listener.
    const stdoutFd = process.stdout.fd;
    let remaining = `${STARTUP_TIMING_PREFIX}${JSON.stringify({ checkpoint, outcome, elapsedMs })}\n`;
    while (remaining.length > 0) {
      const written = fs.writeSync(stdoutFd, remaining, null, "utf8");
      if (written <= 0 || written >= remaining.length) return;
      remaining = remaining.slice(written);
    }
  } catch {
    // Synchronous diagnostic writes keep stream failures out of startup behavior.
  }
}

function runStartupTimingSync<T>(checkpoint: string, operation: () => T): T {
  let startedAt = 0;
  try { startedAt = Date.now(); } catch { /* Keep diagnostics isolated from startup. */ }
  writeStartupTiming(checkpoint, "enter", 0);
  try {
    const result = operation();
    writeStartupTiming(checkpoint, "pass", startupElapsedMs(startedAt));
    return result;
  } catch (error) {
    writeStartupTiming(checkpoint, "throw", startupElapsedMs(startedAt));
    throw error;
  }
}

async function runStartupTiming<T>(checkpoint: string, operation: () => Promise<T>): Promise<T> {
  let startedAt = 0;
  try { startedAt = Date.now(); } catch { /* Keep diagnostics isolated from startup. */ }
  writeStartupTiming(checkpoint, "enter", 0);
  try {
    const result = await operation();
    writeStartupTiming(checkpoint, "pass", startupElapsedMs(startedAt));
    return result;
  } catch (error) {
    writeStartupTiming(checkpoint, "throw", startupElapsedMs(startedAt));
    throw error;
  }
}


function ensureDevWorkspaceBuildDeps(projectRoot: string): void {
  const buildScript = path.resolve(projectRoot, "scripts/ensure-plugin-build-deps.mjs");
  if (!fs.existsSync(buildScript)) return;

  const result = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(
      `Failed to prepare workspace build artifacts before starting the Paperclip dev server.\n${formatError(result.error)}`,
    );
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      "Failed to prepare workspace build artifacts before starting the Paperclip dev server.",
    );
  }
}

async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const devEntry = path.resolve(projectRoot, "server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    if (startupTimingsEnabled()) {
      runStartupTimingSync("startup-workspace-prerequisites", () => ensureDevWorkspaceBuildDeps(projectRoot));
    } else {
      ensureDevWorkspaceBuildDeps(projectRoot);
    }
    maybeEnableUiDevMiddleware(devEntry);
    const serverEntryUrl = pathToFileURL(devEntry).href;
    const mod = startupTimingsEnabled()
      ? await runStartupTiming("startup-server-import", () => import(serverEntryUrl))
      : await import(serverEntryUrl);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @paperclipai/server package
  try {
    const mod = startupTimingsEnabled()
      ? await runStartupTiming("startup-server-import", () => import("@paperclipai/server"))
      : await import("@paperclipai/server");
    return await startServerFromModule(mod, "@paperclipai/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@paperclipai/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Paperclip server entrypoint.\n` +
          `Tried: ${devEntry}, @paperclipai/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Paperclip server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

function shouldGenerateBootstrapInviteAfterStart(config: PaperclipConfig): boolean {
  return config.server.deploymentMode === "authenticated" && config.database.mode === "embedded-postgres";
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const startServer = (mod as { startServer?: () => Promise<StartedServer> }).startServer;
  if (typeof startServer !== "function") {
    throw new Error(`Paperclip server entrypoint did not export startServer(): ${label}`);
  }
  if (startupTimingsEnabled()) {
    return await runStartupTiming("startup-server-start", () => startServer());
  }
  return await startServer();
}
