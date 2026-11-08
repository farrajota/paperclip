import { describe, expect, it } from "vitest";
import { PortabilityPhaseDiagnostics, StartupTimingFrameDecoder } from "./portability-phase-diagnostics.js";

describe("PortabilityPhaseDiagnostics", () => {
  it("stays default-off and does not attempt any artifact write", async () => {
    let writeCount = 0;
    const diagnostics = new PortabilityPhaseDiagnostics(undefined, () => {
      writeCount += 1;
    });

    await diagnostics.run("body", "context", () => "result");

    expect(writeCount).toBe(0);
  });

  it("records synchronous checkpoints without changing their result", () => {
    const diagnostics = new PortabilityPhaseDiagnostics(undefined);
    let completed = false;

    const result = diagnostics.runSync("setup", "server-spawn", () => {
      completed = true;
      return "started";
    });

    expect(result).toBe("started");
    expect(completed).toBe(true);
  });

  it("clamps enabled synchronous elapsed times to the closed bounds", () => {
    let contents = "";
    const timestamps = [10, 9, 0, 3_600_001];
    const diagnostics = new PortabilityPhaseDiagnostics(
      "fixture-output",
      (_path, data) => {
        contents = data;
      },
      () => timestamps.shift() ?? 0,
    );

    expect(diagnostics.runSync("setup", "support", () => "supported")).toBe("supported");
    expect(diagnostics.runSync("setup", "db-start", () => "started")).toBe("started");

    const artifact = JSON.parse(contents) as {
      observations: Array<{ outcome: string; elapsedMs: number }>;
    };
    expect(artifact.observations.map(({ outcome }) => outcome)).toEqual([
      "enter",
      "pass",
      "enter",
      "pass",
    ]);
    expect(artifact.observations.map(({ elapsedMs }) => elapsedMs)).toEqual([0, 0, 0, 3_600_000]);
  });

  it("writes only closed UTF-8 observations with bounded elapsed values", async () => {
    let artifactPath = "";
    let contents = "";
    let encoding = "";
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (path, data, fileEncoding) => {
      artifactPath = path;
      contents = data;
      encoding = fileEncoding;
    });

    const payload = "sensitive payload 🔒".repeat(128);
    expect(await diagnostics.run("body", "export", () => payload)).toBe(payload);

    const artifact = JSON.parse(contents) as {
      schemaVersion: number;
      truncated: boolean;
      observations: Array<Record<string, unknown>>;
    };
    expect(Object.keys(artifact).sort()).toEqual(["observations", "schemaVersion", "truncated"]);
    expect(artifactPath).toBe("fixture-output");
    expect(encoding).toBe("utf8");
    expect(Buffer.byteLength(contents, "utf8")).toBeLessThanOrEqual(8192);
    expect(artifact).toMatchObject({ schemaVersion: 1, truncated: false });
    expect(artifact.observations).toHaveLength(2);
    expect(artifact.observations[0]?.elapsedMs).toBe(0);
    for (const observation of artifact.observations) {
      expect(Object.keys(observation).sort()).toEqual(["checkpoint", "elapsedMs", "outcome", "phase"]);
      expect(["collection", "setup", "body", "cleanup"]).toContain(observation.phase);
      expect([
        "support",
        "db-start",
        "server-spawn",
        "health-wait",
        "context",
        "fixture-create",
        "export",
        "new-import",
        "existing-preview",
        "existing-apply",
        "zip-import",
        "server-stop",
        "db-cleanup",
        "health-child-exit-observed",
        "health-deadline-branch",
        "health-response-non-ok",
        "health-fetch-rejected",
        "startup-workspace-prerequisites",
        "startup-server-import",
        "startup-server-start",
      ]).toContain(observation.checkpoint);
      expect(["enter", "pass", "throw", "unknown"]).toContain(observation.outcome);
      expect(observation.elapsedMs).toEqual(expect.any(Number));
      expect(Number.isInteger(observation.elapsedMs)).toBe(true);
      expect(observation.elapsedMs as number).toBeGreaterThanOrEqual(0);
      expect(observation.elapsedMs as number).toBeLessThanOrEqual(3_600_000);
      expect(Buffer.byteLength(JSON.stringify(observation), "utf8")).toBeLessThanOrEqual(256);
    }
    expect(contents).not.toContain(payload);
  });
  it("caps observations and marks the artifact truncated", async () => {
    let contents = "";
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    });

    for (let index = 0; index < 20; index += 1) {
      await diagnostics.run("body", "context", () => undefined);
    }

    const artifact = JSON.parse(contents) as {
      truncated: boolean;
      observations: unknown[];
    };
    expect(artifact.truncated).toBe(true);
    expect(artifact.observations).toHaveLength(38);
    expect(Buffer.byteLength(contents, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("records a closed throw outcome without serializing the thrown message", async () => {
    let contents = "";
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    });
    const originalError = new Error("sensitive error details");

    await expect(diagnostics.run("body", "export", () => {
      throw originalError;
    })).rejects.toBe(originalError);

    const artifact = JSON.parse(contents) as {
      observations: Array<{ outcome: string }>;
    };
    expect(artifact.observations.map((observation) => observation.outcome)).toEqual(["enter", "throw"]);
    expect(contents).not.toContain("sensitive error details");
  });

  it("preserves the original operation error when diagnostic writes fail", async () => {
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", () => {
      throw new Error("writer failure must not escape");
    });
    const originalError = new Error("original operation failure");

    await expect(diagnostics.run("setup", "db-start", () => {
      throw originalError;
    })).rejects.toBe(originalError);
  });
  it("leaves health-wait observation disabled without consulting the clock", () => {
    let writes = 0;
    const diagnostics = new PortabilityPhaseDiagnostics(undefined, () => {
      writes += 1;
    }, () => {
      throw new Error("disabled observer read the clock");
    });

    expect(diagnostics.createHealthWaitObserver(10)).toBeUndefined();
    expect(writes).toBe(0);
  });

  it("deduplicates poll classes and stops after its first terminal observation", () => {
    let contents = "";
    let timestamp = 105;
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    }, () => timestamp++);
    const observe = diagnostics.createHealthWaitObserver(100);
    expect(observe).toBeDefined();

    observe?.("health-response-non-ok");
    observe?.("health-response-non-ok");
    observe?.("health-fetch-rejected");
    observe?.("health-fetch-rejected");
    observe?.("health-child-exit-observed");
    observe?.("health-deadline-branch");
    observe?.("health-response-non-ok");

    const artifact = JSON.parse(contents) as {
      observations: Array<{ checkpoint: string; outcome: string; phase: string; elapsedMs: number }>;
    };
    expect(artifact.observations).toEqual([
      { phase: "setup", checkpoint: "health-response-non-ok", outcome: "unknown", elapsedMs: 5 },
      { phase: "setup", checkpoint: "health-fetch-rejected", outcome: "throw", elapsedMs: 6 },
      { phase: "setup", checkpoint: "health-child-exit-observed", outcome: "throw", elapsedMs: 7 },
    ]);
  });

  it("keeps overlapping health-wait observers independent and uses each original start", () => {
    let contents = "";
    const timestamps = [120, 220];
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    }, () => timestamps.shift() ?? 0);
    const first = diagnostics.createHealthWaitObserver(100);
    const second = diagnostics.createHealthWaitObserver(200);

    first?.("health-response-non-ok");
    second?.("health-fetch-rejected");

    const artifact = JSON.parse(contents) as {
      observations: Array<{ checkpoint: string; elapsedMs: number }>;
    };
    expect(artifact.observations).toEqual([
      { phase: "setup", checkpoint: "health-response-non-ok", outcome: "unknown", elapsedMs: 20 },
      { phase: "setup", checkpoint: "health-fetch-rejected", outcome: "throw", elapsedMs: 20 },
    ]);
  });

  it("contains artifact write failures without changing a rejected fetch error", () => {
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", () => {
      throw new Error("artifact failure");
    }, () => 10);
    const observe = diagnostics.createHealthWaitObserver(0);
    const originalError = new Error("fetch rejection");
    const waitFetch = () => {
      try {
        throw originalError;
      } catch (error) {
        observe?.("health-fetch-rejected");
        throw error;
      }
    };

    expect(waitFetch).toThrow(originalError);
  });

  it("contains clock failures without changing a rejected fetch error", () => {
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", () => undefined, () => {
      throw new Error("clock failure");
    });
    const observe = diagnostics.createHealthWaitObserver(0);
    const originalError = new Error("fetch rejection");
    const waitFetch = () => {
      try {
        throw originalError;
      } catch (error) {
        observe?.("health-fetch-rejected");
        throw error;
      }
    };

    expect(waitFetch).toThrow(originalError);
  });


  it("omits observations when the clock returns a non-finite elapsed value", () => {
    let contents = "";
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    }, () => Number.NaN);
    const observe = diagnostics.createHealthWaitObserver(0);

    expect(() => observe?.("health-response-non-ok")).not.toThrow();
    expect(contents).toBe("");
  });

  it("clamps health-wait elapsed time through the shared closed bounds", () => {
    let contents = "";
    const timestamps = [99, 3_600_501];
    const diagnostics = new PortabilityPhaseDiagnostics("fixture-output", (_path, data) => {
      contents = data;
    }, () => timestamps.shift() ?? 0);
    const observe = diagnostics.createHealthWaitObserver(100);

    observe?.("health-response-non-ok");
    observe?.("health-deadline-branch");

    const artifact = JSON.parse(contents) as {
      observations: Array<{ elapsedMs: number }>;
    };
    expect(artifact.observations.map(({ elapsedMs }) => elapsedMs)).toEqual([0, 3_600_000]);
  });
  it("decodes fragmented canonical startup frames in order", () => {
    const decoder = new StartupTimingFrameDecoder();
    expect(decoder.push("PAPERCLIP_TEST_CLI_STARTUP {\"checkpoint\":\"startup-workspace-prerequisites\",\"outcome\":\"enter\",\"elapsedMs\":0}\nPAPERCLIP_TEST_CLI_STARTUP {\"checkpoint\":" )).toEqual([
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "enter", elapsedMs: 0 },
    ]);
    expect(decoder.push("\"startup-workspace-prerequisites\",\"outcome\":\"pass\",\"elapsedMs\":3600000}\n")).toEqual([
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "pass", elapsedMs: 3_600_000 },
    ]);
  });

  it("rejects malformed, unknown, duplicate, out-of-order, oversized, and out-of-bound frames", () => {
    const decoder = new StartupTimingFrameDecoder();
    const frame = (checkpoint: string, outcome: string, elapsedMs: number) =>
      `PAPERCLIP_TEST_CLI_STARTUP ${JSON.stringify({ checkpoint, outcome, elapsedMs })}\n`;
    const rejected = decoder.push([
      frame("unknown", "enter", 0),
      "PAPERCLIP_TEST_CLI_STARTUP {bad}\n",
      `PAPERCLIP_TEST_CLI_STARTUP ${"x".repeat(300)}\n`,
      frame("startup-workspace-prerequisites", "enter", 1),
      frame("startup-workspace-prerequisites", "enter", 3_600_001),
      frame("startup-workspace-prerequisites", "enter", 0).replace("\n", " \n"),
    ].join(""));
    expect(rejected).toEqual([]);
    expect(decoder.push([
      frame("startup-workspace-prerequisites", "enter", 0),
      frame("startup-workspace-prerequisites", "enter", 0),
      frame("startup-workspace-prerequisites", "throw", 1),
      frame("startup-server-import", "enter", 0),
      frame("startup-server-import", "pass", 2),
      frame("startup-workspace-prerequisites", "enter", 0),
      frame("startup-server-start", "enter", 0),
      frame("startup-server-start", "pass", 3),
    ].join(""))).toEqual([
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "throw", elapsedMs: 1 },
      { phase: "setup", checkpoint: "startup-server-import", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-server-import", outcome: "pass", elapsedMs: 2 },
      { phase: "setup", checkpoint: "startup-server-start", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-server-start", outcome: "pass", elapsedMs: 3 },
    ]);
  });
  it("rejects unknown outcomes and terminals before enter without consuming later frames", () => {
    const decoder = new StartupTimingFrameDecoder();
    const frame = (checkpoint: string, outcome: string, elapsedMs = 0) =>
      `PAPERCLIP_TEST_CLI_STARTUP ${JSON.stringify({ checkpoint, outcome, elapsedMs })}\n`;
    expect(decoder.push([
      frame("startup-workspace-prerequisites", "pass"),
      frame("startup-workspace-prerequisites", "unknown"),
      frame("startup-workspace-prerequisites", "enter"),
      frame("startup-workspace-prerequisites", "unknown"),
      frame("startup-server-import", "throw", 1),
      frame("startup-workspace-prerequisites", "pass", 2),
      frame("startup-server-import", "enter"),
      frame("startup-server-import", "throw", 3),
      frame("startup-server-start", "enter"),
      frame("startup-server-start", "pass", 4),
    ].join(""))).toEqual([
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-workspace-prerequisites", outcome: "pass", elapsedMs: 2 },
      { phase: "setup", checkpoint: "startup-server-import", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-server-import", outcome: "throw", elapsedMs: 3 },
      { phase: "setup", checkpoint: "startup-server-start", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-server-start", outcome: "pass", elapsedMs: 4 },
    ]);
  });

  it("accepts ordered frames when a dev-only startup span was not executed", () => {
    const decoder = new StartupTimingFrameDecoder();
    const frame = (checkpoint: string, outcome: string) =>
      `PAPERCLIP_TEST_CLI_STARTUP ${JSON.stringify({ checkpoint, outcome, elapsedMs: 0 })}\n`;
    expect(decoder.push(
      frame("startup-server-import", "enter") + frame("startup-server-import", "pass"),
    )).toEqual([
      { phase: "setup", checkpoint: "startup-server-import", outcome: "enter", elapsedMs: 0 },
      { phase: "setup", checkpoint: "startup-server-import", outcome: "pass", elapsedMs: 0 },
    ]);
  });


  it("keeps disabled timing observations free of clock and artifact side effects", async () => {
    let writes = 0;
    const diagnostics = new PortabilityPhaseDiagnostics(undefined, () => { writes += 1; }, () => {
      throw new Error("disabled diagnostics consulted clock");
    });
    diagnostics.recordStartupTiming({
      phase: "setup",
      checkpoint: "startup-server-start",
      outcome: "pass",
      elapsedMs: 0,
    });
    expect(await diagnostics.run("setup", "startup-server-start", () => "unchanged")).toBe("unchanged");
    expect(writes).toBe(0);
  });
});
