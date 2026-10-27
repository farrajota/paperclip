import { describe, expect, it } from "vitest";
import { PortabilityPhaseDiagnostics } from "./portability-phase-diagnostics.js";

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
    expect(artifact.observations).toHaveLength(32);
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
});
