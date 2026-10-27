import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authSessions, boardApiKeys, caseAccessSources, caseDocuments, caseHandoffs, caseIssueLinks, cases, companies, companyMemberships, documentRevisions, documents, heartbeatRuns, instanceUserRoles, issueAccessGrants, issueWorkProducts, issues, principalPermissionGrants, projectAccessMembers, projects } from "@paperclipai/db";
import {
  governanceMilestoneDecisions,
  governanceMilestoneEvidence,
  governanceMilestoneEvents,
  governanceMilestoneFollowups,
  governanceMilestoneRevisions,
  governanceMilestones,
} from "@paperclipai/db/schema/governance_milestones";
import {
  milestoneContractInputSchema,
  type MilestoneContractInput,
  type MilestoneDecisionInput,
  type MilestoneEvidenceInput,
  type MilestoneExecutor,
  type MilestoneReadiness,
  type MilestoneReadinessReason,
} from "@paperclipai/shared/governance-milestones";
import { agentApiKeyScopeSchema, isUuidLike, LOW_TRUST_REVIEW_PRESET, normalizeAgentApiKeyScope } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { authorizeCaseMutation } from "./case-mutation-authorization.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { assertActorCanReadCase, assertActorCanWriteCase, retainCaseAccessSource } from "./case-access.js";
import { issueService } from "./issues.js";

type MilestoneTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MilestoneClient = Db | MilestoneTransaction;

const sourceTrustQuarantineSchema = z.object({
  preset: z.literal(LOW_TRUST_REVIEW_PRESET),
  disposition: z.literal("quarantined"),
  sourceIssueId: z.string().uuid(),
  sourceRunId: z.string().uuid().nullable().optional(),
  sourceAgentId: z.string().uuid().nullable().optional(),
}).passthrough();

const sourceTrustPromotionSchema = z.object({
  preset: z.literal(LOW_TRUST_REVIEW_PRESET),
  disposition: z.literal("promoted"),
  sourceIssueId: z.string().uuid(),
  promotedFrom: z.object({
    artifactKind: z.enum(["comment", "document", "work_product", "issue"]),
    artifactId: z.string().uuid(),
    issueId: z.string().uuid(),
  }).strict(),
  promotedByActorType: z.enum(["agent", "user", "system"]),
  promotedByActorId: z.string().min(1),
  promotedAt: z.string().datetime(),
}).passthrough();

const sourceTrustMetadataSchema = z.discriminatedUnion("disposition", [sourceTrustQuarantineSchema, sourceTrustPromotionSchema]);
const workProductMetadataSchema = z.object({
  promotion: z.object({
    sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
    sourceArtifactId: z.string().uuid(),
  }).strict(),
}).passthrough();
const producerRunSnapshotSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  issueId: z.string().uuid().nullable(),
  nativeIssueId: z.string().uuid().nullable(),
  status: z.string(),
  runtimeMode: z.string(),
  finishedAt: z.string().datetime().nullable(),
}).strict();
const producerSnapshotSchema = z.object({
  agentId: z.string().uuid().nullable(),
  userId: z.string().nullable(),
  runId: z.string().uuid().nullable(),
  run: producerRunSnapshotSchema.nullable(),
}).strict();
const playbookSnapshotSchema = z.object({
  documentId: z.string().uuid(),
  documentRevisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTrust: sourceTrustPromotionSchema.nullable(),
  provenance: z.object({ producer: producerSnapshotSchema, createdAt: z.string().datetime() }).strict(),
}).strict();
const promotionProofSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: playbookSnapshotSchema,
}).strict();
const recordedAuthoritySchema = z.object({
  type: z.enum(["board", "agent"]),
  source: z.enum(["local_implicit", "session", "board_key", "agent_key", "agent_jwt", "mcp_oauth", "cloud_tenant", "cloud_control"]).optional(),
  userId: z.string().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  keyId: z.string().uuid().nullable().optional(),
  keyScope: agentApiKeyScopeSchema.nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  onBehalfOfUserId: z.string().nullable().optional(),
  authorizingUserId: z.string().nullable().optional(),
  ignoreInstanceAdmin: z.boolean().optional(),
}).strict();
const acceptedEventPayloadSchema = z.object({
  reviewerAuthorization: recordedAuthoritySchema,
  executorAuthorization: recordedAuthoritySchema.nullable(),
}).passthrough();

interface MilestoneArtifactSnapshot {
  artifactRevision: number | null;
  artifactHash: string;
  sourceTrust: z.infer<typeof sourceTrustPromotionSchema> | null;
  provenance: Record<string, unknown>;
  createdAt: Date;
  producerAgentIds: string[];
  producerUserIds: string[];
}

type PlaybookSnapshot = z.infer<typeof playbookSnapshotSchema>;

interface InspectedReadiness {
  readiness: MilestoneReadiness;
  producerAgentIds: string[];
  producerUserIds: string[];
}

export interface MilestoneActor {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  authorizationActor?: AuthorizationActor;
}

function jsonEqual(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function trustedSourceTrust(value: unknown): z.infer<typeof sourceTrustPromotionSchema> | null {
  if (value == null) return null;
  const parsed = sourceTrustMetadataSchema.safeParse(value);
  if (!parsed.success) throw unprocessable("Artifact source-trust metadata is unverified");
  if (parsed.data.disposition === "quarantined") throw unprocessable("Quarantined artifact cannot satisfy a milestone deliverable");
  return parsed.data;
}

function promotableActor(actor: MilestoneActor) {
  return actor.authorizationActor?.type === "board" && !!actor.userId && actor.authorizationActor.userId === actor.userId;
}

function requireAuthorizationActor(actor: MilestoneActor): AuthorizationActor {
  const authorizationActor = actor.authorizationActor;
  if (!authorizationActor || authorizationActor.type === "none") throw forbidden("A canonical authorized actor is required");
  if (authorizationActor.type === "board" && (!actor.userId || actor.userId !== authorizationActor.userId)) throw forbidden("Board actor identity is unavailable");
  if (authorizationActor.type === "agent" && (!actor.agentId || actor.agentId !== authorizationActor.agentId)) throw forbidden("Agent actor identity is unavailable");
  return authorizationActor;
}

function effectiveExecutor(task: Pick<typeof issues.$inferSelect, "assigneeAgentId" | "assigneeUserId"> | undefined, contract: MilestoneContractInput) {
  return {
    agentId: task?.assigneeAgentId ?? (contract.executorPolicy.kind === "assigned_agent" ? contract.executorPolicy.agentId : null),
    userId: task?.assigneeUserId ?? null,
  };
}

function recordedAuthorityWithCurrentAttestation(recorded: AuthorizationActor, current?: AuthorizationActor): AuthorizationActor {
  // Stored provenance cannot mint a new cloud attestation. Only this request's
  // canonical matching cloud principal can supply its exceptional privilege.
  if (recorded.type === "board" && recorded.source === "cloud_tenant"
    && current?.type === "board" && current.source === "cloud_tenant" && current.userId === recorded.userId) {
    return { ...recorded, isInstanceAdmin: current.isInstanceAdmin, ignoreInstanceAdmin: current.ignoreInstanceAdmin };
  }
  return recorded;
}

async function caseTaskIsLinked(client: MilestoneClient, companyId: string, caseId: string, primaryIssueId: string, taskId: string) {
  if (taskId === primaryIssueId) return true;
  const [linked] = await client.select({ id: caseIssueLinks.id }).from(caseIssueLinks).where(and(
    eq(caseIssueLinks.companyId, companyId),
    eq(caseIssueLinks.caseId, caseId),
    eq(caseIssueLinks.issueId, taskId),
    eq(caseIssueLinks.role, "work"),
  )).limit(1);
  return !!linked;
}

export function governanceMilestoneService(db: Db) {
  async function getMilestone(companyId: string, milestoneId: string, client: MilestoneClient = db) {
    const [row] = await client.select().from(governanceMilestones).where(and(
      eq(governanceMilestones.id, milestoneId),
      eq(governanceMilestones.companyId, companyId),
    )).limit(1);
    if (!row) throw notFound("Milestone not found");
    return row;
  }

  async function getActiveRevision(companyId: string, milestoneId: string, client: MilestoneClient = db) {
    const [row] = await client.select().from(governanceMilestoneRevisions).where(and(
      eq(governanceMilestoneRevisions.companyId, companyId),
      eq(governanceMilestoneRevisions.milestoneId, milestoneId),
      or(eq(governanceMilestoneRevisions.state, "active"), eq(governanceMilestoneRevisions.state, "accepted")),
    )).orderBy(desc(governanceMilestoneRevisions.revision)).limit(1);
    return row ?? null;
  }

  async function validateProducer(client: MilestoneClient, input: {
    companyId: string;
    caseId: string;
    primaryIssueId: string;
    agentId?: string | null;
    userId?: string | null;
    runId?: string | null;
    expectedIssueId?: string | null;
  }) {
    let producerAgentId = input.agentId ?? null;
    let runSnapshot: z.infer<typeof producerRunSnapshotSchema> | null = null;
    if (input.runId) {
      const [run] = await client.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      )).limit(1);
      if (!run || run.status !== "succeeded" || (producerAgentId && producerAgentId !== run.agentId)) {
        throw unprocessable("Artifact producer run is not a successful company-scoped run");
      }
      producerAgentId = run.agentId;
      const sourceIssueId = run.nativeIssueId ?? run.issueId;
      if (!sourceIssueId || (input.expectedIssueId && sourceIssueId !== input.expectedIssueId)) {
        throw unprocessable("Artifact producer run is not bound to the referenced task");
      }
      if (!(await caseTaskIsLinked(client, input.companyId, input.caseId, input.primaryIssueId, sourceIssueId))) {
        throw unprocessable("Artifact producer run is outside the case task graph");
      }
      const [producerTask] = await client.select({ status: issues.status }).from(issues).where(and(
        eq(issues.id, sourceIssueId), eq(issues.companyId, input.companyId),
      )).limit(1);
      if (!producerTask || producerTask.status !== "done") throw unprocessable("Artifact producer task has not completed successfully");
      runSnapshot = {
        id: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        issueId: run.issueId,
        nativeIssueId: run.nativeIssueId,
        status: run.status,
        runtimeMode: run.runtimeMode,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      };
    }
    if (producerAgentId) {
      const [agent] = await client.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, producerAgentId), eq(agents.companyId, input.companyId),
      )).limit(1);
      if (!agent) throw unprocessable("Artifact producer is not a current company agent");
    }
    return {
      agentId: producerAgentId,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      run: runSnapshot,
    };
  }

  async function readPlaybookSnapshot(client: MilestoneClient, companyId: string, caseId: string, primaryIssueId: string, binding: MilestoneContractInput["playbookBinding"]): Promise<PlaybookSnapshot> {
    const [row] = await client.select({ document: documents, revision: documentRevisions })
      .from(documentRevisions)
      .innerJoin(documents, eq(documents.id, documentRevisions.documentId))
      .innerJoin(caseDocuments, and(
        eq(caseDocuments.documentId, documents.id),
        eq(caseDocuments.caseId, caseId),
        eq(caseDocuments.companyId, companyId),
      ))
      .where(and(
        eq(documents.id, binding.documentId),
        eq(documents.companyId, companyId),
        eq(documentRevisions.id, binding.documentRevisionId),
        eq(documentRevisions.companyId, companyId),
      )).limit(1);
    if (!row) throw unprocessable("Approved playbook revision is not stored and case-linked");
    if (row.document.latestRevisionId !== row.revision.id
      || row.document.latestRevisionNumber !== row.revision.revisionNumber
      || row.document.latestBody !== row.revision.body) {
      throw conflict("Pinned playbook revision is no longer current");
    }
    const sourceTrust = trustedSourceTrust(row.document.sourceTrust);
    const producer = await validateProducer(client, {
      companyId,
      caseId,
      primaryIssueId,
      agentId: row.revision.createdByAgentId,
      userId: row.revision.createdByUserId,
      runId: row.revision.createdByRunId,
    });
    const provenance = { producer, createdAt: row.revision.createdAt.toISOString() };
    return {
      documentId: row.document.id,
      documentRevisionId: row.revision.id,
      revisionNumber: row.revision.revisionNumber,
      contentHash: sha256(row.revision.body),
      sourceTrust,
      provenance,
    };
  }

  async function validateContractResources(client: MilestoneClient, companyId: string, caseId: string, primaryIssueId: string, contract: MilestoneContractInput) {
    await readPlaybookSnapshot(client, companyId, caseId, primaryIssueId, contract.playbookBinding);
    const authorizedAgentIds = [
      ...(contract.executorPolicy.kind === "assigned_agent" ? [contract.executorPolicy.agentId] : []),
      ...(contract.reviewerPolicy.kind === "independent_internal_agent" ? [contract.reviewerPolicy.agentId] : []),
    ];
    for (const agentId of authorizedAgentIds) {
      const [agent] = await client.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, agentId), eq(agents.companyId, companyId),
      )).limit(1);
      if (!agent) throw unprocessable("Contract actor must be a current internal agent in this company");
    }
    for (const deliverable of contract.requiredDeliverables) {
      const reference = deliverable.reference;
      if (reference.kind === "document") {
        const [linked] = await client.select({ id: caseDocuments.id }).from(caseDocuments).innerJoin(
          documents,
          and(eq(documents.id, caseDocuments.documentId), eq(documents.companyId, companyId)),
        ).where(and(
          eq(caseDocuments.companyId, companyId),
          eq(caseDocuments.caseId, caseId),
          eq(caseDocuments.documentId, reference.documentId),
        )).limit(1);
        if (!linked) throw unprocessable("Required document is not linked to this case");
      } else if (reference.kind === "task") {
        const [task] = await client.select({ id: issues.id }).from(issues).where(and(
          eq(issues.id, reference.taskId), eq(issues.companyId, companyId),
        )).limit(1);
        if (!task || !(await caseTaskIsLinked(client, companyId, caseId, primaryIssueId, reference.taskId))) {
          throw unprocessable("Required task is not part of this case task graph");
        }
      } else {
        const [task] = await client.select({ id: issues.id }).from(issues).where(and(
          eq(issues.id, reference.issueId), eq(issues.companyId, companyId),
        )).limit(1);
        if (!task || !(await caseTaskIsLinked(client, companyId, caseId, primaryIssueId, reference.issueId))) {
          throw unprocessable("Required work-product task is not part of this case task graph");
        }
        const [product] = await client.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
          eq(issueWorkProducts.id, reference.workProductId), eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.issueId, reference.issueId), eq(issueWorkProducts.type, reference.productType), eq(issueWorkProducts.provider, reference.provider),
        )).limit(1);
        if (!product) throw unprocessable("Required work product does not match its exact native source identity");
      }
    }
  }

  async function validateArtifact(client: MilestoneClient, companyId: string, milestone: typeof governanceMilestones.$inferSelect, deliverable: MilestoneContractInput["requiredDeliverables"][number], artifactId: string): Promise<MilestoneArtifactSnapshot> {
    const reference = deliverable.reference;
    if (deliverable.evidenceKind === "document_revision" && reference.kind === "document") {
      const [row] = await client.select({ revision: documentRevisions, document: documents })
        .from(documentRevisions)
        .innerJoin(documents, eq(documents.id, documentRevisions.documentId))
        .innerJoin(caseDocuments, and(
          eq(caseDocuments.documentId, documents.id),
          eq(caseDocuments.caseId, milestone.caseId),
          eq(caseDocuments.companyId, companyId),
        ))
        .where(and(
          eq(documentRevisions.id, artifactId),
          eq(documentRevisions.documentId, reference.documentId),
          eq(documentRevisions.companyId, companyId),
          eq(documents.companyId, companyId),
        )).limit(1);
      if (!row || row.document.latestRevisionId !== row.revision.id
        || row.document.latestRevisionNumber !== row.revision.revisionNumber
        || row.document.latestBody !== row.revision.body) {
        throw unprocessable("Document revision is not the current case-linked stored artifact");
      }
      const sourceTrust = trustedSourceTrust(row.document.sourceTrust);
      const producer = await validateProducer(client, {
        companyId,
        caseId: milestone.caseId,
        primaryIssueId: milestone.issueId,
        agentId: row.revision.createdByAgentId,
        userId: row.revision.createdByUserId,
        runId: row.revision.createdByRunId,
      });
      const provenance = { producer, documentId: row.document.id, documentRevisionId: row.revision.id };
      return {
        artifactRevision: row.revision.revisionNumber,
        artifactHash: sha256(row.revision.body),
        sourceTrust,
        provenance,
        createdAt: row.revision.createdAt,
        producerAgentIds: producer.agentId ? [producer.agentId] : [],
        producerUserIds: producer.userId ? [producer.userId] : [],
      };
    }

    if (deliverable.evidenceKind === "issue_completion" && reference.kind === "task" && reference.taskId === artifactId) {
      const [task] = await client.select().from(issues).where(and(
        eq(issues.id, artifactId), eq(issues.companyId, companyId),
      )).limit(1);
      if (!task || !(await caseTaskIsLinked(client, companyId, milestone.caseId, milestone.issueId, task.id)) || task.status !== "done") {
        throw unprocessable("Referenced case task has not completed successfully");
      }
      const sourceTrust = trustedSourceTrust(task.sourceTrust);
      const producer = await validateProducer(client, { companyId, caseId: milestone.caseId, primaryIssueId: milestone.issueId,
        agentId: task.assigneeAgentId, userId: task.assigneeUserId, runId: task.executionRunId, expectedIssueId: task.id });
      const provenance = {
        taskId: task.id,
        status: task.status,
        statusVersion: task.statusVersion,
        updatedAt: task.updatedAt.toISOString(),
        assigneeAgentId: task.assigneeAgentId,
        assigneeUserId: task.assigneeUserId,
        executionRunId: task.executionRunId,
        producer,
      };
      return {
        artifactRevision: Number(task.statusVersion),
        artifactHash: sha256({ taskId: task.id, status: task.status, statusVersion: task.statusVersion, updatedAt: task.updatedAt.toISOString(), sourceTrust, provenance }),
        sourceTrust,
        provenance,
        createdAt: task.updatedAt,
        producerAgentIds: producer.agentId ? [producer.agentId] : [],
        producerUserIds: producer.userId ? [producer.userId] : [],
      };
    }

    if (deliverable.evidenceKind === "work_product" && reference.kind === "work_product"
      && reference.issueId && artifactId) {
      const [product] = await client.select().from(issueWorkProducts).where(and(
        eq(issueWorkProducts.id, artifactId),
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, reference.issueId),
      )).limit(1);
      if (!product || !(await caseTaskIsLinked(client, companyId, milestone.caseId, milestone.issueId, product.issueId))) {
        throw unprocessable("Work product is not the bound case task artifact");
      }
      const productTrust = trustedSourceTrust(product.sourceTrust);
      if (!productTrust || product.status !== "approved" || product.reviewState !== "approved") {
        throw unprocessable("Work product has no authoritative native acceptance receipt");
      }
      if (product.type !== "artifact" || product.provider !== "paperclip") throw unprocessable("Work product has no supported native acceptance receipt");
      const promotedFrom = productTrust.promotedFrom;
      const metadataPromotion = workProductMetadataSchema.safeParse(product.metadata);
      if (promotedFrom.artifactKind !== "work_product"
        || !metadataPromotion.success
        || metadataPromotion.data.promotion.sourceArtifactKind !== promotedFrom.artifactKind
        || metadataPromotion.data.promotion.sourceArtifactId !== promotedFrom.artifactId) {
        throw unprocessable("Work product acceptance receipt is not a native stored promotion");
      }
      const [source] = await client.select().from(issueWorkProducts).where(and(
        eq(issueWorkProducts.id, promotedFrom.artifactId),
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, product.issueId),
      )).limit(1);
      if (!source || source.id !== reference.workProductId || source.type !== reference.productType || source.provider !== reference.provider
        || !jsonEqual(source.sourceTrust, product.sourceTrust) || !source.createdByRunId || product.externalId !== source.id) {
        throw unprocessable("Promoted work product source provenance is missing or changed");
      }
      const sourceTrust = trustedSourceTrust(source.sourceTrust);
      if (!sourceTrust || sourceTrust.promotedFrom.artifactId !== source.id
        || sourceTrust.promotedFrom.issueId !== product.issueId
        || sourceTrust.sourceIssueId !== product.issueId) {
        throw unprocessable("Promoted work product does not preserve its source provenance");
      }
      if (source.updatedAt.toISOString() !== sourceTrust.promotedAt) throw unprocessable("Work product source changed since native promotion");
      const producer = await validateProducer(client, {
        companyId,
        caseId: milestone.caseId,
        primaryIssueId: milestone.issueId,
        runId: source.createdByRunId,
        expectedIssueId: source.issueId,
      });
      const provenance = {
        productId: product.id,
        issueId: product.issueId,
        productType: product.type,
        provider: product.provider,
        status: product.status,
        reviewState: product.reviewState,
        promotion: { sourceArtifactKind: promotedFrom.artifactKind, sourceArtifactId: promotedFrom.artifactId },
        promotedAt: productTrust.promotedAt,
        promotedByActorType: productTrust.promotedByActorType,
        promotedByActorId: productTrust.promotedByActorId,
        producer,
        source: { ...source, createdAt: source.createdAt.toISOString(), updatedAt: source.updatedAt.toISOString() },
        receipt: { ...product, createdAt: product.createdAt.toISOString(), updatedAt: product.updatedAt.toISOString() },
      };
      return {
        artifactRevision: null,
        artifactHash: sha256({ source: provenance.source, receipt: provenance.receipt, sourceTrust, provenance }),
        sourceTrust,
        provenance,
        createdAt: product.updatedAt,
        producerAgentIds: producer.agentId ? [producer.agentId] : [],
        producerUserIds: [],
      };
    }

    throw unprocessable("Evidence artifact does not match the contract's exact stored resource reference");
  }

  async function inspectReadiness(client: MilestoneClient, companyId: string, milestoneId: string, executor?: MilestoneExecutor, currentActor?: AuthorizationActor): Promise<InspectedReadiness> {
    const milestone = await getMilestone(companyId, milestoneId, client);
    const revision = await getActiveRevision(companyId, milestoneId, client);
    let evidenceVersion = 0;
    let evidenceSnapshotHash = sha256({ milestoneId, revisionId: revision?.id ?? null, evidence: [] });
    let executorAllowed = false;
    const producerAgentIds: string[] = [];
    const producerUserIds: string[] = [];
    const checkedAt = new Date().toISOString();
    const base = (reason: MilestoneReadinessReason, eligible = false, accepted = false, state: MilestoneReadiness["state"] = revision?.state === "accepted" ? "accepted_stale" : "blocked"): InspectedReadiness => ({
      readiness: {
        eligible,
        accepted,
        executionAllowed: executorAllowed,
        state,
        reason: executor && !executorAllowed && reason !== "no_active_contract" ? "executor_not_allowed" : reason,
        milestoneId,
        revisionId: revision?.id ?? null,
        contractRevision: revision?.revision ?? null,
        evidenceVersion,
        evidenceSnapshotHash,
        checkedAt,
      },
      producerAgentIds,
      producerUserIds,
    });
    if (!revision || (revision.state !== "active" && revision.state !== "accepted")) return base("no_active_contract");
    const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
    if (!parsedContract.success) return base("unverified_evidence");
    const contract = parsedContract.data;
    executorAllowed = true;
    if (executor) {
      const actorMatchesTask = executor.taskId === undefined || executor.taskId === milestone.issueId;
      const [agent] = executor.agentId ? await client.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, executor.agentId), eq(agents.companyId, companyId),
      )).limit(1) : [];
      executorAllowed = !!actorMatchesTask && !!agent && (contract.executorPolicy.kind === "any_internal_agent"
        || (contract.executorPolicy.kind === "assigned_agent" && contract.executorPolicy.agentId === executor.agentId));
    }
    const [caseRow] = await client.select().from(cases).where(and(
      eq(cases.id, milestone.caseId), eq(cases.companyId, companyId),
    )).limit(1);
    const [primaryTask] = await client.select().from(issues).where(and(
      eq(issues.id, milestone.issueId), eq(issues.companyId, companyId),
    )).limit(1);
    if (!caseRow || caseRow.workIssueId !== milestone.issueId || !primaryTask) {
      evidenceSnapshotHash = sha256({ milestoneId, revisionId: revision.id, reason: "incomplete_task", status: primaryTask?.status ?? null, statusVersion: primaryTask?.statusVersion ?? null });
      return base("incomplete_task");
    }
    const effective = effectiveExecutor(primaryTask, contract);
    if (effective.agentId) producerAgentIds.push(effective.agentId);
    if (effective.userId) producerUserIds.push(effective.userId);
    if (executor?.agentId && executorAllowed) executorAllowed = await hasCurrentAuthority(client, companyId, milestone, {
      type: "agent", agentId: executor.agentId, companyId, onBehalfOfUserId: primaryTask.responsibleUserId,
    });
    let failure: MilestoneReadinessReason | null = primaryTask.status === "done" ? null : "incomplete_task";
    let playbookHash: string | null = null;
    try {
      const snapshot = await readPlaybookSnapshot(client, companyId, milestone.caseId, milestone.issueId, contract.playbookBinding);
      playbookHash = sha256(snapshot);
      const parsedProof = promotionProofSchema.safeParse(revision.promotionProof);
      if (!parsedProof.success || parsedProof.data.hash !== playbookHash || !jsonEqual(parsedProof.data.snapshot, snapshot)) failure = "playbook_stale";
    } catch (error) {
      failure = error instanceof HttpError && error.status === 409 ? "playbook_stale" : "unverified_evidence";
    }
    const evidenceRows = await client.select().from(governanceMilestoneEvidence).where(and(
      eq(governanceMilestoneEvidence.companyId, companyId),
      eq(governanceMilestoneEvidence.milestoneId, milestoneId),
      eq(governanceMilestoneEvidence.revisionId, revision.id),
    )).orderBy(desc(governanceMilestoneEvidence.evidenceVersion));
    evidenceVersion = evidenceRows.length;
    const observations: Array<Record<string, unknown>> = [];
    for (const deliverable of contract.requiredDeliverables) {
      const candidate = evidenceRows.find((row) => row.deliverableKey === deliverable.key && row.evidenceKind === deliverable.evidenceKind);
      if (!candidate) {
        observations.push({ key: deliverable.key, missing: true });
        failure ??= "missing_evidence";
        continue;
      }
      const recordedProducer = producerSnapshotSchema.safeParse(candidate.artifactProvenance.producer);
      if (recordedProducer.success) {
        if (recordedProducer.data.agentId) producerAgentIds.push(recordedProducer.data.agentId);
        if (recordedProducer.data.userId) producerUserIds.push(recordedProducer.data.userId);
      }
      let current: MilestoneArtifactSnapshot;
      try {
        current = await validateArtifact(client, companyId, milestone, deliverable, candidate.artifactId);
      } catch (error) {
        observations.push({ key: deliverable.key, artifactId: candidate.artifactId, evidenceVersion: candidate.evidenceVersion, invalid: error instanceof Error ? error.message : "unknown" });
        if (error instanceof HttpError && error.status === 422) {
          failure ??= error.message.includes("unverified") || error.message.includes("Quarantined") || error.message.includes("provenance") || error.message.includes("acceptance")
            ? "unverified_evidence"
            : "stale_evidence";
        } else {
          throw error;
        }
        continue;
      }
      producerAgentIds.push(...current.producerAgentIds);
      producerUserIds.push(...current.producerUserIds);
      const currentMatchesSubmission = candidate.artifactRevision === current.artifactRevision
        && candidate.artifactHash === current.artifactHash
        && jsonEqual(candidate.artifactSourceTrust, current.sourceTrust)
        && jsonEqual(candidate.artifactProvenance, current.provenance);
      const fresh = deliverable.maxAgeHours == null || Date.now() - current.createdAt.getTime() <= deliverable.maxAgeHours * 3_600_000;
      observations.push({ key: deliverable.key, evidenceVersion: candidate.evidenceVersion, artifactId: candidate.artifactId, artifactRevision: current.artifactRevision, artifactHash: current.artifactHash, sourceTrust: current.sourceTrust, provenance: current.provenance, fresh });
      if (!currentMatchesSubmission || !fresh) failure ??= "stale_evidence";
    }
    evidenceSnapshotHash = sha256({ milestoneId, revisionId: revision.id, contractRevision: revision.revision, evidenceVersion, playbookHash,
      executor: { agentId: primaryTask.assigneeAgentId, userId: primaryTask.assigneeUserId, responsibleUserId: primaryTask.responsibleUserId, status: primaryTask.status, statusVersion: primaryTask.statusVersion }, observations });
    if (contract.executorPolicy.kind === "assigned_agent" && primaryTask.assigneeAgentId
      && primaryTask.assigneeAgentId !== contract.executorPolicy.agentId) failure ??= "executor_not_allowed";
    if (contract.reviewerPolicy.kind === "independent_internal_agent") {
      const [verifier] = await client.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, contract.reviewerPolicy.agentId), eq(agents.companyId, companyId),
      )).limit(1);
      if (!verifier || producerAgentIds.includes(contract.reviewerPolicy.agentId)) failure ??= "reviewer_not_allowed";
    }
    if (revision.state === "accepted") {
      const [acceptance] = await client.select().from(governanceMilestoneDecisions).where(and(
        eq(governanceMilestoneDecisions.companyId, companyId),
        eq(governanceMilestoneDecisions.milestoneId, milestoneId),
        eq(governanceMilestoneDecisions.revisionId, revision.id),
        eq(governanceMilestoneDecisions.outcome, "accept"),
      )).orderBy(desc(governanceMilestoneDecisions.createdAt)).limit(1);
      const [acceptanceEvent] = acceptance ? await client.select().from(governanceMilestoneEvents).where(and(
        eq(governanceMilestoneEvents.companyId, companyId),
        eq(governanceMilestoneEvents.milestoneId, milestoneId),
        eq(governanceMilestoneEvents.revisionId, revision.id),
        eq(governanceMilestoneEvents.decisionId, acceptance.id),
        eq(governanceMilestoneEvents.kind, "milestone_accept"),
      )).limit(1) : [];
      const parsedAuthority = acceptanceEvent ? acceptedEventPayloadSchema.safeParse(acceptanceEvent.payload) : null;
      if (!acceptance || !acceptanceEvent || !parsedAuthority?.success
        || acceptance.evidenceVersion !== evidenceVersion
        || acceptance.evidenceSnapshotHash !== evidenceSnapshotHash) {
        failure ??= "unverified_evidence";
      } else {
        const authorization = recordedAuthorityWithCurrentAttestation(parsedAuthority.data.reviewerAuthorization, currentActor);
        const currentExecutorAgentId = effective.agentId;
        if (acceptance.executorAgentId !== currentExecutorAgentId || acceptance.executorUserId !== primaryTask.assigneeUserId) failure ??= "executor_not_allowed";
        const independent = authorization.type === "board"
          ? !!acceptance.reviewerUserId && !producerUserIds.includes(acceptance.reviewerUserId) && acceptance.reviewerUserId !== primaryTask.assigneeUserId
          : !!acceptance.reviewerAgentId && !producerAgentIds.includes(acceptance.reviewerAgentId) && acceptance.reviewerAgentId !== currentExecutorAgentId;
        const policyMatches = contract.reviewerPolicy.kind === "board_user"
          ? authorization.type === "board" && authorization.userId === acceptance.reviewerUserId && !acceptance.reviewerAgentId
          : authorization.type === "agent" && authorization.agentId === acceptance.reviewerAgentId && acceptance.reviewerAgentId === contract.reviewerPolicy.agentId && !acceptance.reviewerUserId;
        if (!independent || !policyMatches || !(await hasCurrentAuthority(client, companyId, milestone, authorization))) failure ??= "reviewer_not_allowed";
        const executorAuthority = parsedAuthority.data.executorAuthorization
          ? recordedAuthorityWithCurrentAttestation(parsedAuthority.data.executorAuthorization, currentActor) : null;
        if (executorAuthority && !(await hasCurrentAuthority(client, companyId, milestone, executorAuthority))) failure ??= "executor_not_allowed";
      }
    }
    const accepted = revision.state === "accepted" && failure === null;
    const eligible = revision.state === "active" && failure === null;
    const state: MilestoneReadiness["state"] = revision.state === "accepted"
      ? accepted ? "accepted_current" : "accepted_stale"
      : eligible ? "eligible_for_review" : "blocked";
    return base(failure ?? "ready", eligible, accepted, state);
  }

  async function getMilestoneReadiness(companyId: string, milestoneId: string, executor?: MilestoneExecutor, currentActor?: AuthorizationActor): Promise<MilestoneReadiness> {
    return (await inspectReadiness(db, companyId, milestoneId, executor, currentActor)).readiness;
  }

  function recordAuthority(actor: AuthorizationActor) {
    return recordedAuthoritySchema.parse({
      type: actor.type, source: actor.source, userId: actor.userId, agentId: actor.agentId, companyId: actor.companyId,
      sessionId: actor.sessionId, keyId: actor.keyId, keyScope: actor.keyScope, runId: actor.runId,
      onBehalfOfUserId: actor.onBehalfOfUserId, authorizingUserId: actor.authorizingUserId,
      ignoreInstanceAdmin: actor.ignoreInstanceAdmin,
    });
  }

  async function currentAuthority(client: MilestoneClient, companyId: string, actor: AuthorizationActor, lock = false): Promise<AuthorizationActor> {
    const current: AuthorizationActor = { ...actor, isInstanceAdmin: actor.source === "cloud_tenant" && !actor.ignoreInstanceAdmin && actor.isInstanceAdmin === true, memberships: undefined, onBehalfOfMemberships: undefined };
    if (actor.type === "agent") {
      if (!actor.agentId) throw forbidden("Current agent identity is unavailable");
      const query = client.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
      // KEY SHARE is required by task-assignee foreign keys; this still fences authority updates.
      const [agent] = await (lock ? query.for("no key update") : query).limit(1);
      if (!agent || agent.status === "terminated" || agent.status === "pending_approval" || agent.lifecycleHolds?.includes("setup") || actor.companyId !== companyId) throw forbidden("Current company agent authority is unavailable");

    }
    if (actor.source === "agent_key") {
      if (!actor.keyId) throw forbidden("Authenticated agent key identity is unavailable");
      const query = client.select().from(agentApiKeys).where(eq(agentApiKeys.id, actor.keyId));
      const [key] = await (lock ? query.for("update") : query).limit(1);
      if (!key || key.revokedAt || key.companyId !== companyId || key.agentId !== actor.agentId
        || !key.responsibleUserId || key.responsibleUserId !== actor.onBehalfOfUserId
        || !jsonEqual(normalizeAgentApiKeyScope(key.scopeConfig), actor.keyScope ?? null)) throw forbidden("Authenticated agent key authority changed or was revoked");
    }
    if (actor.source === "board_key") {
      if (!actor.keyId) throw forbidden("Authenticated board key identity is unavailable");
      const query = client.select().from(boardApiKeys).where(eq(boardApiKeys.id, actor.keyId));
      const [key] = await (lock ? query.for("update") : query).limit(1);
      if (!key || key.revokedAt || key.userId !== actor.userId || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) throw forbidden("Authenticated board key authority changed or was revoked");
    }
    if (actor.source === "session" && actor.sessionId) {
      const query = client.select({ userId: authSessions.userId, expiresAt: authSessions.expiresAt }).from(authSessions).where(eq(authSessions.id, actor.sessionId));
      const [session] = await (lock ? query.for("update") : query).limit(1);
      if (!session || session.userId !== actor.userId || session.expiresAt.getTime() <= Date.now()) throw forbidden("Authenticated session authority is unavailable");
    }
    const userIds = [...new Set([actor.type === "board" ? actor.userId : null, actor.onBehalfOfUserId, actor.authorizingUserId].filter((id): id is string => !!id))];
    for (const userId of userIds.sort()) {
      const query = client.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)));
      const [member] = await (lock ? query.for("update") : query).limit(1);
      if (actor.type === "board" && userId === actor.userId) {
        if (actor.source !== "cloud_tenant" && actor.source !== "mcp_oauth" && !actor.ignoreInstanceAdmin) {
          const roleQuery = client.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
          const [admin] = await (lock ? roleQuery.for("update") : roleQuery).limit(1);
          current.isInstanceAdmin = !!admin;
        }
        if (actor.source !== "local_implicit" && !current.isInstanceAdmin && (!member || member.status !== "active" || member.membershipRole === "viewer")) throw forbidden("Current board write authority is unavailable");
        current.memberships = member ? [{ companyId, membershipRole: member.membershipRole, status: member.status }] : [];
      } else {
        if (!member || member.status !== "active") throw forbidden("Responsible user authority is unavailable");
        if (userId === actor.onBehalfOfUserId) current.onBehalfOfMemberships = [{ companyId, membershipRole: member.membershipRole, status: member.status }];
      }
    }
    return current;
  }

  async function hasCurrentAuthority(client: MilestoneClient, companyId: string, milestone: typeof governanceMilestones.$inferSelect, actor: AuthorizationActor) {
    try {
      const current = await currentAuthority(client, companyId, actor);
      await assertActorCanReadCase(client, current, milestone.caseId);
      const [caseRow] = await client.select().from(cases).where(and(eq(cases.id, milestone.caseId), eq(cases.companyId, companyId))).limit(1);
      if (!caseRow || caseRow.workIssueId !== milestone.issueId) return false;
      await assertActorCanWriteCase(client, current, caseRow);
      const revision = await getActiveRevision(companyId, milestone.id, client);
      const contract = revision ? milestoneContractInputSchema.safeParse(revision.contract) : null;
      if (contract?.success) await assertContractTaskVisibility(client, companyId, contract.data, current);
      return (await authorizationService(client as Db).decide({ actor: current, action: "issue:read", resource: { type: "issue", companyId, issueId: milestone.issueId } })).allowed;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  }

  async function lockRecordedAcceptanceAuthority(tx: MilestoneTransaction, companyId: string, milestone: typeof governanceMilestones.$inferSelect, payload: unknown) {
    const parsed = acceptedEventPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    for (const authority of [parsed.data.reviewerAuthorization, parsed.data.executorAuthorization]) {
      if (!authority) continue;
      try {
        await currentAuthority(tx, companyId, authority, true);
        await lockCaseAuthority(tx, companyId, milestone, authority);
      } catch (error) {
        if (error instanceof HttpError && (error.status === 403 || error.status === 404)) continue;
        throw error;
      }
    }
  }

  async function assertContractTaskVisibility(client: MilestoneClient, companyId: string, contract: MilestoneContractInput, actor: AuthorizationActor) {
    const taskIds = new Set(contract.requiredDeliverables.flatMap((deliverable) => deliverable.reference.kind === "task"
      ? [deliverable.reference.taskId] : deliverable.reference.kind === "work_product" ? [deliverable.reference.issueId] : []));
    for (const issueId of taskIds) {
      if (!(await authorizationService(client as Db).decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId } })).allowed) throw notFound("Required task artifact not found");
    }
  }

  async function lockCaseAuthority(tx: MilestoneTransaction, companyId: string, milestone: typeof governanceMilestones.$inferSelect, actor: AuthorizationActor) {
    // The Case row fence blocks new retained sources through their foreign key.
    // Existing source privacy, ancestry and grants must remain fixed until delivery commits.
    await tx.select({ id: cases.id }).from(cases).where(and(eq(cases.id, milestone.caseId), eq(cases.companyId, companyId))).for("update");
    const sources = await tx.select().from(caseAccessSources).where(and(eq(caseAccessSources.caseId, milestone.caseId), eq(caseAccessSources.companyId, companyId))).for("update");
    const issueIds = new Set([milestone.issueId, ...sources.filter((source) => source.sourceKind === "issue").map((source) => source.sourceId)]);
    const projectIds = new Set(sources.filter((source) => source.sourceKind === "project").map((source) => source.sourceId));
    const revision = await getActiveRevision(companyId, milestone.id, tx);
    const contract = revision ? milestoneContractInputSchema.safeParse(revision.contract) : null;
    if (contract?.success) for (const deliverable of contract.data.requiredDeliverables) {
      if (deliverable.reference.kind === "task") issueIds.add(deliverable.reference.taskId);
      else if (deliverable.reference.kind === "work_product") issueIds.add(deliverable.reference.issueId);
    }
    for (const id of issueIds) {
      const [issue] = await tx.select({ projectId: issues.projectId, parentId: issues.privacyParentIssueId }).from(issues).where(and(eq(issues.id, id), eq(issues.companyId, companyId))).for("update");
      if (issue?.projectId) projectIds.add(issue.projectId);
      if (issue?.parentId) issueIds.add(issue.parentId);
    }
    for (const id of [...projectIds].sort()) {
      await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, id), eq(projects.companyId, companyId))).for("update");
      await tx.select({ id: projectAccessMembers.id }).from(projectAccessMembers).where(eq(projectAccessMembers.projectId, id)).for("update");
    }
    for (const id of [...issueIds].sort()) await tx.select({ id: issueAccessGrants.id }).from(issueAccessGrants).where(eq(issueAccessGrants.issueId, id)).for("update");
    const principals = [actor.agentId, actor.userId, actor.onBehalfOfUserId, actor.authorizingUserId].filter((id): id is string => !!id);
    if (principals.length) await tx.select({ id: principalPermissionGrants.id }).from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), inArray(principalPermissionGrants.principalId, principals))).for("update");
  }

  async function currentReviewRunAllowed(companyId: string, actor: AuthorizationActor) {
    if (actor.type !== "agent" || !actor.runId) return true;
    if (!actor.agentId) return false;
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId))).limit(1);
    if (!run || agentRunWritesRevoked(run)) return false;
    const [handoff] = await db.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.sourceRunId, actor.runId), inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "delivered"]))).limit(1);
    if (handoff) return false;
    if (run.runtimeMode !== "native") return true;
    const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
    const [task] = typeof issueId === "string" && isUuidLike(issueId) ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1) : [];
    return !!task && task.executionRunId === actor.runId && task.assigneeAgentId === actor.agentId && run.status === "running" && task.workMode === "standard";
  }

  async function getReviewPermissions(companyId: string, milestoneId: string, actor: MilestoneActor) {
    const authorizationActor = requireAuthorizationActor(actor);
    const milestone = await getMilestone(companyId, milestoneId);
    const revision = await getActiveRevision(companyId, milestoneId);
    const contract = revision ? milestoneContractInputSchema.safeParse(revision.contract) : null;
    if (!contract?.success || !(await hasCurrentAuthority(db, companyId, milestone, authorizationActor))
      || !(await currentReviewRunAllowed(companyId, authorizationActor))) return { canReview: false, canAccept: false };
    const inspected = await inspectReadiness(db, companyId, milestoneId, undefined, authorizationActor);
    const policy = contract.data.reviewerPolicy;
    const independent = authorizationActor.type === "board"
      ? policy.kind === "board_user" && !!actor.userId && !inspected.producerUserIds.includes(actor.userId)
      : policy.kind === "independent_internal_agent" && policy.agentId === actor.agentId && !inspected.producerAgentIds.includes(actor.agentId!);
    let canAccept = independent && inspected.readiness.eligible;
    if (canAccept && contract.data.followups.length) {
      try {
        await assertFollowupCreationAllowed(db, companyId, milestone.issueId, actor);
      } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 403 && error.status !== 404)) throw error;
        canAccept = false;
      }
    }
    return { canReview: independent, canAccept };
  }


  async function assertAuthorizedMutation(tx: MilestoneTransaction, companyId: string, milestone: typeof governanceMilestones.$inferSelect, actor: MilestoneActor) {
    const authorizationActor = await currentAuthority(tx, companyId, requireAuthorizationActor(actor), true);
    const caseRow = await authorizeCaseMutation(tx as unknown as Db, authorizationActor, milestone.caseId, companyId);
    await lockCaseAuthority(tx, companyId, milestone, authorizationActor);
    await authorizeCaseMutation(tx as unknown as Db, authorizationActor, milestone.caseId, companyId);
    if (caseRow.workIssueId !== milestone.issueId) throw conflict("Milestone primary task no longer matches its case");
    if (!(await hasCurrentAuthority(tx, companyId, milestone, authorizationActor))) throw notFound("Case not found");
    return caseRow;
  }

  async function createMilestone(companyId: string, caseId: string, actor: MilestoneActor) {
    return db.transaction(async (tx) => {
      const authorizationActor = await currentAuthority(tx, companyId, requireAuthorizationActor(actor), true);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone-case:${companyId}:${caseId}`}))`);
      const [caseRow] = await tx.select().from(cases).where(and(
        eq(cases.id, caseId), eq(cases.companyId, companyId),
      )).limit(1);
      if (!caseRow || !caseRow.workIssueId) throw notFound("Case with a primary task not found");
      const authorizedCase = await authorizeCaseMutation(tx as unknown as Db, authorizationActor, caseId, companyId);
      if (authorizedCase.workIssueId !== caseRow.workIssueId) throw conflict("Case primary task changed; refresh and retry");
      const [task] = await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.id, caseRow.workIssueId), eq(issues.companyId, companyId),
      )).limit(1);
      if (!task) throw notFound("Case primary task not found");
      const [existing] = await tx.select().from(governanceMilestones).where(and(
        eq(governanceMilestones.caseId, caseId), eq(governanceMilestones.companyId, companyId),
      )).limit(1);
      if (existing) return existing;
      const [milestone] = await tx.insert(governanceMilestones).values({
        companyId,
        caseId,
        issueId: task.id,
        createdByUserId: actor.userId ?? null,
        createdByAgentId: actor.agentId ?? null,
      }).returning();
      if (!milestone) throw conflict("Unable to create milestone");
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      return milestone;
    });
  }

  async function createRevision(companyId: string, milestoneId: string, contractInput: MilestoneContractInput, actor: MilestoneActor) {
    if (!promotableActor(actor)) throw forbidden("Only an authorized board user may author a milestone contract");
    const parsed = milestoneContractInputSchema.safeParse(contractInput);
    if (!parsed.success) throw unprocessable("Milestone contract is invalid");
    const contract = parsed.data;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${companyId}:${milestoneId}`}))`);
      const milestone = await getMilestone(companyId, milestoneId, tx);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      await validateContractResources(tx, companyId, milestone.caseId, milestone.issueId, contract);
      await assertContractTaskVisibility(tx, companyId, contract, await currentAuthority(tx, companyId, requireAuthorizationActor(actor), true));
      for (const deliverable of contract.requiredDeliverables) {
        const issueId = deliverable.reference.kind === "task" ? deliverable.reference.taskId
          : deliverable.reference.kind === "work_product" ? deliverable.reference.issueId : null;
        if (issueId) await retainCaseAccessSource(tx, { companyId, caseId: milestone.caseId, sourceKind: "issue", sourceId: issueId });
      }
      const [latest] = await tx.select({ revision: governanceMilestoneRevisions.revision }).from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.companyId, companyId), eq(governanceMilestoneRevisions.milestoneId, milestoneId),
      )).orderBy(desc(governanceMilestoneRevisions.revision)).limit(1);
      const [created] = await tx.insert(governanceMilestoneRevisions).values({
        companyId,
        milestoneId,
        revision: (latest?.revision ?? 0) + 1,
        contract: contract as unknown as Record<string, unknown>,
        createdByUserId: actor.userId,
      }).returning();
      if (!created) throw conflict("Milestone revision was not recorded");
      return created;
    });
  }

  async function promoteRevision(companyId: string, milestoneId: string, revisionId: string, expectedActiveRevisionId: string | null, actor: MilestoneActor) {
    if (!promotableActor(actor)) throw forbidden("Only an authorized board user may promote a milestone contract");
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${companyId}:${milestoneId}`}))`);
      const milestone = await getMilestone(companyId, milestoneId, tx);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      const [revision] = await tx.select().from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.id, revisionId),
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.milestoneId, milestoneId),
      )).for("update").limit(1);
      if (!revision || revision.state !== "draft") throw conflict("Milestone revision is not a draft");
      const previous = await tx.select().from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.milestoneId, milestoneId),
        or(eq(governanceMilestoneRevisions.state, "active"), eq(governanceMilestoneRevisions.state, "accepted")),
      )).for("update");
      const observedActiveRevisionId = previous[0]?.id ?? null;
      if (observedActiveRevisionId !== expectedActiveRevisionId) throw conflict("Active milestone revision changed; refresh and retry");
      const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
      if (!parsedContract.success) throw unprocessable("Stored milestone contract is unverified");
      const contract = parsedContract.data;
      await validateContractResources(tx, companyId, milestone.caseId, milestone.issueId, contract);
      await lockReadinessArtifacts(tx, companyId, milestone.caseId, milestoneId, revision.id, milestone.issueId);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      await assertContractTaskVisibility(tx, companyId, contract, await currentAuthority(tx, companyId, requireAuthorizationActor(actor), true));
      const snapshot = await readPlaybookSnapshot(tx, companyId, milestone.caseId, milestone.issueId, contract.playbookBinding);
      const proof = { hash: sha256(snapshot), snapshot };
      for (const priorRevision of previous) {
        const priorReadiness = await inspectReadiness(tx, companyId, milestoneId);
        await tx.update(governanceMilestoneRevisions).set({ state: "superseded" }).where(and(
          eq(governanceMilestoneRevisions.id, priorRevision.id),
          eq(governanceMilestoneRevisions.companyId, companyId),
        ));
        const [decision] = await tx.insert(governanceMilestoneDecisions).values({
          companyId,
          milestoneId,
          revisionId: priorRevision.id,
          outcome: "supersede",
          reason: `Superseded by contract revision ${revision.revision}`,
          evidenceVersion: priorReadiness.readiness.evidenceVersion,
          evidenceSnapshotHash: priorReadiness.readiness.evidenceSnapshotHash,
          reviewerUserId: actor.userId,
        }).returning();
        if (!decision) throw conflict("Supersession decision was not recorded");
        const [event] = await tx.insert(governanceMilestoneEvents).values({
          companyId,
          milestoneId,
          revisionId: priorRevision.id,
          decisionId: decision.id,
          kind: "milestone_supersede",
          payload: { supersededByRevisionId: revisionId, evidenceVersion: priorReadiness.readiness.evidenceVersion, evidenceSnapshotHash: priorReadiness.readiness.evidenceSnapshotHash },
          acknowledgedAt: new Date(),
        }).returning();
        if (!event) throw conflict("Supersession event was not recorded");
      }
      const [active] = await tx.update(governanceMilestoneRevisions).set({
        state: "active",
        promotedByUserId: actor.userId,
        promotedAt: new Date(),
        promotionProof: proof,
      }).where(and(
        eq(governanceMilestoneRevisions.id, revisionId),
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.state, "draft"),
      )).returning();
      if (!active) throw conflict("Milestone revision changed during promotion");
      return active;
    });
  }

  async function addEvidence(companyId: string, milestoneId: string, input: MilestoneEvidenceInput, actor: MilestoneActor) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${companyId}:${milestoneId}`}))`);
      const milestone = await getMilestone(companyId, milestoneId, tx);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      const revision = await getActiveRevision(companyId, milestoneId, tx);
      if (!revision || revision.state !== "active") throw conflict("Milestone has no active contract");
      if (input.expectedRevision !== revision.revision) throw conflict("Milestone contract changed; refresh and retry");
      const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
      if (!parsedContract.success) throw unprocessable("Stored milestone contract is unverified");
      const contract = parsedContract.data;
      const deliverable = contract.requiredDeliverables.find((item) => item.key === input.deliverableKey);
      if (!deliverable || deliverable.evidenceKind !== input.evidenceKind) throw unprocessable("Evidence does not match an active deliverable");
      const existingRows = await tx.select().from(governanceMilestoneEvidence).where(and(
        eq(governanceMilestoneEvidence.companyId, companyId),
        eq(governanceMilestoneEvidence.milestoneId, milestoneId),
        eq(governanceMilestoneEvidence.revisionId, revision.id),
      ));
      if (input.expectedEvidenceVersion !== existingRows.length) throw conflict("Milestone evidence changed; refresh and retry");
      if (input.evidenceKind === "work_product") await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(eq(issueWorkProducts.id, input.artifactId), eq(issueWorkProducts.companyId, companyId))).for("update");
      await lockReadinessArtifacts(tx, companyId, milestone.caseId, milestoneId, revision.id, milestone.issueId);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      await assertContractTaskVisibility(tx, companyId, contract, await currentAuthority(tx, companyId, requireAuthorizationActor(actor), true));
      const artifact = await validateArtifact(tx, companyId, milestone, deliverable, input.artifactId);
      const [row] = await tx.insert(governanceMilestoneEvidence).values({
        companyId,
        milestoneId,
        revisionId: revision.id,
        evidenceVersion: existingRows.length + 1,
        deliverableKey: input.deliverableKey,
        evidenceKind: input.evidenceKind,
        artifactId: input.artifactId,
        artifactRevision: artifact.artifactRevision,
        artifactHash: artifact.artifactHash,
        artifactSourceTrust: artifact.sourceTrust ?? sql`'null'::jsonb`,
        artifactProvenance: artifact.provenance,
        submittedByUserId: actor.userId ?? null,
        submittedByAgentId: actor.agentId ?? null,
      }).returning();
      if (!row) throw conflict("Milestone evidence was not recorded");
      return row;
    });
  }

  async function lockReadinessArtifacts(tx: MilestoneTransaction, companyId: string, caseId: string, milestoneId: string, revisionId: string, primaryIssueId: string) {
    const [contractRevision] = await tx.select({ contract: governanceMilestoneRevisions.contract }).from(governanceMilestoneRevisions).where(and(
      eq(governanceMilestoneRevisions.id, revisionId),
      eq(governanceMilestoneRevisions.companyId, companyId),
      eq(governanceMilestoneRevisions.milestoneId, milestoneId),
    )).limit(1);
    const parsedContract = contractRevision ? milestoneContractInputSchema.safeParse(contractRevision.contract) : null;
    const issueIds = new Set<string>([primaryIssueId]);
    const documentIds = new Set<string>();
    const revisionIds = new Set<string>();
    const productIds = new Set<string>();
    const runIds = new Set<string>();
    if (parsedContract?.success) {
      documentIds.add(parsedContract.data.playbookBinding.documentId);
      revisionIds.add(parsedContract.data.playbookBinding.documentRevisionId);
      for (const deliverable of parsedContract.data.requiredDeliverables) {
        if (deliverable.reference.kind === "task") issueIds.add(deliverable.reference.taskId);
        else if (deliverable.reference.kind === "document") documentIds.add(deliverable.reference.documentId);
        else { productIds.add(deliverable.reference.workProductId); issueIds.add(deliverable.reference.issueId); }
      }
    }
    const evidenceRows = await tx.select().from(governanceMilestoneEvidence).where(and(
      eq(governanceMilestoneEvidence.companyId, companyId),
      eq(governanceMilestoneEvidence.milestoneId, milestoneId),
      eq(governanceMilestoneEvidence.revisionId, revisionId),
    ));
    for (const evidence of evidenceRows) {
      if (evidence.evidenceKind === "issue_completion") issueIds.add(evidence.artifactId);
      if (evidence.evidenceKind === "document_revision") revisionIds.add(evidence.artifactId);
      if (evidence.evidenceKind === "work_product") productIds.add(evidence.artifactId);
    }
    for (const id of [...revisionIds].sort()) {
      const [revision] = await tx.select({ documentId: documentRevisions.documentId, runId: documentRevisions.createdByRunId }).from(documentRevisions).where(and(
        eq(documentRevisions.id, id), eq(documentRevisions.companyId, companyId),
      )).limit(1);
      if (revision) {
        documentIds.add(revision.documentId);
        if (revision.runId) runIds.add(revision.runId);
      }
    }
    for (const id of [...productIds].sort()) {
      const [product] = await tx.select({ sourceTrust: issueWorkProducts.sourceTrust, runId: issueWorkProducts.createdByRunId }).from(issueWorkProducts).where(and(
        eq(issueWorkProducts.id, id), eq(issueWorkProducts.companyId, companyId),
      )).limit(1);
      if (product) {
        if (product.runId) runIds.add(product.runId);
        const trust = sourceTrustMetadataSchema.safeParse(product.sourceTrust);
        if (trust.success && trust.data.disposition === "promoted") productIds.add(trust.data.promotedFrom.artifactId);
      }
    }
    for (const id of [...productIds].sort()) {
      const [product] = await tx.select({ runId: issueWorkProducts.createdByRunId }).from(issueWorkProducts).where(and(
        eq(issueWorkProducts.id, id), eq(issueWorkProducts.companyId, companyId),
      )).limit(1);
      if (product?.runId) runIds.add(product.runId);
    }
    for (const id of [...issueIds].sort()) {
      const [task] = await tx.select({ runId: issues.executionRunId }).from(issues).where(and(
        eq(issues.id, id), eq(issues.companyId, companyId),
      )).limit(1);
      if (task?.runId) runIds.add(task.runId);
    }
    for (const id of [...runIds].sort()) {
      const [run] = await tx.select({ issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, id), eq(heartbeatRuns.companyId, companyId),
      )).limit(1);
      const sourceIssueId = run?.nativeIssueId ?? run?.issueId;
      if (sourceIssueId) issueIds.add(sourceIssueId);
    }
    for (const id of [...documentIds].sort()) {
      await tx.execute(sql`select id from case_documents where company_id = ${companyId} and case_id = ${caseId} and document_id = ${id} for update`);
    }
    for (const id of [...issueIds].sort()) {
      await tx.execute(sql`select id from case_issue_links where company_id = ${companyId} and case_id = ${caseId} and issue_id = ${id} for update`);
    }
    for (const id of [...documentIds].sort()) {
      await tx.execute(sql`select id from documents where id = ${id} and company_id = ${companyId} for update`);
    }
    for (const id of [...revisionIds].sort()) {
      await tx.execute(sql`select id from document_revisions where id = ${id} and company_id = ${companyId} for update`);
    }
    for (const id of [...productIds].sort()) {
      const [product] = await tx.select({ runId: issueWorkProducts.createdByRunId }).from(issueWorkProducts).where(and(eq(issueWorkProducts.id, id), eq(issueWorkProducts.companyId, companyId))).for("update");
      if (product?.runId) runIds.add(product.runId);
    }
    for (const id of [...issueIds].sort()) {
      const [task] = await tx.select({ runId: issues.executionRunId }).from(issues).where(and(eq(issues.id, id), eq(issues.companyId, companyId))).for("update");
      if (task?.runId) runIds.add(task.runId);
    }
    for (const id of [...runIds].sort()) {
      await tx.execute(sql`select id from heartbeat_runs where id = ${id} and company_id = ${companyId} for update`);
    }
  }

  async function assertFollowupCreationAllowed(client: MilestoneClient, companyId: string, parentIssueId: string, actor: MilestoneActor) {
    const current = await currentAuthority(client, companyId, requireAuthorizationActor(actor));
    const [parent] = await client.select({ projectId: issues.projectId }).from(issues).where(and(eq(issues.id, parentIssueId), eq(issues.companyId, companyId))).limit(1);
    if (!parent) throw notFound("Follow-up parent task not found");
    // Match native issue-route task creation, including inherited project scope.
    const scope = { issueId: null, projectId: parent.projectId, parentIssueId, assigneeAgentId: null, assigneeUserId: null };
    const decision = await authorizationService(client as Db).decide({ actor: current, action: "tasks:assign", resource: { type: "issue", companyId, ...scope }, scope });
    if (!decision.allowed) throw forbidden(decision.explanation);
  }

  async function lockNativeCreationBoundary(tx: MilestoneTransaction, companyId: string) {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
    // Follow-ups do not supply blockedByIssueIds, so no graph mutation fence is
    // needed. Native privacy must precede all Case/source/endpoint locks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${companyId}`}, 0))`);
  }

  async function createFollowupTasks(tx: MilestoneTransaction, companyId: string, milestoneId: string, milestoneIssueId: string, revision: typeof governanceMilestoneRevisions.$inferSelect, actor: MilestoneActor) {
    const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
    if (!parsedContract.success) throw unprocessable("Stored milestone contract is unverified");
    if (parsedContract.data.followups.length) await assertFollowupCreationAllowed(tx, companyId, milestoneIssueId, actor);
    const issuesSvc = issueService(db);
    const delivered: Array<{ actionKey: string; issueId: string }> = [];
    for (const action of parsedContract.data.followups) {
      const [existing] = await tx.select().from(governanceMilestoneFollowups).where(and(
        eq(governanceMilestoneFollowups.companyId, companyId),
        eq(governanceMilestoneFollowups.milestoneId, milestoneId),
        eq(governanceMilestoneFollowups.actionKey, action.actionKey),
        eq(governanceMilestoneFollowups.acceptedRevisionId, revision.id),
      )).limit(1);
      if (existing) {
        delivered.push({ actionKey: action.actionKey, issueId: existing.issueId });
        continue;
      }
      const issue = await issuesSvc.create(companyId, {
        title: action.title,
        description: action.description ?? null,
        parentId: milestoneIssueId,
        createdByUserId: actor.userId ?? null,
        createdByAgentId: actor.agentId ?? null,
        originKind: "governance_milestone_followup",
        originId: `${milestoneId}:${revision.id}:${action.actionKey}`,
        idempotencyKey: `milestone-followup:${companyId}:${milestoneId}:${revision.id}:${action.actionKey}`,
      }, tx);
      await tx.insert(governanceMilestoneFollowups).values({
        companyId,
        milestoneId,
        acceptedRevisionId: revision.id,
        actionKey: action.actionKey,
        issueId: issue.id,
      });
      delivered.push({ actionKey: action.actionKey, issueId: issue.id });
    }
    return delivered;
  }

  async function decide(companyId: string, milestoneId: string, revisionId: string, input: MilestoneDecisionInput, actor: MilestoneActor) {
    if (!actor.userId && !actor.agentId) throw forbidden("Reviewer identity is required");
    return db.transaction(async (tx) => {
      if (input.outcome === "accept") await lockNativeCreationBoundary(tx, companyId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${companyId}:${milestoneId}`}))`);
      const milestone = await getMilestone(companyId, milestoneId, tx);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      const [revision] = await tx.select().from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.id, revisionId),
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.milestoneId, milestoneId),
      )).for("update").limit(1);
      const validSourceState = input.outcome === "revoke" ? revision?.state === "accepted" : revision?.state === "active";
      if (!revision || revision.revision !== input.expectedRevision || !validSourceState) throw conflict("Milestone revision changed; refresh and retry");
      const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
      if (!parsedContract.success) throw unprocessable("Stored milestone contract is unverified");
      const contract = parsedContract.data;
      const authorizationActor = requireAuthorizationActor(actor);
      if (authorizationActor.type === "board") {
        if (!promotableActor(actor) || contract.reviewerPolicy.kind !== "board_user") throw forbidden("This contract does not authorize board review");
      } else if (authorizationActor.type === "agent") {
        if (input.outcome === "revoke" && contract.reviewerPolicy.kind === "board_user") throw forbidden("This contract requires board review");
        if (contract.reviewerPolicy.kind !== "independent_internal_agent" || contract.reviewerPolicy.agentId !== actor.agentId) {
          throw forbidden("This contract does not authorize this exact internal verifier");
        }
        const [reviewer] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, actor.agentId!), eq(agents.companyId, companyId),
        )).limit(1);
        if (!reviewer) throw forbidden("Authorized verifier is not a current company agent");
      } else {
        throw forbidden("Reviewer identity is not authorized");
      }
      await lockReadinessArtifacts(tx, companyId, milestone.caseId, milestoneId, revisionId, milestone.issueId);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      const inspected = await inspectReadiness(tx, companyId, milestoneId, undefined, authorizationActor);
      const readiness = inspected.readiness;
      if (readiness.revisionId !== revisionId
        || readiness.contractRevision !== input.expectedRevision
        || readiness.evidenceVersion !== input.expectedEvidenceVersion
        || readiness.evidenceSnapshotHash !== input.expectedEvidenceSnapshotHash) {
        throw conflict("Milestone contract or evidence changed; refresh and retry");
      }
      const [primaryTask] = await tx.select().from(issues).where(and(
        eq(issues.id, milestone.issueId), eq(issues.companyId, companyId),
      )).limit(1);
      const { agentId: executorAgentId, userId: executorUserId } = effectiveExecutor(primaryTask, contract);
      if (input.outcome === "accept" && (authorizationActor.type === "agent"
        ? actor.agentId === executorAgentId || inspected.producerAgentIds.includes(actor.agentId!)
        : actor.userId === executorUserId || inspected.producerUserIds.includes(actor.userId!))) {
        throw forbidden("The verifier must be independent of the executor and actual artifact producers");
      }
      if (input.outcome === "accept" && (!readiness.eligible || readiness.state !== "eligible_for_review")) {
        throw conflict(`Milestone is not ready for review acceptance: ${readiness.reason}`);
      }
      const executorAuthorization: AuthorizationActor | null = executorAgentId
        ? { type: "agent", agentId: executorAgentId, companyId, onBehalfOfUserId: primaryTask?.responsibleUserId ?? null }
        : executorUserId ? { type: "board", userId: executorUserId } : null;
      if (input.outcome === "accept" && executorAuthorization && !(await hasCurrentAuthority(tx, companyId, milestone, executorAuthorization))) throw forbidden("Current executor authority is unavailable");
      if (executorAuthorization) {
        await currentAuthority(tx, companyId, executorAuthorization, true);
        await lockCaseAuthority(tx, companyId, milestone, executorAuthorization);
      }
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      if (input.outcome === "accept" && contract.followups.length) await assertFollowupCreationAllowed(tx, companyId, milestone.issueId, actor);
      const [decision] = await tx.insert(governanceMilestoneDecisions).values({
        companyId,
        milestoneId,
        revisionId,
        outcome: input.outcome,
        reason: input.reason,
        evidenceVersion: readiness.evidenceVersion,
        evidenceSnapshotHash: readiness.evidenceSnapshotHash,
        reviewerUserId: actor.userId ?? null,
        reviewerAgentId: actor.agentId ?? null,
        executorAgentId,
        executorUserId,
      }).returning();
      if (!decision) throw conflict("Milestone decision was not recorded");
      const [event] = await tx.insert(governanceMilestoneEvents).values({
        companyId,
        milestoneId,
        revisionId,
        decisionId: decision.id,
        kind: `milestone_${input.outcome}`,
        payload: {
          reason: input.reason,
          evidenceVersion: readiness.evidenceVersion,
          evidenceSnapshotHash: readiness.evidenceSnapshotHash,
          reviewerUserId: actor.userId ?? null,
          reviewerAgentId: actor.agentId ?? null,
          reviewerAuthorization: recordAuthority(authorizationActor),
          executorAuthorization: executorAuthorization ? recordAuthority(executorAuthorization) : null,
        },
      }).returning();
      if (!event) throw conflict("Milestone event was not recorded");
      const nextState = input.outcome === "accept" ? "accepted" : input.outcome === "reject" ? "rejected" : "revoked";
      const [updated] = await tx.update(governanceMilestoneRevisions).set({ state: nextState }).where(and(
        eq(governanceMilestoneRevisions.id, revisionId),
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.state, revision.state),
      )).returning();
      if (!updated) throw conflict("Milestone revision changed during decision");
      let followups: Array<{ actionKey: string; issueId: string }> = [];
      if (input.outcome === "accept") {
        const acceptedReadiness = await inspectReadiness(tx, companyId, milestoneId, undefined, authorizationActor);
        if (!acceptedReadiness.readiness.accepted || acceptedReadiness.readiness.evidenceSnapshotHash !== readiness.evidenceSnapshotHash) {
          throw conflict("Milestone evidence changed during acceptance");
        }
        followups = await createFollowupTasks(tx, companyId, milestoneId, milestone.issueId, updated, actor);
      }
      const acknowledgedAt = new Date();
      await tx.update(governanceMilestoneEvents).set({ acknowledgedAt }).where(eq(governanceMilestoneEvents.id, event.id));
      return { decision, event: { ...event, acknowledgedAt }, followups };
    });
  }

  async function deliverFollowups(companyId: string, milestoneId: string, eventId: string, actor: MilestoneActor) {
    if (!actor.userId && !actor.agentId) throw forbidden("An authorized actor is required to deliver milestone follow-ups");
    return db.transaction(async (tx) => {
      await lockNativeCreationBoundary(tx, companyId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${companyId}:${milestoneId}`}))`);
      const milestone = await getMilestone(companyId, milestoneId, tx);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      const [event] = await tx.select().from(governanceMilestoneEvents).where(and(
        eq(governanceMilestoneEvents.id, eventId),
        eq(governanceMilestoneEvents.companyId, companyId),
        eq(governanceMilestoneEvents.milestoneId, milestoneId),
      )).limit(1);
      if (!event || event.kind !== "milestone_accept") throw notFound("Accepted milestone event not found");
      const [revision] = await tx.select().from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.id, event.revisionId),
        eq(governanceMilestoneRevisions.companyId, companyId),
        eq(governanceMilestoneRevisions.milestoneId, milestoneId),
      )).limit(1);
      if (!revision) throw notFound("Accepted milestone not found");
      const parsedContract = milestoneContractInputSchema.safeParse(revision.contract);
      if (!parsedContract.success) throw unprocessable("Stored milestone contract is unverified");
      const receipts = await tx.select().from(governanceMilestoneFollowups).where(and(
        eq(governanceMilestoneFollowups.companyId, companyId),
        eq(governanceMilestoneFollowups.milestoneId, milestoneId),
        eq(governanceMilestoneFollowups.acceptedRevisionId, revision.id),
      ));
      const actions = parsedContract.data.followups;
      const existingByKey = new Map(receipts.map((receipt) => [receipt.actionKey, receipt.issueId]));
      const allPresent = actions.every((action) => existingByKey.has(action.actionKey));
      if (revision.state === "accepted") await lockReadinessArtifacts(tx, companyId, milestone.caseId, milestoneId, revision.id, milestone.issueId);
      await assertAuthorizedMutation(tx, companyId, milestone, actor);
      await lockRecordedAcceptanceAuthority(tx, companyId, milestone, event.payload);
      const readiness = await inspectReadiness(tx, companyId, milestoneId, undefined, requireAuthorizationActor(actor));
      const mayCreate = revision.state === "accepted"
        && readiness.readiness.accepted
        && readiness.readiness.revisionId === revision.id;
      if (mayCreate && !allPresent) {
        const created = await createFollowupTasks(tx, companyId, milestoneId, milestone.issueId, revision, actor);
        if (!event.acknowledgedAt) await tx.update(governanceMilestoneEvents).set({ acknowledgedAt: new Date() }).where(eq(governanceMilestoneEvents.id, eventId));
        return created;
      }
      if (mayCreate && !event.acknowledgedAt) {
        if (actions.length) await assertFollowupCreationAllowed(tx, companyId, milestone.issueId, actor);
        await tx.update(governanceMilestoneEvents).set({ acknowledgedAt: new Date() }).where(eq(governanceMilestoneEvents.id, eventId));
      }
      return actions.flatMap((action) => {
        const issueId = existingByKey.get(action.actionKey);
        return issueId ? [{ actionKey: action.actionKey, issueId }] : [];
      });
    });
  }

  return { getMilestoneReadiness, getReviewPermissions, createMilestone, createRevision, promoteRevision, addEvidence, decide, deliverFollowups };
}
