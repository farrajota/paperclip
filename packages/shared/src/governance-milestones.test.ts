import { describe, expect, it } from "vitest";
import {
  milestoneContractInputSchema,
  milestoneEvidenceInputSchema,
} from "./governance-milestones.js";

const taskId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";
const documentRevisionId = "00000000-0000-4000-8000-000000000003";
const verifierId = "00000000-0000-4000-8000-000000000004";

const contract = {
  title: "Launch readiness",
  playbookBinding: { documentId, documentRevisionId },
  requiredDeliverables: [
    {
      key: "brief",
      label: "Approved brief",
      evidenceKind: "document_revision",
      reference: { kind: "document", documentId },
      maxAgeHours: 72,
    },
    {
      key: "task",
      label: "Completed prerequisite",
      evidenceKind: "issue_completion",
      reference: { kind: "task", taskId },
      maxAgeHours: null,
    },
  ],
  executorPolicy: { kind: "any_internal_agent" },
  reviewerPolicy: { kind: "independent_internal_agent", agentId: verifierId },
  followups: [{ actionKey: "announce", title: "Prepare launch announcement" }],
};

describe("milestone contracts", () => {
  it("requires an exact playbook revision, resource-bound deliverables, and an authorized verifier", () => {
    expect(milestoneContractInputSchema.safeParse(contract).success).toBe(true);
    expect(milestoneContractInputSchema.safeParse({
      ...contract,
      reviewerPolicy: { kind: "independent_internal_agent" },
    }).success).toBe(false);
    expect(milestoneContractInputSchema.safeParse({
      ...contract,
      requiredDeliverables: [{ ...contract.requiredDeliverables[0], reference: { kind: "task", taskId } }],
    }).success).toBe(false);
    expect(milestoneContractInputSchema.safeParse({
      ...contract,
      requiredDeliverables: [{ ...contract.requiredDeliverables[0], reference: { kind: "document", documentId: "not-a-uuid" } }],
    }).success).toBe(false);
  });

  it("does not allow one native artifact to satisfy multiple named requirements", () => {
    expect(milestoneContractInputSchema.safeParse({
      ...contract,
      requiredDeliverables: [
        contract.requiredDeliverables[1],
        { ...contract.requiredDeliverables[1], key: "same-task-again" },
      ],
    }).success).toBe(false);
  });

  it("requires an exact native source product identity, not an interchangeable product class", () => {
    const reference = { kind: "work_product", issueId: taskId, productType: "artifact", provider: "paperclip" };
    const value = { ...contract, requiredDeliverables: [{ key: "product", label: "Promoted source", evidenceKind: "work_product", reference }] };
    expect(milestoneContractInputSchema.safeParse(value).success).toBe(false);
    expect(milestoneContractInputSchema.safeParse({ ...value, requiredDeliverables: [{ ...value.requiredDeliverables[0], reference: { ...reference, workProductId: documentId } }] }).success).toBe(true);
  });

  it("rejects arbitrary external evidence claims", () => {
    expect(milestoneEvidenceInputSchema.safeParse({
      deliverableKey: "brief",
      evidenceKind: "external_url",
      artifactId: "not-a-stored-artifact",
      expectedRevision: 1,
      expectedEvidenceVersion: 0,
    }).success).toBe(false);
  });

  it("binds evidence submission to the observed contract and evidence version", () => {
    expect(milestoneEvidenceInputSchema.safeParse({
      deliverableKey: "brief",
      evidenceKind: "document_revision",
      artifactId: documentRevisionId,
      expectedRevision: 1,
      expectedEvidenceVersion: 0,
    }).success).toBe(true);
    expect(milestoneEvidenceInputSchema.safeParse({
      deliverableKey: "brief",
      evidenceKind: "document_revision",
      artifactId: documentRevisionId,
      expectedRevision: 1,
    }).success).toBe(false);
  });
});
