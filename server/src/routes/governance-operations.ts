import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { governanceOperationExceptionAdmissionSchema, governanceOperationExceptionPauseSchema, governanceOperationExceptionResumeSchema, governanceOperationExceptionResolveSchema } from "@paperclipai/shared/governance-operations";
import { validate } from "../middleware/validate.js";
import { governanceOperationsService } from "../services/governance-operations.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const companyParams = z.object({ companyId: z.string().uuid() });
export function governanceOperationsRouter(db: Db) {
  const router = Router();
  const service = governanceOperationsService(db);
  router.use("/companies/:companyId/governance-operations", (req, res, next) => {
    if (!companyParams.safeParse(req.params).success) { res.status(404).json({ error: "Operations not found" }); return; }
    assertCompanyAccess(req, req.params.companyId as string);
    next();
  });
  router.get("/companies/:companyId/governance-operations", async (req, res) => {
    res.json(await service.read(req.params.companyId as string, req.actor));
  });
  router.post("/companies/:companyId/governance-operations/occurrences/:occurrenceId/exceptions", validate(governanceOperationExceptionAdmissionSchema), async (req, res) => {
    assertBoard(req);
    if (!z.string().uuid().safeParse(req.params.occurrenceId).success) { res.status(404).json({ error: "Occurrence not found" }); return; }
    res.status(201).json(await service.admitException(req.params.companyId as string, req.params.occurrenceId as string, req.body, req.actor));
  });
  router.post("/companies/:companyId/governance-operations/exceptions/:exceptionId/pause", validate(governanceOperationExceptionPauseSchema), async (req, res) => {
    assertBoard(req);
    if (!z.string().uuid().safeParse(req.params.exceptionId).success) { res.status(404).json({ error: "Exception not found" }); return; }
    res.json(await service.pauseException(req.params.companyId as string, req.params.exceptionId as string, req.body, req.actor));
  });
  router.post("/companies/:companyId/governance-operations/exceptions/:exceptionId/resume", validate(governanceOperationExceptionResumeSchema), async (req, res) => {
    assertBoard(req);
    if (!z.string().uuid().safeParse(req.params.exceptionId).success) { res.status(404).json({ error: "Exception not found" }); return; }
    res.json(await service.resumeException(req.params.companyId as string, req.params.exceptionId as string, req.body, req.actor));
  });
  router.post("/companies/:companyId/governance-operations/exceptions/:exceptionId/resolve", validate(governanceOperationExceptionResolveSchema), async (req, res) => {
    assertBoard(req);
    if (!z.string().uuid().safeParse(req.params.exceptionId).success) { res.status(404).json({ error: "Exception not found" }); return; }
    res.json(await service.resolveException(req.params.companyId as string, req.params.exceptionId as string, req.body, req.actor));
  });
  return router;
}
