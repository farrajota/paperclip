import { and, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { companies, issues } from "@paperclipai/db";
import { issuePlanning } from "@paperclipai/db/schema/issue_planning";
import { issuePlanningInputSchema, isIsoCalendarDate, isOffsetQualifiedInstant, isValidIanaTimezone } from "@paperclipai/shared/governance-planning";
import type { Db } from "@paperclipai/db";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import {
  getGovernanceCalendar,
  listPlanableTasks,
  updateIssuePlanning,
  type GovernancePlanningAuthorization,
  type GovernancePlanningIssueAccess,
} from "../services/governance-planning.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_CALENDAR_DAYS = 62;
const MAX_CALENDAR_LIMIT = 500;
const MAX_TASK_PICKER_LIMIT = 200;

interface ResolvedCalendarRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

function localCalendarDate(instant: Date, timezone: string): string | null {
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  return values.year && values.month && values.day
    ? `${values.year.padStart(4, "0")}-${values.month}-${values.day}`
    : null;
}

function startOfCalendarDate(date: string, timezone: string): Date | null {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(target)) return null;
  let low = target - 3 * DAY_MS;
  let high = target + 3 * DAY_MS;
  const lowDate = localCalendarDate(new Date(low), timezone);
  const highDate = localCalendarDate(new Date(high), timezone);
  if (!lowDate || !highDate || lowDate >= date || highDate < date) return null;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const middleDate = localCalendarDate(new Date(middle), timezone);
    if (!middleDate) return null;
    if (middleDate < date) low = middle;
    else high = middle;
  }
  return localCalendarDate(new Date(high), timezone) === date ? new Date(high) : null;
}

function resolveCalendarRange(fromValue: string, toValue: string, timezone: string): ResolvedCalendarRange | null {
  if (!isValidIanaTimezone(timezone)) return null;
  let from: Date;
  let to: Date;
  let fromDate: string;
  let toDate: string;
  if (isIsoCalendarDate(fromValue) && isIsoCalendarDate(toValue)) {
    if (fromValue >= toValue) return null;
    const fromBoundary = startOfCalendarDate(fromValue, timezone);
    const toBoundary = startOfCalendarDate(toValue, timezone);
    if (!fromBoundary || !toBoundary) return null;
    from = fromBoundary;
    to = toBoundary;
    fromDate = fromValue;
    toDate = toValue;
  } else if (isOffsetQualifiedInstant(fromValue) && isOffsetQualifiedInstant(toValue)) {
    from = new Date(Date.parse(fromValue));
    to = new Date(Date.parse(toValue));
    if (from >= to) return null;
    const lastIncludedDate = localCalendarDate(new Date(to.getTime() - 1), timezone);
    const firstIncludedDate = localCalendarDate(from, timezone);
    if (!firstIncludedDate || !lastIncludedDate) return null;
    fromDate = firstIncludedDate;
    toDate = new Date(Date.parse(`${lastIncludedDate}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  } else {
    return null;
  }
  const fromDay = Date.parse(`${fromDate}T00:00:00.000Z`);
  const toDay = Date.parse(`${toDate}T00:00:00.000Z`);
  if ((toDay - fromDay) / DAY_MS > MAX_CALENDAR_DAYS || from >= to) return null;
  return { from, to, fromDate, toDate };
}

async function authorizePlanningResources(
  db: Db,
  actor: AuthorizationActor,
  companyId: string,
  issueRows: GovernancePlanningIssueAccess[],
  projectIds: string[],
): Promise<GovernancePlanningAuthorization> {
  const authorization = authorizationService(db);
  const issueResources = issueRows.map((issue) => ({
    type: "issue" as const,
    companyId: issue.companyId,
    issueId: issue.id,
    projectId: issue.projectId,
    parentIssueId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    originKind: issue.originKind,
    originId: issue.originId,
    status: issue.status,
  }));
  const projectResources = [...new Set(projectIds)].map((projectId) => ({
    type: "project" as const,
    companyId,
    projectId,
  }));
  const issueDecisions = issueResources.length === 0 ? [] : await authorization.decideReads(actor, issueResources);
  const projectDecisions = projectResources.length === 0 ? [] : await authorization.decideReads(actor, projectResources);
  const readableProjectIds = new Set<string>();
  for (let index = 0; index < projectResources.length; index += 1) {
    if (projectDecisions[index]?.allowed) readableProjectIds.add(projectResources[index]!.projectId!);
  }
  const readableIssueIds = new Set<string>();
  for (let index = 0; index < issueResources.length; index += 1) {
    const issue = issueRows[index]!;
    if (!issueDecisions[index]?.allowed) continue;
    readableIssueIds.add(issue.id);
  }
  return { issueIds: readableIssueIds, projectIds: readableProjectIds };
}

async function getReadableCompany(req: Request, res: Response, db: Db, companyId: string) {
  if (!UUID_PATTERN.test(companyId)) {
    res.status(404).json({ error: "Company not found" });
    return null;
  }
  const rows = await db.select({ companyId: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const company = await getAccessibleResource(req, res, rows[0] ?? null, "Company not found");
  if (!company) return null;
  const decision = await authorizationService(db).decide({
    actor: req.actor,
    action: "company_scope:read",
    resource: { type: "company", companyId },
  });
  if (!decision.allowed) {
    res.status(403).json({ error: "Company-wide planning reads are outside this actor's authorization boundary" });
    return null;
  }
  return company;
}

async function getReadableIssue(req: Request, res: Response, db: Db, issueId: string) {
  if (!UUID_PATTERN.test(issueId)) {
    res.status(404).json({ error: "Issue not found" });
    return null;
  }
  const rows = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  const issue = await getAccessibleResource(req, res, rows[0] ?? null, "Issue not found");
  if (!issue) return null;
  const access = await authorizePlanningResources(db, req.actor, issue.companyId, [issue], issue.projectId ? [issue.projectId] : []);
  if (!access.issueIds.has(issue.id)) {
    res.status(404).json({ error: "Issue not found" });
    return null;
  }
  return issue;
}

function singleQueryValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function governancePlanningRouter(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/governance-calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await getReadableCompany(req, res, db, companyId))) return;

    const fromValue = singleQueryValue(req.query.from);
    const toValue = singleQueryValue(req.query.to);
    const timezone = req.query.timezone === undefined ? "UTC" : singleQueryValue(req.query.timezone);
    if (!fromValue || !toValue || !timezone) return res.status(400).json({ error: "Calendar range and timezone are required" });
    const range = resolveCalendarRange(fromValue, toValue, timezone);
    if (!range) return res.status(400).json({ error: "Invalid or out-of-bounds calendar range" });

    let limit = 200;
    if (req.query.limit !== undefined) {
      const limitValue = singleQueryValue(req.query.limit);
      if (!limitValue || !/^\d+$/.test(limitValue)) return res.status(400).json({ error: "Calendar limit must be a finite integer" });
      limit = Number(limitValue);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CALENDAR_LIMIT) {
      return res.status(400).json({ error: `Calendar limit must be between 1 and ${MAX_CALENDAR_LIMIT}` });
    }

    const projectId = req.query.projectId === undefined ? undefined : singleQueryValue(req.query.projectId);
    const assigneeAgentId = req.query.assigneeAgentId === undefined ? undefined : singleQueryValue(req.query.assigneeAgentId);
    if ((projectId !== undefined && (!projectId || !UUID_PATTERN.test(projectId)))
      || (assigneeAgentId !== undefined && (!assigneeAgentId || !UUID_PATTERN.test(assigneeAgentId)))) {
      return res.status(400).json({ error: "Project and agent filters must be UUIDs" });
    }

    const sourceValue = req.query.source === undefined ? "all" : singleQueryValue(req.query.source);
    if (sourceValue !== "all" && sourceValue !== "issue" && sourceValue !== "routine" && sourceValue !== "run") {
      return res.status(400).json({ error: "Invalid calendar source filter" });
    }
    const actualOnlyValue = req.query.actualOnly === undefined ? "false" : singleQueryValue(req.query.actualOnly);
    if (actualOnlyValue !== "true" && actualOnlyValue !== "false") {
      return res.status(400).json({ error: "actualOnly must be true or false" });
    }

    const result = await getGovernanceCalendar(db, {
      companyId,
      actor: req.actor,
      ...range,
      timezone,
      limit,
      projectId,
      assigneeAgentId,
      source: sourceValue === "all" ? undefined : sourceValue,
      actualOnly: actualOnlyValue === "true",
      now: new Date(),
      authorize: (issueRows, projectIds) => authorizePlanningResources(db, req.actor, companyId, issueRows, projectIds),
    });
    const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
    const canEditPlanning = req.actor.type === "board" && (req.actor.source === "local_implicit"
      || req.actor.isInstanceAdmin === true
      || (membership?.status === "active" && membership.membershipRole !== "viewer"));
    return res.json({ ...result, canEditPlanning });
  });

  router.get("/companies/:companyId/governance-calendar/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await getReadableCompany(req, res, db, companyId))) return;
    const query = req.query.query === undefined ? undefined : singleQueryValue(req.query.query);
    if (query === null || (query !== undefined && query.length > 100)) {
      return res.status(400).json({ error: "Task search text must be at most 100 characters" });
    }
    const projectId = req.query.projectId === undefined ? undefined : singleQueryValue(req.query.projectId);
    const assigneeAgentId = req.query.assigneeAgentId === undefined ? undefined : singleQueryValue(req.query.assigneeAgentId);
    if ((projectId !== undefined && (!projectId || !UUID_PATTERN.test(projectId)))
      || (assigneeAgentId !== undefined && (!assigneeAgentId || !UUID_PATTERN.test(assigneeAgentId)))) {
      return res.status(400).json({ error: "Project and agent filters must be UUIDs" });
    }
    let limit = 100;
    if (req.query.limit !== undefined) {
      const limitValue = singleQueryValue(req.query.limit);
      if (!limitValue || !/^\d+$/.test(limitValue)) return res.status(400).json({ error: "Task selector limit must be a finite integer" });
      limit = Number(limitValue);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_PICKER_LIMIT) {
      return res.status(400).json({ error: `Task selector limit must be between 1 and ${MAX_TASK_PICKER_LIMIT}` });
    }
    const result = await listPlanableTasks(db, {
      companyId,
      actor: req.actor,
      query,
      limit,
      projectId,
      assigneeAgentId,
      authorize: (issueRows, projectIds) => authorizePlanningResources(db, req.actor, companyId, issueRows, projectIds),
    });
    return res.json(result);
  });

  router.get("/issues/:id/planning", async (req, res) => {
    const issue = await getReadableIssue(req, res, db, req.params.id as string);
    if (!issue) return;
    const rows = await db.select().from(issuePlanning).where(and(
      eq(issuePlanning.issueId, issue.id),
      eq(issuePlanning.companyId, issue.companyId),
    )).limit(1);
    return res.json(rows[0] ?? null);
  });

  router.put("/issues/:id/planning", async (req, res) => {
    assertBoard(req);
    const parsed = issuePlanningInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid planning input", details: parsed.error.flatten() });
    const issue = await getReadableIssue(req, res, db, req.params.id as string);
    if (!issue) return;
    const result = await updateIssuePlanning(db, issue.companyId, issue.id, parsed.data, {
      actorType: req.actor.type === "agent" ? "agent" : "user",
      actorId: req.actor.userId ?? req.actor.agentId ?? "local-board",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    });
    if (result.kind === "not_found") return res.status(404).json({ error: "Issue not found" });
    if (result.kind === "conflict") return res.status(409).json({ error: "Planning revision conflict" });
    if (result.kind === "invalid") return res.status(400).json({ error: "Invalid resulting planning dates", details: result.details });
    return res.json(result.planning);
  });

  return router;
}
