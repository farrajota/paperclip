import { writeFileSync } from "node:fs";

export type PortabilityPhase = "collection" | "setup" | "body" | "cleanup";
export type PortabilityCheckpoint =
  | "support"
  | "db-start"
  | "server-spawn"
  | "health-wait"
  | "context"
  | "fixture-create"
  | "export"
  | "new-import"
  | "existing-preview"
  | "existing-apply"
  | "zip-import"
  | "server-stop"
  | "db-cleanup"
  | "health-child-exit-observed"
  | "health-deadline-branch"
  | "health-response-non-ok"
  | "health-fetch-rejected"
  | "startup-workspace-prerequisites"
  | "startup-server-import"
  | "startup-server-start";
export type HealthWaitCheckpoint =
  | "health-child-exit-observed"
  | "health-deadline-branch"
  | "health-response-non-ok"
  | "health-fetch-rejected";
export type PortabilityOutcome = "enter" | "pass" | "throw" | "unknown";

export interface PortabilityObservation {
  phase: PortabilityPhase;
  checkpoint: PortabilityCheckpoint;
  outcome: PortabilityOutcome;
  elapsedMs: number;
}

interface PortabilityArtifact {
  schemaVersion: 1;
  truncated: boolean;
  observations: PortabilityObservation[];
}

const MAX_OBSERVATIONS = 38;
const MAX_OBSERVATION_BYTES = 256;
const MAX_ARTIFACT_BYTES = 8192;
const MAX_ELAPSED_MS = 3_600_000;
const STARTUP_TIMING_PREFIX = "PAPERCLIP_TEST_CLI_STARTUP ";
const STARTUP_TIMING_CHECKPOINTS = [
  "startup-workspace-prerequisites",
  "startup-server-import",
  "startup-server-start",
] as const;
const MAX_STARTUP_TIMING_FRAMES = 6;

export class StartupTimingFrameDecoder {
  private line = "";
  private overflow = false;
  private nextCheckpointIndex = 0;
  private activeCheckpointIndex = -1;
  private expectingTerminal = false;
  private acceptedFrames = 0;

  push(chunk: string): PortabilityObservation[] {
    const observations: PortabilityObservation[] = [];
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index]!;
      if (character === "\n") {
        if (!this.overflow) {
          const observation = this.decodeLine(this.line);
          if (observation) observations.push(observation);
        }
        this.line = "";
        this.overflow = false;
        continue;
      }
      if (!this.overflow) {
        this.line += character;
        if (this.line.length > MAX_OBSERVATION_BYTES || utf8Bytes(this.line) > MAX_OBSERVATION_BYTES) {
          this.line = "";
          this.overflow = true;
        }
      }
    }
    return observations;
  }

  private decodeLine(line: string): PortabilityObservation | undefined {
    if (!line.startsWith(STARTUP_TIMING_PREFIX) || this.acceptedFrames >= MAX_STARTUP_TIMING_FRAMES) return;
    const json = line.slice(STARTUP_TIMING_PREFIX.length);
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "checkpoint,elapsedMs,outcome") return;
    const checkpointIndex = STARTUP_TIMING_CHECKPOINTS.indexOf(record.checkpoint as (typeof STARTUP_TIMING_CHECKPOINTS)[number]);
    if (checkpointIndex < this.nextCheckpointIndex || checkpointIndex >= STARTUP_TIMING_CHECKPOINTS.length) return;
    if (this.expectingTerminal && checkpointIndex !== this.activeCheckpointIndex) return;
    if (this.expectingTerminal
      ? record.outcome !== "pass" && record.outcome !== "throw"
      : record.outcome !== "enter") return;
    const checkpoint = STARTUP_TIMING_CHECKPOINTS[checkpointIndex] as (typeof STARTUP_TIMING_CHECKPOINTS)[number];
    if (!Number.isInteger(record.elapsedMs) || (record.elapsedMs as number) < 0 ||
      (record.elapsedMs as number) > MAX_ELAPSED_MS ||
      (record.outcome === "enter" && record.elapsedMs !== 0)) return;
    if (json !== JSON.stringify({
      checkpoint: record.checkpoint,
      outcome: record.outcome,
      elapsedMs: record.elapsedMs,
    })) return;

    this.acceptedFrames += 1;
    if (this.expectingTerminal) {
      this.nextCheckpointIndex = checkpointIndex + 1;
      this.activeCheckpointIndex = -1;
      this.expectingTerminal = false;
    } else {
      this.activeCheckpointIndex = checkpointIndex;
      this.expectingTerminal = true;
    }
    return {
      phase: "setup",
      checkpoint,
      outcome: record.outcome as "enter" | "pass" | "throw",
      elapsedMs: record.elapsedMs as number,
    };
  }

}


type WriteArtifact = (path: string, contents: string, encoding: "utf8") => void;


function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isValidObservation(observation: PortabilityObservation): boolean {
  return (
    Number.isInteger(observation.elapsedMs) &&
    observation.elapsedMs >= 0 &&
    observation.elapsedMs <= MAX_ELAPSED_MS &&
    utf8Bytes(JSON.stringify(observation)) <= MAX_OBSERVATION_BYTES
  );
}

export class PortabilityPhaseDiagnostics {
  private readonly observations: PortabilityObservation[] = [];
  private truncated = false;

  constructor(
    private readonly outputPath: string | undefined,
    private readonly writeArtifact: WriteArtifact = writeFileSync,
    private readonly now: () => number = Date.now,
  ) {}
  recordStartupTiming(observation: PortabilityObservation): void {
    if (!this.outputPath || observation.phase !== "setup" ||
      !STARTUP_TIMING_CHECKPOINTS.includes(observation.checkpoint as (typeof STARTUP_TIMING_CHECKPOINTS)[number]) ||
      (observation.outcome !== "enter" && observation.outcome !== "pass" && observation.outcome !== "throw")) return;
    this.record(observation);
  }


  createHealthWaitObserver(startedAt: number): ((checkpoint: HealthWaitCheckpoint) => void) | undefined {
    if (!this.outputPath) return undefined;

    let sawNonOkResponse = false;
    let sawFetchRejection = false;
    let terminalObserved = false;

    return (checkpoint) => {
      if (
        checkpoint !== "health-child-exit-observed" &&
        checkpoint !== "health-deadline-branch" &&
        checkpoint !== "health-response-non-ok" &&
        checkpoint !== "health-fetch-rejected"
      ) {
        return;
      }
      if (terminalObserved) return;
      if (checkpoint === "health-response-non-ok") {
        if (sawNonOkResponse) return;
        sawNonOkResponse = true;
      } else if (checkpoint === "health-fetch-rejected") {
        if (sawFetchRejection) return;
        sawFetchRejection = true;
      } else {
        terminalObserved = true;
      }

      try {
        const outcome: PortabilityOutcome = checkpoint === "health-response-non-ok" ? "unknown" : "throw";
        this.record({
          phase: "setup",
          checkpoint,
          outcome,
          elapsedMs: this.elapsedSince(startedAt),
        });
      } catch {
        // Health-wait observation must not affect the request or its original error.
      }
    };
  }

  async run<T>(
    phase: PortabilityPhase,
    checkpoint: PortabilityCheckpoint,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.outputPath) return operation();
    this.record({ phase, checkpoint, outcome: "enter", elapsedMs: 0 });
    const startedAt = this.now();
    try {
      const result = await operation();
      this.record({ phase, checkpoint, outcome: "pass", elapsedMs: this.elapsedSince(startedAt) });
      return result;
    } catch (error) {
      this.record({ phase, checkpoint, outcome: "throw", elapsedMs: this.elapsedSince(startedAt) });
      throw error;
    }
  }

  runSync<T>(
    phase: PortabilityPhase,
    checkpoint: PortabilityCheckpoint,
    operation: () => T,
  ): T {
    if (!this.outputPath) return operation();
    this.record({ phase, checkpoint, outcome: "enter", elapsedMs: 0 });
    const startedAt = this.now();
    try {
      const result = operation();
      this.record({ phase, checkpoint, outcome: "pass", elapsedMs: this.elapsedSince(startedAt) });
      return result;
    } catch (error) {
      this.record({ phase, checkpoint, outcome: "throw", elapsedMs: this.elapsedSince(startedAt) });
      throw error;
    }
  }

  private elapsedSince(startedAt: number): number {
    const elapsedMs = Math.floor(this.now() - startedAt);
    if (!Number.isFinite(elapsedMs)) return Number.NaN;
    if (elapsedMs <= 0) return 0;
    if (elapsedMs >= MAX_ELAPSED_MS) return MAX_ELAPSED_MS;
    return elapsedMs;
  }


  private record(observation: PortabilityObservation): void {
    if (!isValidObservation(observation)) return;

    if (this.observations.length === MAX_OBSERVATIONS) {
      this.truncated = true;
      this.persist();
      return;
    }

    this.observations.push(observation);
    const artifact: PortabilityArtifact = {
      schemaVersion: 1,
      truncated: true,
      observations: this.observations,
    };
    if (utf8Bytes(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES) {
      this.observations.pop();
      this.truncated = true;
    }
    this.persist();
  }

  private persist(): void {
    if (!this.outputPath) return;

    try {
      const contents = JSON.stringify({
        schemaVersion: 1,
        truncated: this.truncated,
        observations: this.observations,
      });
      if (utf8Bytes(contents) <= MAX_ARTIFACT_BYTES) {
        this.writeArtifact(this.outputPath, contents, "utf8");
      }
    } catch {
      // Diagnostic output must never replace the lifecycle's original result.
    }
  }
}

