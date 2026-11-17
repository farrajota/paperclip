// E2E-only Postgres lock diagnostics for the embedded database the e2e
// webServer boots. The server builds its postgres argv internally and sends
// postgres output to an in-memory buffer, so production code offers no hook
// for either server settings or a persistent log. This preload fixture adds
// both from the outside, and only when PAPERCLIP_E2E_POSTGRES_LOG_FILE is set,
// which only tests/e2e/playwright.config.ts does for its webServer.
//
// It cannot use logging_collector: embedded-postgres decides that the server is
// ready by reading "ready to accept connections" from postgres's stderr, and the
// collector would divert stderr to its own files. Instead the child's stderr is
// teed to the log file, leaving the server's own handling untouched.
import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

export const POSTGRES_DIAGNOSTIC_SETTINGS = Object.freeze({
  // Report each lock wait that outlasts deadlock_timeout, naming the holding pids.
  log_lock_waits: "on",
  // The e2e cleanup that flakes gives up after lock_timeout=1000ms; 200ms makes
  // the wait visible well before that.
  deadlock_timeout: "200ms",
  // Statements that run longer than this are logged, which is how a holder that
  // keeps its transaction open across slow work shows up.
  log_min_duration_statement: "500ms",
  // millisecond timestamp, pid, virtual xid, xid, so a lock-wait line's holder pid
  // can be matched to that backend's other lines.
  log_line_prefix: "%m [%p] %v %x ",
});

export function postgresDiagnosticFlags() {
  return Object.entries(POSTGRES_DIAGNOSTIC_SETTINGS).flatMap(([name, value]) => ["-c", `${name}=${value}`]);
}

// embedded-postgres starts the server as `postgres -D <dir> -p <port> ...`.
// initdb and other helper binaries must not receive server flags.
export function isPostgresServerSpawn(command, args) {
  return typeof command === "string"
    && path.basename(command) === "postgres"
    && Array.isArray(args)
    && args.includes("-D");
}

export function installPostgresDiagnostics({ logFile, childProcessModule = childProcess }) {
  const realSpawn = childProcessModule.spawn;
  const append = (chunk) => {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, chunk);
  };
  childProcessModule.spawn = function spawnWithPostgresDiagnostics(command, args, ...rest) {
    if (!isPostgresServerSpawn(command, args)) return realSpawn.call(this, command, args, ...rest);
    const child = realSpawn.call(this, command, [...args, ...postgresDiagnosticFlags()], ...rest);
    child.stderr?.on("data", append);
    return child;
  };
}

const logFile = process.env.PAPERCLIP_E2E_POSTGRES_LOG_FILE;
if (process.env.NODE_ENV === "test" && logFile) {
  installPostgresDiagnostics({ logFile });
  // ES modules that import { spawn } from "child_process" otherwise keep the original.
  syncBuiltinESMExports();
}
