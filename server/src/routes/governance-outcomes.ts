import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { correctOutcomeObservationSchema, createOutcomeCheckinSchema, createOutcomeObservationSchema, createOutcomeTargetSchema } from "@paperclipai/shared/governance-outcomes";
import type { OutcomeCapabilities } from "@paperclipai/shared/governance-outcomes";
import { validate } from "../middleware/validate.js";
import { governanceOutcomeService } from "../services/governance-outcomes.js";
import type { OutcomeActorContext } from "../services/governance-outcomes.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { goalService } from "../services/goals.js";

function outcomeActorContext(req: Request): OutcomeActorContext {
  return { authorizationActor: req.actor, principal: getActorInfo(req) };
}

function outcomeCapabilities(req: Request, companyId: string, targets: Array<{ id: string; ownerAgentId: string | null }>): OutcomeCapabilities {
  const actor = req.actor;
  const membership = actor.memberships?.find((item) => item.companyId === companyId);
  const responsibleMembership = actor.onBehalfOfMemberships?.find((item) => item.companyId === companyId && item.status === "active");
  const boardCanWrite = actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin === true
    || (membership?.status === "active" && membership.membershipRole !== "viewer"));
  const agentCanWrite = actor.type === "agent" && actor.companyId === companyId
    && (!actor.onBehalfOfUserId?.trim() || Boolean(responsibleMembership && responsibleMembership.membershipRole !== "viewer"));
  const canWrite = boardCanWrite || agentCanWrite;
  return {
    canApproveTargets: boardCanWrite,
    canCheckin: canWrite,
    observationTargetIds: canWrite ? targets.filter((target) => boardCanWrite || target.ownerAgentId === actor.agentId).map((target) => target.id) : [],
    explanation: canWrite
      ? boardCanWrite ? "Board target approval and measurement writes are available; every save rechecks current authorization."
        : "Agents cannot approve targets. Observations require explicit target ownership; every save rechecks company, key and run authorization."
      : membership?.membershipRole === "viewer" || responsibleMembership?.membershipRole === "viewer"
        ? "Viewer access is read-only" : "Current company write capability is unavailable; outcome and delivery history remain readable.",
  };
}

export function governanceOutcomeRoutes(db: Db) {
  const router = Router();
  const service = governanceOutcomeService(db);
  const goals = goalService(db);
  router.get("/goals/:id/outcomes", async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    const result = await service.read(goal.companyId, goal.id, outcomeActorContext(req));
    res.json({ ...result, capabilities: outcomeCapabilities(req, goal.companyId, result.targets) });
  });
  router.post("/goals/:id/outcomes/targets", validate(createOutcomeTargetSchema), async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    assertCompanyAccess(req, goal.companyId);
    assertBoard(req);
    res.status(201).json(await service.createTarget(goal.companyId, goal.id, req.body, outcomeActorContext(req)));
  });
  router.post("/goals/:id/outcomes/observations", validate(createOutcomeObservationSchema), async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    assertCompanyAccess(req, goal.companyId);
    const result = await service.addObservation(goal.companyId, goal.id, req.body, outcomeActorContext(req));
    res.status(result.reused ? 200 : 201).json(result);
  });
  router.post("/goals/:id/outcomes/observations/corrections", validate(correctOutcomeObservationSchema), async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    assertCompanyAccess(req, goal.companyId);
    const { supersedesId, correctionReason, ...input } = req.body;
    const result = await service.addObservation(goal.companyId, goal.id, input, outcomeActorContext(req), { supersedesId, correctionReason });
    res.status(result.reused ? 200 : 201).json(result);
  });
  router.post("/goals/:id/outcomes/checkins", validate(createOutcomeCheckinSchema), async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    assertCompanyAccess(req, goal.companyId);
    res.status(201).json(await service.addCheckin(goal.companyId, goal.id, req.body, outcomeActorContext(req)));
  });
  return router;
}
