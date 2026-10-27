import { describe, expect, it } from "vitest";
import {
  governanceOperationExceptionAdmissionSchema,
  governanceOperationExceptionPauseSchema,
  governanceOperationExceptionResolveSchema,
  governanceOperationExceptionResumeSchema,
} from "./governance-operations.js";

describe("governance operations exception contract", () => {
  it("requires an explicit accountable owner, offset-qualified deadline, and reason", () => {
    const valid = governanceOperationExceptionAdmissionSchema.safeParse({
      reason: "The scheduled handoff is waiting on an external prerequisite.",
      ownerUserId: "d7565748-cc8c-446c-9202-a4a0f871b341",
      deadlineAt: "2026-10-27T12:00:00+00:00",
    });
    expect(valid.success).toBe(true);
    expect(governanceOperationExceptionAdmissionSchema.safeParse({ reason: "late", deadlineAt: "2026-10-27T12:00:00" }).success).toBe(false);
    expect(governanceOperationExceptionAdmissionSchema.safeParse({
      reason: " ", ownerUserId: "d7565748-cc8c-446c-9202-a4a0f871b341", deadlineAt: "2026-10-27T12:00:00Z",
    }).success).toBe(false);
  });

  it("requires optimistic revisions for every clock or resolution transition", () => {
    const reason = "Waiting for the accountable owner to confirm the next step.";
    expect(governanceOperationExceptionPauseSchema.safeParse({ expectedRevision: 1, reason }).success).toBe(true);
    expect(governanceOperationExceptionResumeSchema.safeParse({ expectedRevision: 1 }).success).toBe(true);
    expect(governanceOperationExceptionResolveSchema.safeParse({ expectedRevision: 1, reason }).success).toBe(true);
    expect(governanceOperationExceptionPauseSchema.safeParse({ expectedRevision: 0, reason }).success).toBe(false);
    expect(governanceOperationExceptionResumeSchema.safeParse({}).success).toBe(false);
    expect(governanceOperationExceptionResolveSchema.safeParse({ expectedRevision: 1, reason: " " }).success).toBe(false);
  });
});
