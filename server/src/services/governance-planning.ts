import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues, projects } from "@paperclipai/db";
import { issuePlanning } from "@paperclipai/db/schema/issue_planning";
import { routineOccurrences, routineRuns, routines, routineTriggers } from "@paperclipai/db/schema/routines";
import type {
  GovernanceCalendarEvent,
  GovernanceCalendarResult,
  GovernanceCalendarSource,
  GovernancePlanableTasksResult,
  IssuePlanningGate,
  IssuePlanningInput,
} from "@paperclipai/shared/governance-planning";
import {
  issuePlanningInputSchema,
  isIssueStartEligible,
  isIsoCalendarDate,
  isOffsetQualifiedInstant,
  isValidIanaTimezone,
} from "@paperclipai/shared/governance-planning";
import { nextCronTickInTimeZone } from "./routines.js";
import { issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";

const DEFAULT_CALENDAR_LIMIT = 200;
const MAX_CALENDAR_LIMIT = 500;
const MAX_TASK_PICKER_LIMIT = 100;
const MAX_TASK_PICKER_LIMIT_CEILING = 200;
const SOURCE_PAGE_SIZE = 200;
const MAX_SOURCE_SCAN = 5_000;
const MAX_GENERATED_EVENTS = 5_000;
const MAX_SCHEDULE_ITERATIONS = 2_000;
const MAX_CRON_SEARCH_MINUTES = 100_000;
const MAX_CALENDAR_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type GovernancePlanningIssueAccess = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "projectId"
  | "parentId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "originKind"
  | "originId"
  | "status"
>;

export interface GovernancePlanningAuthorization {
  issueIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
}

export type GovernancePlanningAuthorizer = (
  issueRows: GovernancePlanningIssueAccess[],
  projectIds: string[],
) => Promise<GovernancePlanningAuthorization>;

export interface PlanningMutationActor {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
}

export interface GovernanceCalendarInput {
  companyId: string;
  actor: AuthorizationActor;
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  timezone: string;
  limit?: number;
  projectId?: string;
  assigneeAgentId?: string;
  source?: GovernanceCalendarSource;
  actualOnly?: boolean;
  now: Date;
  authorize: GovernancePlanningAuthorizer;
}

export interface PlanableTaskInput {
  companyId: string;
  actor: AuthorizationActor;
  query?: string;
  limit?: number;
  projectId?: string;
  assigneeAgentId?: string;
  authorize: GovernancePlanningAuthorizer;
}

function validCalendarInput(input: GovernanceCalendarInput, limit: number): boolean {
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from >= input.to) return false;
  if (!isValidIanaTimezone(input.timezone) || !isIsoCalendarDate(input.fromDate) || !isIsoCalendarDate(input.toDate)) return false;
  const fromDay = Date.parse(`${input.fromDate}T00:00:00Z`);
  const toDay = Date.parse(`${input.toDate}T00:00:00Z`);
  return limit >= 1 && limit <= MAX_CALENDAR_LIMIT && toDay > fromDay && (toDay - fromDay) / DAY_MS <= MAX_CALENDAR_DAYS;
}

function eventIntersectsCalendarRange(event: GovernanceCalendarEvent, input: GovernanceCalendarInput): boolean {
  if (event.dateMode === "all_day") {
    const startDate = event.start;
    const endDate = event.end ?? event.start;
    return isIsoCalendarDate(startDate)
      && isIsoCalendarDate(endDate)
      && startDate <= endDate
      && startDate < input.toDate
      && endDate >= input.fromDate;
  }
  if (!isOffsetQualifiedInstant(event.start)) return false;
  const start = Date.parse(event.start);
  const end = event.end === null ? start : isOffsetQualifiedInstant(event.end) ? Date.parse(event.end) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  if (end === start) return start >= input.from.getTime() && start < input.to.getTime();
  return start < input.to.getTime() && end > input.from.getTime();
}

function calendarEventInstant(event: GovernanceCalendarEvent): number {
  return event.dateMode === "all_day" ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start);
}

// Bound each database/native-authorization batch, not the denied prefix. Only
// fully authorized rows consume the visible cap or its lookahead sentinel.
async function selectAuthorizedRows<Row>(
  readPage: (offset: number) => Promise<Row[]>,
  authorizePage: (rows: Row[]) => Promise<Row[]>,
  limit: number,
): Promise<Row[]> {
  const selected: Row[] = [];
  for (let offset = 0; ; offset += SOURCE_PAGE_SIZE) {
    const page = await readPage(offset);
    if (page.length === 0) break;
    const authorized = await authorizePage(page);
    for (const row of authorized) {
      selected.push(row);
      if (selected.length === limit + 1) return selected;
    }
    if (page.length < SOURCE_PAGE_SIZE) break;
  }
  return selected;
}

async function authorizeIssueCandidates<Row extends { issue: GovernancePlanningIssueAccess }>(
  rows: Row[],
  authorize: GovernancePlanningAuthorizer,
): Promise<Row[]> {
  const access = await authorize(rows.map(({ issue }) => issue), []);
  return rows.filter(({ issue }) => access.issueIds.has(issue.id));
}

export async function getIssuePlanningGate(
  db: Db,
  companyId: string,
  issueId: string,
  now: Date,
  executor?: string,
): Promise<IssuePlanningGate> {
  const rows = await db.select({ planning: issuePlanning, assigneeAgentId: issues.assigneeAgentId })
    .from(issuePlanning)
    .innerJoin(issues, and(eq(issues.id, issuePlanning.issueId), eq(issues.companyId, issuePlanning.companyId)))
    .where(and(eq(issuePlanning.companyId, companyId), eq(issuePlanning.issueId, issueId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { eligible: true, reason: "ready", earliestStart: null, revision: null };
  const planning = row.planning;
  const earliestStart = planning.earliestStart;
  if (executor && row.assigneeAgentId !== executor) {
    return { eligible: false, reason: "unknown", earliestStart, revision: planning.revision };
  }
  if (planning.dateMode !== "timed" && planning.dateMode !== "all_day") {
    return { eligible: false, reason: "unknown", earliestStart, revision: planning.revision };
  }
  if (!isValidIanaTimezone(planning.timezone)
    || (earliestStart !== null && (planning.dateMode === "all_day"
      ? !isIsoCalendarDate(earliestStart)
      : !isOffsetQualifiedInstant(earliestStart)))) {
    return { eligible: false, reason: "unknown", earliestStart, revision: planning.revision };
  }
  if (!Number.isFinite(now.getTime())) {
    return { eligible: false, reason: "unknown", earliestStart, revision: planning.revision };
  }
  const eligible = isIssueStartEligible(earliestStart, now, planning.timezone, planning.dateMode);
  return {
    eligible,
    reason: eligible ? "ready" : "earliest_start",
    earliestStart,
    revision: planning.revision,
  };
}

export async function updateIssuePlanning(
  db: Db,
  companyId: string,
  issueId: string,
  input: IssuePlanningInput,
  actor: PlanningMutationActor,
) {
  return db.transaction(async (tx) => {
    const [issue] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!issue) return { kind: "not_found" as const };

    const { expectedRevision, ...values } = input;
    const [current] = await tx.select().from(issuePlanning)
      .where(and(eq(issuePlanning.issueId, issueId), eq(issuePlanning.companyId, companyId)))
      .for("update")
      .limit(1);
    if ((current?.revision ?? 0) !== expectedRevision) return { kind: "conflict" as const };
    const merged = issuePlanningInputSchema.safeParse({
      expectedRevision,
      timezone: values.timezone,
      dateMode: values.dateMode,
      earliestStart: values.earliestStart === undefined ? current?.earliestStart ?? null : values.earliestStart,
      plannedStart: values.plannedStart === undefined ? current?.plannedStart ?? null : values.plannedStart,
      plannedFinish: values.plannedFinish === undefined ? current?.plannedFinish ?? null : values.plannedFinish,
      hardDeadline: values.hardDeadline === undefined ? current?.hardDeadline ?? null : values.hardDeadline,
      forecastStart: values.forecastStart === undefined ? current?.forecastStart ?? null : values.forecastStart,
      forecastFinish: values.forecastFinish === undefined ? current?.forecastFinish ?? null : values.forecastFinish,
      actualStart: values.actualStart === undefined ? current?.actualStart ?? null : values.actualStart,
      actualFinish: values.actualFinish === undefined ? current?.actualFinish ?? null : values.actualFinish,
    });
    if (!merged.success) return { kind: "invalid" as const, details: merged.error.flatten() };
    const { expectedRevision: _revision, ...resultingValues } = merged.data;
    let planning;
    if (!current) {
      if (expectedRevision !== 0) return { kind: "conflict" as const };
      const [created] = await tx.insert(issuePlanning).values({ issueId, companyId, ...resultingValues, revision: 1 })
        .onConflictDoNothing().returning();
      if (!created) return { kind: "conflict" as const };
      planning = created;
    } else {
      if (current.revision !== expectedRevision) return { kind: "conflict" as const };
      const [updated] = await tx.update(issuePlanning)
        .set({ ...resultingValues, revision: expectedRevision + 1, updatedAt: new Date() })
        .where(and(
          eq(issuePlanning.issueId, issueId),
          eq(issuePlanning.companyId, companyId),
          eq(issuePlanning.revision, expectedRevision),
        ))
        .returning();
      if (!updated) return { kind: "conflict" as const };
      planning = updated;
    }

    await tx.insert(activityLog).values({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      responsibleUserId: actor.responsibleUserId,
      action: "issue.planning_updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        revision: planning.revision,
        dateMode: planning.dateMode,
        timezone: planning.timezone,
        earliestStart: planning.earliestStart,
        plannedStart: planning.plannedStart,
        plannedFinish: planning.plannedFinish,
        hardDeadline: planning.hardDeadline,
        forecastStart: planning.forecastStart,
        forecastFinish: planning.forecastFinish,
        actualStart: planning.actualStart,
        actualFinish: planning.actualFinish,
      },
    });
    return { kind: "updated" as const, planning };
  });
}

export async function getGovernanceCalendar(db: Db, input: GovernanceCalendarInput): Promise<GovernanceCalendarResult> {
  const limit = input.limit ?? DEFAULT_CALENDAR_LIMIT;
  if (!Number.isInteger(limit) || !validCalendarInput(input, limit)) {
    throw new RangeError("Calendar range, timezone, or event limit is invalid");
  }

  const warnings: string[] = [];
  const warningSet = new Set<string>();
  const warn = (message: string) => {
    if (!warningSet.has(message)) {
      warningSet.add(message);
      warnings.push(message);
    }
  };
  const events: GovernanceCalendarEvent[] = [];
  let incomplete = false;
  let eventGenerationCapped = false;
  const cronBudget = { remainingMinutes: MAX_CRON_SEARCH_MINUTES };
  const appendEvent = (event: GovernanceCalendarEvent) => {
    if ((input.source && event.source !== input.source) || (input.actualOnly && !event.actual)) return true;
    if (!eventIntersectsCalendarRange(event, input)) return true;
    if (events.length >= MAX_GENERATED_EVENTS) {
      eventGenerationCapped = true;
      incomplete = true;
      return false;
    }
    events.push(event);
    return true;
  };

  const issueVisibility = await issueReadSqlCondition(db, input.actor);
  const projectVisibility = await projectReadSqlCondition(db, input.actor);
  const readableIssueIds = db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), issueVisibility));
  const readableProjectIds = db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.companyId, input.companyId), projectVisibility));
  const routineScope = and(
    or(isNull(routines.parentIssueId), inArray(routines.parentIssueId, readableIssueIds)),
    or(isNull(routines.projectId), inArray(routines.projectId, readableProjectIds)),
    input.projectId ? or(
      eq(routines.projectId, input.projectId),
      and(isNull(routines.projectId), inArray(routines.parentIssueId,
        db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), issueVisibility, eq(issues.projectId, input.projectId))))),
    ) : undefined,
    input.assigneeAgentId ? or(
      eq(routines.assigneeAgentId, input.assigneeAgentId),
      and(isNull(routines.assigneeAgentId), inArray(routines.parentIssueId,
        db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), issueVisibility, eq(issues.assigneeAgentId, input.assigneeAgentId))))),
    ) : undefined,
  );

  const authorizeRoutineCandidates = async <Row extends { routine: typeof routines.$inferSelect }>(rows: Row[]): Promise<Row[]> => {
    const parentIds = [...new Set(rows.flatMap(({ routine }) => routine.parentIssueId ? [routine.parentIssueId] : []))];
    const parents = parentIds.length === 0 ? [] : await db.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), issueVisibility, inArray(issues.id, parentIds),
    ));
    const projectIds = [...new Set(rows.flatMap(({ routine }) => routine.projectId ? [routine.projectId] : []))];
    const access = await input.authorize(parents, projectIds);
    return rows.filter(({ routine }) => (!routine.parentIssueId || access.issueIds.has(routine.parentIssueId))
      && (!routine.projectId || access.projectIds.has(routine.projectId)));
  };

  const issueCandidates = input.source === "routine" || input.source === "run" ? [] : await selectAuthorizedRows((offset) => db
    .select({ issue: issues, planning: issuePlanning })
    .from(issues)
    .leftJoin(issuePlanning, and(eq(issuePlanning.issueId, issues.id), eq(issuePlanning.companyId, issues.companyId)))
    .where(and(
      eq(issues.companyId, input.companyId),
      issueVisibility,
      input.projectId ? eq(issues.projectId, input.projectId) : undefined,
      input.assigneeAgentId ? eq(issues.assigneeAgentId, input.assigneeAgentId) : undefined,
      or(
        isNotNull(issuePlanning.issueId),
        isNotNull(issues.startedAt),
        isNotNull(issues.completedAt),
        isNotNull(issues.cancelledAt),
      ),
    ))
    .orderBy(issues.updatedAt, issues.id)
    .limit(SOURCE_PAGE_SIZE).offset(offset), (rows) => authorizeIssueCandidates(rows, input.authorize), MAX_SOURCE_SCAN);
  if (issueCandidates.length > MAX_SOURCE_SCAN) {
    incomplete = true;
    warn("Some calendar sources exceeded their safe scan bound; the projection may be incomplete.");
  }

  const routineCandidates = input.source === "issue" || input.source === "run" ? [] : await selectAuthorizedRows((offset) => db
    .select({ trigger: routineTriggers, routine: routines })
    .from(routineTriggers)
    .innerJoin(routines, and(eq(routines.id, routineTriggers.routineId), eq(routines.companyId, routineTriggers.companyId)))
    .where(and(
      eq(routineTriggers.companyId, input.companyId),
      routineScope,
      eq(routineTriggers.kind, "schedule"),
      eq(routineTriggers.enabled, true),
      eq(routineTriggers.archived, false),
      inArray(routines.status, ["active", "paused"]),
    ))
    .orderBy(routineTriggers.nextRunAt, routineTriggers.id)
    .limit(SOURCE_PAGE_SIZE).offset(offset), authorizeRoutineCandidates, MAX_SOURCE_SCAN);
  if (routineCandidates.length > MAX_SOURCE_SCAN) {
    incomplete = true;
    warn("Some calendar sources exceeded their safe scan bound; the projection may be incomplete.");
  }

  const runCandidates = input.source === "issue" || input.source === "routine" ? [] : await selectAuthorizedRows((offset) => db
    .select({ run: routineRuns, routine: routines })
    .from(routineRuns)
    .innerJoin(routines, and(eq(routines.id, routineRuns.routineId), eq(routines.companyId, routineRuns.companyId)))
    .where(and(
      eq(routineRuns.companyId, input.companyId),
      routineScope,
      or(
        and(gte(routineRuns.triggeredAt, input.from), lt(routineRuns.triggeredAt, input.to)),
        and(lt(routineRuns.triggeredAt, input.from), isNotNull(routineRuns.completedAt), gt(routineRuns.completedAt, input.from)),
      ),
    ))
    .orderBy(routineRuns.triggeredAt, routineRuns.id)
    .limit(SOURCE_PAGE_SIZE).offset(offset), authorizeRoutineCandidates, MAX_SOURCE_SCAN);
  if (runCandidates.length > MAX_SOURCE_SCAN) {
    incomplete = true;
    warn("Some calendar sources exceeded their safe scan bound; the projection may be incomplete.");
  }

  const occurrenceCandidates = input.source === "issue" || input.source === "run" ? [] : await selectAuthorizedRows((offset) => db
    .select({ occurrence: routineOccurrences, routine: routines })
    .from(routineOccurrences)
    .innerJoin(routines, and(eq(routines.id, routineOccurrences.routineId), eq(routines.companyId, routineOccurrences.companyId)))
    .where(and(
      eq(routineOccurrences.companyId, input.companyId),
      routineScope,
      gte(routineOccurrences.scheduledAt, input.from),
      lt(routineOccurrences.scheduledAt, input.to),
    ))
    .orderBy(routineOccurrences.scheduledAt, routineOccurrences.id)
    .limit(SOURCE_PAGE_SIZE).offset(offset), authorizeRoutineCandidates, MAX_SOURCE_SCAN);
  if (occurrenceCandidates.length > MAX_SOURCE_SCAN) {
    incomplete = true;
    warn("Some calendar sources exceeded their safe scan bound; the projection may be incomplete.");
  }

  const parentIssueIds = new Set<string>();
  const projectIds = new Set<string>();
  const issueAccessById = new Map<string, GovernancePlanningIssueAccess>();
  for (const { issue } of issueCandidates.slice(0, MAX_SOURCE_SCAN)) {
    issueAccessById.set(issue.id, issue);
    if (issue.projectId) projectIds.add(issue.projectId);
  }
  for (const { routine } of [...routineCandidates, ...runCandidates, ...occurrenceCandidates]) {
    if (routine.parentIssueId) parentIssueIds.add(routine.parentIssueId);
    if (routine.projectId) projectIds.add(routine.projectId);
  }
  for (const { run } of runCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (run.linkedIssueId) parentIssueIds.add(run.linkedIssueId);
  }
  for (const { occurrence } of occurrenceCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (occurrence.taskId) parentIssueIds.add(occurrence.taskId);
  }
  if (parentIssueIds.size > 0) {
    const parents = await db.select().from(issues).where(and(
      eq(issues.companyId, input.companyId),
      issueVisibility,
      inArray(issues.id, [...parentIssueIds]),
    ));
    for (const issue of parents) {
      issueAccessById.set(issue.id, issue);
      if (issue.projectId) projectIds.add(issue.projectId);
    }
  }
  const projectRows = projectIds.size === 0 ? [] : await db.select().from(projects).where(and(
    eq(projects.companyId, input.companyId),
    projectVisibility,
    inArray(projects.id, [...projectIds]),
  ));
  const projectById = new Map(projectRows.map((project) => [project.id, project]));
  const access = await input.authorize([...issueAccessById.values()], [...projectIds]);

  const issueCanBeRead = (issueId: string) => {
    const issue = issueAccessById.get(issueId);
    return Boolean(issue && access.issueIds.has(issueId));
  };
  const routineMatchesFilters = (routine: typeof routines.$inferSelect) => {
    const parent = routine.parentIssueId ? issueAccessById.get(routine.parentIssueId) : undefined;
    const effectiveProjectId = routine.projectId ?? parent?.projectId ?? null;
    const effectiveAssigneeAgentId = routine.assigneeAgentId ?? parent?.assigneeAgentId ?? null;
    if (routine.parentIssueId && (!parent || !issueCanBeRead(parent.id))) return false;
    if (routine.projectId && !access.projectIds.has(routine.projectId)) return false;
    if (input.projectId && effectiveProjectId !== input.projectId) return false;
    if (input.assigneeAgentId && effectiveAssigneeAgentId !== input.assigneeAgentId) return false;
    return true;
  };

  for (const { issue, planning } of issueCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (eventGenerationCapped) break;
    if (!issueCanBeRead(issue.id)) continue;
    const status = issue.status || "unknown";
    if (planning && (planning.dateMode !== "timed" && planning.dateMode !== "all_day" || !isValidIanaTimezone(planning.timezone))) {
      warn(`Issue ${issue.id}: saved planning date mode or timezone is invalid; planning dates were omitted.`);
    } else if (planning) {
      const dateMode = planning.dateMode as "timed" | "all_day";
      const timezone = planning.timezone;
      const planningEvent = (
        eventKind: GovernanceCalendarEvent["eventKind"],
        start: string | null,
        end: string | null,
        actual: boolean,
      ) => {
        if (!start || (!end && eventKind === "planned" && !planning.plannedStart)) return;
        const event: GovernanceCalendarEvent = {
          id: `${issue.id}:${eventKind}`,
          source: "issue",
          eventKind,
          title: issue.title,
          href: `/issues/${issue.id}`,
          start,
          end,
          actual,
          status,
          dateMode,
          timezone,
        };
        if (!appendEvent(event)) eventGenerationCapped = true;
      };
      const plannedStart = planning.plannedStart ?? planning.plannedFinish;
      planningEvent("earliest_start", planning.earliestStart, null, false);
      planningEvent("planned", plannedStart, planning.plannedFinish, false);
      planningEvent("hard_deadline", planning.hardDeadline, null, false);
      planningEvent("forecast", planning.forecastStart ?? planning.forecastFinish, planning.forecastFinish, false);
      planningEvent("recorded_actual", planning.actualStart ?? planning.actualFinish, planning.actualFinish, true);
    }

    const nativeActualStart = issue.startedAt ?? issue.completedAt;
    const nativeActualEnd = issue.completedAt;
    if (nativeActualStart || nativeActualEnd) {
      const start = (nativeActualStart ?? nativeActualEnd)!.toISOString();
      if (!appendEvent({
        id: `${issue.id}:native_actual`, source: "issue", eventKind: "native_actual", title: issue.title,
        href: `/issues/${issue.id}`, start, end: nativeActualEnd?.toISOString() ?? null,
        actual: true, status, dateMode: "timed", timezone: input.timezone,
      })) eventGenerationCapped = true;
    }
    if (issue.cancelledAt && !eventGenerationCapped) {
      if (!appendEvent({
        id: `${issue.id}:native_cancelled`, source: "issue", eventKind: "native_cancelled", title: issue.title,
        href: `/issues/${issue.id}`, start: issue.cancelledAt.toISOString(), end: null,
        actual: true, status: "cancelled", dateMode: "timed", timezone: input.timezone,
      })) eventGenerationCapped = true;
    }
  }

  const occurrenceByTick = new Set<string>();
  for (const { occurrence, routine } of occurrenceCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (!routineMatchesFilters(routine)) continue;
    occurrenceByTick.add(`${occurrence.triggerId}:${occurrence.scheduledAt.getTime()}`);
    const linkedTaskHref = occurrence.taskId && issueCanBeRead(occurrence.taskId) ? `/issues/${occurrence.taskId}` : null;
    if (!appendEvent({
      id: occurrence.id,
      source: "routine",
      eventKind: "routine_occurrence",
      title: routine.title,
      href: linkedTaskHref ?? `/routines/${routine.id}`,
      start: occurrence.scheduledAt.toISOString(),
      end: null,
      actual: true,
      status: occurrence.executionState || "unknown",
      dateMode: "timed",
      timezone: input.timezone,
      disposition: occurrence.disposition,
      warning: occurrence.decisionReason ?? undefined,
    })) eventGenerationCapped = true;
    if (eventGenerationCapped) break;
  }

  for (const { trigger, routine } of routineCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (eventGenerationCapped || input.actualOnly) break;
    if (!routineMatchesFilters(routine)) continue;
    const pausedProjectId = routine.projectId ?? (routine.parentIssueId ? issueAccessById.get(routine.parentIssueId)?.projectId : null);
    if (routine.status === "paused") {
      warn(`Routine ${routine.id}: routine is paused; no occurrence forecasted.`);
      continue;
    }
    if (pausedProjectId && !access.projectIds.has(pausedProjectId)) {
      incomplete = true;
      warn(`Routine ${routine.id}: project scheduling state is unavailable; no occurrence forecasted.`);
      continue;
    }
    if (pausedProjectId && projectById.get(pausedProjectId)?.pausedAt) {
      warn(`Routine ${routine.id}: project is paused; no occurrence forecasted.`);
      continue;
    }
    if (trigger.setupPending) {
      warn(`Routine ${routine.id}: schedule setup is incomplete.`);
      continue;
    }
    if (!trigger.cronExpression || !trigger.timezone) {
      warn(`Routine ${routine.id}: schedule definition is incomplete.`);
      continue;
    }
    if (!isValidIanaTimezone(trigger.timezone)) {
      warn(`Routine ${routine.id}: schedule timezone is invalid.`);
      continue;
    }
    if (!trigger.nextRunAt || !Number.isFinite(trigger.nextRunAt.getTime())) {
      warn(`Routine ${routine.id}: next scheduled run is unavailable.`);
      continue;
    }

    try {
      const search = { before: input.to, budget: cronBudget };
      if (trigger.nextRunAt <= input.now && routine.catchUpPolicy === "enqueue_missed_with_cap") {
        warn(`Routine ${routine.id}: missed catch-up occurrences are shown after the scheduler persists their current state.`);
      }
      const after = new Date(Math.max(input.now.getTime() + 1, input.from.getTime(), trigger.nextRunAt.getTime()) - 1);
      let uninspectedMinutes = false;
      const nextTick = (cursor: Date) => {
        // The native helper starts at floor(after) + one minute. A null result
        // is incomplete only if it consumed fewer minutes than this interval.
        const firstMinute = (Math.floor(cursor.getTime() / 60_000) + 1) * 60_000;
        const candidateMinutes = Math.max(0, Math.ceil((input.to.getTime() - firstMinute) / 60_000));
        const remainingBefore = cronBudget.remainingMinutes;
        const next = nextCronTickInTimeZone(trigger.cronExpression!, trigger.timezone!, cursor, search);
        uninspectedMinutes = next === null && remainingBefore - cronBudget.remainingMinutes < candidateMinutes;
        return next;
      };
      let tick = nextTick(after);
      let scheduleIterations = 0;
      while (tick && tick < input.to && scheduleIterations < MAX_SCHEDULE_ITERATIONS && !eventGenerationCapped) {
        if (!occurrenceByTick.has(`${trigger.id}:${tick.getTime()}`)) {
          if (!appendEvent({
            id: `${trigger.id}:${tick.toISOString()}`,
            source: "routine",
            eventKind: "routine_schedule",
            title: routine.title,
            href: `/routines/${routine.id}`,
            start: tick.toISOString(),
            end: null,
            actual: false,
            status: "projected",
            dateMode: "timed",
            timezone: trigger.timezone,
          })) eventGenerationCapped = true;
        }
        if (eventGenerationCapped) break;
        tick = nextTick(tick);
        scheduleIterations += 1;
      }
      if (uninspectedMinutes) {
        incomplete = true;
        warn("Routine schedule projection exhausted its shared minute-search budget; this range may be incomplete.");
      } else if (tick && tick < input.to && scheduleIterations >= MAX_SCHEDULE_ITERATIONS) {
        incomplete = true;
        warn("Routine schedule projection reached its safe recurrence event cap.");
      }
    } catch (error) {
      incomplete = true;
      warn(`Routine ${routine.id}: invalid schedule (${error instanceof Error ? error.message : "unknown error"}).`);
    }
  }

  for (const { run, routine } of runCandidates.slice(0, MAX_SOURCE_SCAN)) {
    if (eventGenerationCapped) break;
    if (!routineMatchesFilters(routine)) continue;
    const taskHref = run.linkedIssueId && issueCanBeRead(run.linkedIssueId) ? `/issues/${run.linkedIssueId}` : null;
    if (!appendEvent({
      id: run.id,
      source: "run",
      eventKind: "routine_run",
      title: routine.title,
      href: taskHref ?? `/routines/${routine.id}`,
      start: run.triggeredAt.toISOString(),
      end: run.completedAt?.toISOString() ?? null,
      actual: true,
      status: run.status ?? "unknown",
      dateMode: "timed",
      timezone: input.timezone,
    })) eventGenerationCapped = true;
  }

  if (eventGenerationCapped) warn("Calendar event projection reached its safe generation cap; some events are not shown.");
  events.sort((left, right) => calendarEventInstant(left) - calendarEventInstant(right)
    || left.eventKind.localeCompare(right.eventKind)
    || left.id.localeCompare(right.id));
  const truncated = events.length > limit;
  if (truncated) warn("The authorized calendar event result reached its requested limit; narrow the date range or filters.");
  return {
    events: events.slice(0, limit),
    truncated,
    incomplete,
    warnings,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    fromDate: input.fromDate,
    toDate: input.toDate,
    timezone: input.timezone,
  };
}

export async function listPlanableTasks(db: Db, input: PlanableTaskInput): Promise<GovernancePlanableTasksResult> {
  const limit = input.limit ?? MAX_TASK_PICKER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PICKER_LIMIT_CEILING) {
    throw new RangeError("Task selector limit is invalid");
  }
  const search = input.query?.trim().slice(0, 100);
  const issueVisibility = await issueReadSqlCondition(db, input.actor);
  const candidates = await selectAuthorizedRows((offset) => db.select({ issue: issues })
    .from(issues)
    .leftJoin(issuePlanning, and(eq(issuePlanning.issueId, issues.id), eq(issuePlanning.companyId, issues.companyId)))
    .where(and(
      eq(issues.companyId, input.companyId),
      issueVisibility,
      isNull(issuePlanning.issueId),
      notInArray(issues.status, ["done", "cancelled"]),
      input.projectId ? eq(issues.projectId, input.projectId) : undefined,
      input.assigneeAgentId ? eq(issues.assigneeAgentId, input.assigneeAgentId) : undefined,
      search ? or(ilike(issues.title, `%${search}%`), ilike(issues.identifier, `%${search}%`)) : undefined,
    ))
    .orderBy(issues.updatedAt, issues.id)
    .limit(SOURCE_PAGE_SIZE).offset(offset), (rows) => authorizeIssueCandidates(rows, input.authorize), limit);
  const visible = candidates.map(({ issue }) => issue);
  return {
    tasks: visible.slice(0, limit).map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status || "unknown",
    })),
    truncated: visible.length > limit,
    incomplete: false,
  };
}
