import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(fixturePath), "../..");
const fixtureBoundary = "fixture-only command lease/process boundary; not executable or guardian qualification";
const fixtureModels = {
  currentModelId: "gpt-5.6-sol",
  availableModels: [{ modelId: "gpt-5.6-sol", name: "Synthetic fixture model" }],
};

if (process.argv[2] === "--provider") {
  runProvider(process.argv[3], process.argv[4]);
} else if (process.argv[2] === "--admit") {
  await runAdmission(process.argv[3], process.argv[4]);
} else {
  runColdFixture();
}

function runColdFixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "paperclip-acpx-cold-"));
  try {
    const first = runChildAdmission("first", stateRoot);
    const reopened = runChildAdmission("reopen", stateRoot);
    const events = readFileSync(join(stateRoot, "provider-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(first.identity, reopened.identity, "fresh-process reopen must preserve runtime identity");
    assert.ok(first.identity.acpxRecordId, "the first process must persist an ACPX record identity");
    assert.equal(first.identity.backendSessionId, "cold-fixture-session");
    assert.ok(events.some((event) => event.phase === "first" && event.method === "session/new"));
    assert.ok(events.some((event) => event.phase === "reopen" && event.method === "session/load"));
    assert.ok(events.some((event) => event.phase === "reopen" && event.method === "session/prompt" && event.params.sessionId === "cold-fixture-session"));
    assert.equal(events.some((event) => event.phase === "reopen" && event.method === "session/new"), false);
    process.stdout.write(`${JSON.stringify({ first, reopened, recoveredByLoad: true, fixtureBoundary })}\n`);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function runChildAdmission(phase, stateRoot) {
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fixturePath, "--admit", phase, stateRoot], {
    cwd: packageRoot,
    encoding: "utf8",
    env: fixtureEnvironment(stateRoot, phase),
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${phase} admission failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

async function runAdmission(phase, stateRoot) {
  const { openQualifiedAcpxRuntime } = await import(resolve(packageRoot, "src/drivers/acpx/codex-runtime-adapter.ts"));
  const providerState = join(stateRoot, "provider-state.json");
  const providerEvents = join(stateRoot, "provider-events.jsonl");
  const cwd = stateRoot;
  const command = {
    spawn(_args, _options, _ownership) {
      return spawn(process.execPath, [fixturePath, "--provider", providerState, providerEvents], {
        cwd,
        env: fixtureEnvironment(stateRoot, phase),
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    async close() {},
  };
  const failedAdmissionCleanups = [];
  const options = {
    command,
    profile: {
      driverKind: "acpx_runtime",
      protocolVersion: 1,
      acpxVersion: "0.13.1",
      agent: "codex",
      agentProfileVersion: 1,
      agentServerPackage: "synthetic-local-acp-provider",
      agentServerVersion: "1.0.0",
      agentRuntimePackage: null,
      commandDigest: "sha256:synthetic-fixture",
      qualificationModel: "gpt-5.6-sol",
      reportedModelId: "gpt-5.6-sol",
      permissionPolicy: "interactive",
    },
    cwd,
    stateDirectory: join(stateRoot, "runtime-state"),
    providerSessionKey: "cold-fixture-persisted-session",
    permissionMode: "approve-reads",
    permissionPolicy: { autoApprove: ["read"], escalate: ["write"], defaultAction: "escalate" },
    launchEnvironment: {},
    credentialFenceFds: [42, 43],
    async activateCredentialFenceOwner() {},
    systemInstructions: "Synthetic cold-acquisition fixture; no external provider.",
    mcpServers: [],
    retainFailedAdmissionCleanup(cleanup) {
      failedAdmissionCleanups.push(cleanup);
      void cleanup.catch(() => {});
    },
  };
  const providerExit = new WeakMap();
  let port;
  try {
    port = await openQualifiedAcpxRuntime(options, {
      platform: "linux",
      // This synthetic command/process boundary replaces production guardian proof and is not qualification evidence.
      awaitProviderOwnership: async (child) => {
        if (child.pid === undefined) throw new Error("synthetic provider has no process id");
      },
      awaitProviderExit: (child) => {
        const existing = providerExit.get(child);
        if (existing) return existing;
        const pending = child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolveExit) => child.once("exit", resolveExit)).then(() => undefined);
        providerExit.set(child, pending);
        return pending;
      },
    });
    const identity = await port.identity();
    assert.equal((await port.getStatus()).models?.currentModelId, "gpt-5.6-sol");
    if (phase === "reopen") {
      const turn = port.startTurn({ text: "Resume the synthetic session.", requestId: "cold-recovery-turn" });
      const events = (async () => { for await (const _event of turn.events) { /* drain */ } })();
      const [result] = await Promise.all([turn.result, events]);
      assert.equal(result.status, "completed", "recovered session must complete a real ACP prompt");
      assert.deepEqual(await port.identity(), identity);
    }
    process.stdout.write(`${JSON.stringify({ phase, identity })}\n`);
  } finally {
    try {
      if (port) await port.close({ reason: `cold fixture ${phase} admission complete` });
    } finally {
      const outcomes = await Promise.allSettled(failedAdmissionCleanups);
      const errors = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
      if (errors.length) throw new AggregateError(errors, "cold fixture failed-admission cleanup failed");
    }
  }
}

function runProvider(statePath, eventsPath) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      appendFileSync(eventsPath, `${JSON.stringify({ phase: process.env.PAPERCLIP_FIXTURE_PHASE, method: request.method, params: request.params })}\n`, { mode: 0o600 });
      respond(request, statePath);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

function respond(request, statePath) {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        agentInfo: { name: "paperclip-cold-acp-fixture", version: "1.0.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      },
    });
    return;
  }
  if (request.method === "session/new") {
    const sessionId = "cold-fixture-session";
    writeFileSync(statePath, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
    send({ id: request.id, result: { sessionId, models: fixtureModels } });
    return;
  }
  if (request.method === "session/load") {
    const persisted = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    if (persisted?.sessionId !== request.params.sessionId) {
      send({ id: request.id, error: { code: -32000, message: "requested session was not persisted" } });
      return;
    }
    send({ id: request.id, result: { models: fixtureModels } });
    return;
  }
  if (request.method === "session/prompt") {
    const persisted = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    if (persisted?.sessionId !== request.params.sessionId) {
      send({ id: request.id, error: { code: -32000, message: "requested session was not persisted" } });
      return;
    }
    send({ id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (request.method === "session/close") {
    send({ id: request.id, result: {} });
    return;
  }
  send({ id: request.id, error: { code: -32601, message: `unsupported synthetic ACP method ${request.method}` } });
}

function send(value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
}
function fixtureEnvironment(stateRoot, phase) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: stateRoot,
    TMPDIR: stateRoot,
    NODE_ENV: "test",
    PAPERCLIP_FIXTURE_PHASE: phase ?? "provider",
  };
}

