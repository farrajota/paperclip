import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fixture = fileURLToPath(new URL("./postgres-lock-diagnostics.mjs", import.meta.url));

// A stand-in `postgres` binary that reports the argv it received on stderr, the
// stream embedded-postgres reads, and `initdb` that does the same.
function withFakeBinaries(run) {
  const dir = mkdtempSync(join(tmpdir(), "pg-lock-diagnostics-"));
  try {
    for (const name of ["postgres", "initdb"]) {
      const bin = join(dir, name);
      writeFileSync(bin, `#!/bin/sh\necho "${name} argv: $*" >&2\n`);
      chmodSync(bin, 0o755);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function launch(dir, env) {
  const script = `
    import { spawn } from "node:child_process";
    const run = (bin, args) => new Promise((resolve) => {
      const child = spawn(bin, args);
      let err = "";
      child.stderr.on("data", (c) => { err += c; });
      child.on("close", () => resolve(err.trim()));
    });
    console.log(JSON.stringify({
      server: await run(${JSON.stringify(join(dir, "postgres"))}, ["-D", "/data", "-p", "5432"]),
      initdb: await run(${JSON.stringify(join(dir, "initdb"))}, ["-D", "/data"]),
    }));
  `;
  const { PAPERCLIP_E2E_POSTGRES_LOG_FILE: _drop, ...baseEnv } = process.env;
  return spawnSync(process.execPath, ["--import", fixture, "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...baseEnv, NODE_ENV: "test", ...env },
  });
}

test("adds lock-wait settings to the postgres server argv and tees its stderr to the log file", () => {
  withFakeBinaries((dir) => {
    const logFile = join(dir, "nested", "postgres.log");
    const result = launch(dir, { PAPERCLIP_E2E_POSTGRES_LOG_FILE: logFile });
    assert.equal(result.status, 0, result.stderr);
    const { server } = JSON.parse(result.stdout);
    assert.match(server, /-D \/data -p 5432 /);
    assert.match(server, /-c log_lock_waits=on/);
    assert.match(server, /-c deadlock_timeout=200ms/);
    assert.match(server, /-c log_min_duration_statement=500ms/);
    assert.match(server, /-c log_line_prefix=%m \[%p\] %v %x$/);
    assert.equal(readFileSync(logFile, "utf8").trim(), server);
  });
});

test("leaves initdb untouched and writes nothing for it", () => {
  withFakeBinaries((dir) => {
    const logFile = join(dir, "postgres.log");
    const result = launch(dir, { PAPERCLIP_E2E_POSTGRES_LOG_FILE: logFile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).initdb, "initdb argv: -D /data");
    assert.doesNotMatch(readFileSync(logFile, "utf8"), /initdb/);
  });
});

test("changes nothing when PAPERCLIP_E2E_POSTGRES_LOG_FILE is unset", () => {
  withFakeBinaries((dir) => {
    const result = launch(dir, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).server, "postgres argv: -D /data -p 5432");
    assert.equal(existsSync(join(dir, "postgres.log")), false);
  });
});

test("changes nothing outside NODE_ENV=test even when the log file is set", () => {
  withFakeBinaries((dir) => {
    const result = launch(dir, { NODE_ENV: "production", PAPERCLIP_E2E_POSTGRES_LOG_FILE: join(dir, "postgres.log") });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).server, "postgres argv: -D /data -p 5432");
  });
});
