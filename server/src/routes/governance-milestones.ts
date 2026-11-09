import { Router, type Request } from "express";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { cases, companyMemberships } from "@paperclipai/db";
import {
  governanceMilestoneDecisions,
  governanceMilestoneEvidence,
  governanceMilestoneFollowups,
  governanceMilestoneRevisions,
  governanceMilestones,
} from "@paperclipai/db/schema/governance_milestones";
import {
  milestoneContractInputSchema,
  milestoneDecisionInputSchema,
  milestoneEvidenceInputSchema,
  milestoneFollowupDeliveryInputSchema,
  milestonePromoteInputSchema,
} from "@paperclipai/shared/governance-milestones";
import { assertActorCanReadCase, assertActorCanWriteCase } from "../services/case-access.js";
import { governanceMilestoneService, type MilestoneActor } from "../services/governance-milestones.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertBoardOrAgent, hasCompanyAccess } from "./authz.js";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { instanceSettingsService } from "../services/instance-settings.js";

function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: unknown } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest("Invalid milestone request", result.error?.issues);
  return result.data as T;
}

function actor(req: Request): MilestoneActor {
  const authorizationActor = req.actor as AuthorizationActor;
  return {
    userId: authorizationActor.type === "board" ? authorizationActor.userId ?? null : null,
    agentId: authorizationActor.type === "agent" ? authorizationActor.agentId ?? null : null,
    runId: authorizationActor.type === "agent" ? authorizationActor.runId ?? null : null,
    authorizationActor,
  };
}

export function governanceMilestoneRoutes(db: Db) {
  const router = Router();
  const service = governanceMilestoneService(db);

  async function requireCasesEnabled() {
    if (!(await instanceSettingsService(db).getExperimental()).enableCases) throw forbidden("Cases are disabled");
  }

  async function getCaseRow(req: Request, caseId: string) {
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!caseRow || !hasCompanyAccess(req, caseRow.companyId)) throw notFound("Case not found");
    assertCompanyAccess(req, caseRow.companyId);
    await assertActorCanReadCase(db, req.actor as AuthorizationActor, caseRow.id);
    return caseRow;
  }

  async function canWriteCase(req: Request, caseRow: typeof cases.$inferSelect) {
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      if (!req.actor.userId) return false;
      const [membership] = await db.select({ membershipRole: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, caseRow.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, req.actor.userId),
        eq(companyMemberships.status, "active"),
      )).limit(1);
      return !!membership && membership.membershipRole !== "viewer";
    }
    if (req.actor.type === "agent") {
      try {
        await assertActorCanWriteCase(db, req.actor as AuthorizationActor, { companyId: caseRow.companyId, projectId: caseRow.projectId, workIssueId: caseRow.workIssueId });
        return true;
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return false;
        throw error;
      }
    }
    return false;
  }

  async function getMilestoneRow(req: Request, milestoneId: string) {
    const [milestone] = await db.select().from(governanceMilestones).where(eq(governanceMilestones.id, milestoneId)).limit(1);
    if (!milestone || !hasCompanyAccess(req, milestone.companyId)) throw notFound("Milestone not found");
    assertCompanyAccess(req, milestone.companyId);
    return milestone;
  }

  router.get("/cases/:caseId/milestones", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const caseRow = await getCaseRow(req, req.params.caseId);
      const canWrite = await canWriteCase(req, caseRow);
      const [milestone] = await db.select().from(governanceMilestones).where(and(
        eq(governanceMilestones.caseId, caseRow.id), eq(governanceMilestones.companyId, caseRow.companyId),
      )).limit(1);
      if (!milestone) return res.json({
        milestone: null, revisions: [], evidence: [], decisions: [], followups: [],
        permissions: { actorType: req.actor.type, canCreate: canWrite, canAuthorContract: false, canPromote: false, canSubmitEvidence: false, canReview: false, canAccept: false },
      });
      const [revisions, evidence, decisions, followups] = await Promise.all([
        db.select().from(governanceMilestoneRevisions).where(and(
          eq(governanceMilestoneRevisions.companyId, caseRow.companyId), eq(governanceMilestoneRevisions.milestoneId, milestone.id),
        )).orderBy(asc(governanceMilestoneRevisions.revision)),
        db.select().from(governanceMilestoneEvidence).where(and(
          eq(governanceMilestoneEvidence.companyId, caseRow.companyId), eq(governanceMilestoneEvidence.milestoneId, milestone.id),
        )).orderBy(asc(governanceMilestoneEvidence.createdAt)),
        db.select().from(governanceMilestoneDecisions).where(and(
          eq(governanceMilestoneDecisions.companyId, caseRow.companyId), eq(governanceMilestoneDecisions.milestoneId, milestone.id),
        )).orderBy(asc(governanceMilestoneDecisions.createdAt)),
        db.select().from(governanceMilestoneFollowups).where(and(
          eq(governanceMilestoneFollowups.companyId, caseRow.companyId), eq(governanceMilestoneFollowups.milestoneId, milestone.id),
        )).orderBy(asc(governanceMilestoneFollowups.createdAt)),
      ]);
      const currentRevision = [...revisions].reverse().find((revision) => revision.state === "active" || revision.state === "accepted");
      const reviewPermissions = await service.getReviewPermissions(caseRow.companyId, milestone.id, actor(req));
      const permissions = {
        actorType: req.actor.type,
        canCreate: false,
        canAuthorContract: req.actor.type === "board" && canWrite,
        canPromote: req.actor.type === "board" && canWrite,
        canSubmitEvidence: currentRevision?.state === "active" && canWrite,
        canReview: canWrite && reviewPermissions.canReview,
        canAccept: canWrite && reviewPermissions.canAccept,
      };
      const executor = req.actor.type === "agent" ? { agentId: req.actor.agentId ?? undefined, taskId: caseRow.workIssueId ?? undefined } : undefined;
      const readiness = await service.getMilestoneReadiness(caseRow.companyId, milestone.id, executor, req.actor as AuthorizationActor);
      return res.json({ milestone, revisions, evidence, decisions, followups, readiness, permissions });
    } catch (error) { return next(error); }
  });

  router.post("/cases/:caseId/milestones", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const caseRow = await getCaseRow(req, req.params.caseId);
      assertBoardOrAgent(req);
      await assertActorCanWriteCase(db, req.actor as AuthorizationActor, { companyId: caseRow.companyId, projectId: caseRow.projectId, workIssueId: caseRow.workIssueId });
      return res.status(201).json(await service.createMilestone(caseRow.companyId, caseRow.id, actor(req)));
    } catch (error) { return next(error); }
  });

  router.post("/milestones/:milestoneId/revisions", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const milestone = await getMilestoneRow(req, req.params.milestoneId);
      assertBoardOrgAccess(req);
      const input = parse(milestoneContractInputSchema, req.body);
      return res.status(201).json(await service.createRevision(milestone.companyId, milestone.id, input, actor(req)));
    } catch (error) { return next(error); }
  });

  router.post("/milestones/:milestoneId/revisions/:revisionId/promote", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const milestone = await getMilestoneRow(req, req.params.milestoneId);
      assertBoardOrgAccess(req);
      const input = parse(milestonePromoteInputSchema, req.body);
      return res.json(await service.promoteRevision(milestone.companyId, milestone.id, req.params.revisionId, input.expectedActiveRevisionId, actor(req)));
    } catch (error) { return next(error); }
  });

  router.post("/milestones/:milestoneId/evidence", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const milestone = await getMilestoneRow(req, req.params.milestoneId);
      assertBoardOrAgent(req);
      const caseRow = await getCaseRow(req, milestone.caseId);
      await assertActorCanWriteCase(db, req.actor as AuthorizationActor, { companyId: caseRow.companyId, projectId: caseRow.projectId, workIssueId: caseRow.workIssueId });
      const input = parse(milestoneEvidenceInputSchema, req.body);
      return res.status(201).json(await service.addEvidence(milestone.companyId, milestone.id, input, actor(req)));
    } catch (error) { return next(error); }
  });

  router.post("/milestones/:milestoneId/revisions/:revisionId/decisions", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const milestone = await getMilestoneRow(req, req.params.milestoneId);
      if (req.actor.type === "agent") await getCaseRow(req, milestone.caseId);
      else assertBoardOrgAccess(req);
      const input = parse(milestoneDecisionInputSchema, req.body);
      const [revision] = await db.select().from(governanceMilestoneRevisions).where(and(
        eq(governanceMilestoneRevisions.id, req.params.revisionId),
        eq(governanceMilestoneRevisions.companyId, milestone.companyId),
        eq(governanceMilestoneRevisions.milestoneId, milestone.id),
      )).limit(1);
      if (!revision) throw notFound("Milestone revision not found");
      return res.json(await service.decide(milestone.companyId, milestone.id, revision.id, input, actor(req)));
    } catch (error) { return next(error); }
  });

  router.post("/milestones/:milestoneId/followups", async (req, res, next) => {
    try {
      await requireCasesEnabled();
      const milestone = await getMilestoneRow(req, req.params.milestoneId);
      assertBoardOrAgent(req);
      const caseRow = await getCaseRow(req, milestone.caseId);
      if (req.actor.type === "agent") {
        await assertActorCanWriteCase(db, req.actor as AuthorizationActor, { companyId: caseRow.companyId, projectId: caseRow.projectId, workIssueId: caseRow.workIssueId });
      }
      const input = parse(milestoneFollowupDeliveryInputSchema, req.body);
      return res.json(await service.deliverFollowups(milestone.companyId, milestone.id, input.eventId, actor(req)));
    } catch (error) { return next(error); }
  });

  return router;
}
