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
  | "db-cleanup";
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

const MAX_OBSERVATIONS = 32;
const MAX_OBSERVATION_BYTES = 256;
const MAX_ARTIFACT_BYTES = 8192;
const MAX_ELAPSED_MS = 3_600_000;

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

