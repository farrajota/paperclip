import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, budgetPolicies, budgetReservations, cases, companies, companyMemberships, costEvents, decisionQueueItems, decisionQueues, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { routineOccurrences, routines, routineTriggers } from "@paperclipai/db/schema/routines";
import { governanceMilestones, governanceMilestoneRevisions } from "@paperclipai/db/schema/governance_milestones";
import { governanceOperationExceptions, governanceOperationExceptionEvents, governanceOperationExceptionEscalations } from "@paperclipai/db/schema/governance_operations";
import { governanceOperationExceptionAdmissionSchema, governanceOperationExceptionPauseSchema, governanceOperationExceptionResumeSchema, governanceOperationExceptionResolveSchema } from "@paperclipai/shared/governance-operations";
import type { GovernanceOperationExceptionAdmission, GovernanceOperationExceptionPause, GovernanceOperationExceptionResume, GovernanceOperationExceptionResolve, GovernanceOperationException, GovernanceOperationsReadModel, GovernanceOperationsRun } from "@paperclipai/shared/governance-operations";
import { addCents, normalizeCents } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { authorizationService, issueReadSqlCondition } from "./authorization.js";
import type { AuthorizationActor } from "./authorization.js";
import { canActorReadCase, caseReadSqlCondition, filterCasesForActor } from "./case-access.js";
import { computeObservedSpends, knownRunCostCents } from "./budget-exposure.js";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { getIssuePlanningGate } from "./governance-planning.js";
import { canReadDecisionSource } from "./decision-queues.js";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { getHeartbeatRunReadDecisions } from "./heartbeat-run-privacy.js";

const LIMIT = 100;
export const GOVERNANCE_EXCEPTION_CLOCK_POLICY = "UTC elapsed-time clock begins at admission. Received and admitted are separate audit events. Pause is allowed only before the deadline; resume adds the exact paused duration to the deadline. Active age excludes all accumulated pauses and freezes at resolution. Company/authority holds defer internal delivery with a 60-second concrete-obligation retry, not a clock pause. One internal escalation generation per exception; no automatic reopening or external notification.";
type ExceptionRow = typeof governanceOperationExceptions.$inferSelect;
type OccurrenceRow = typeof routineOccurrences.$inferSelect;
const iso = (value: Date | null) => value?.toISOString() ?? null;
const age = (now: Date, value: Date) => Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.trim() ? value : null;

/** Reused by the existing scheduled monitor queue; no separate timer engine. */
export function governanceExceptionDeadlineQuery(now = new Date()) {
  return sql`SELECT min(greatest(e.deadline_at, coalesce(e.escalation_retry_at, e.deadline_at), ${new Date(now.getTime() + 1000).toISOString()}::timestamptz)) AS next_at FROM governance_operation_exceptions e
    JOIN companies c ON c.id = e.company_id
    WHERE e.state = 'open' AND e.clock_paused_at IS NULL AND e.escalation_generation = 0`;
}

export function governanceOperationsService(db: Db) {
  async function mutate<T>(operation: (tx: Db) => Promise<T>) {
    try { return await db.transaction(tx => operation(tx as unknown as Db)); }
    catch (error) {
      const code = object(error).code ?? object(object(error).cause).code;
      if (code === "55P03" || code === "40P01" || code === "40001") throw conflict("Source authority changed concurrently; reload before retrying");
      throw error;
    }
  }
  async function beginMutation(client: Db, companyId: string) {
    await client.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
    // Independent authority writers may already hold source rows. NOWAIT
    // keeps contested source authority a CAS conflict, not a permission
    // fallback. Native creation callers still take company before sources.
    await client.execute(sql`LOCK TABLE issue_access_grants IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await client.execute(sql`LOCK TABLE project_access_members, company_memberships, case_access_sources IN SHARE MODE NOWAIT`);
    await notifyDeliveryWork(client, DELIVERY_QUEUES.issueMonitors, companyId);
  }
  async function companyAccess(client: Db, companyId: string, actor: AuthorizationActor) {
    const [company] = await client.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company || !(await authorizationService(client).decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed) throw notFound("Operations not found");
  }
  async function manager(client: Db, companyId: string, actor: AuthorizationActor) {
    if (actor.type !== "board" || !actor.userId || actor.authorizingUserId || actor.source === "mcp_oauth") throw forbidden("A current human company operator is required");
    const [member] = await client.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active"))).for("share", { noWait: true }).limit(1);
    if (!member || !["owner", "admin", "member"].includes(member.membershipRole ?? "")) throw forbidden("Current non-viewer company membership is required");
    await companyAccess(client, companyId, actor);
  }
  async function owner(client: Db, companyId: string, userId: string) {
    const [member] = await client.select({ id: companyMemberships.id }).from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).for("share", { noWait: true }).limit(1);
    if (!member) throw unprocessable("Exception owner must be a current company user");
  }
  async function readableIssue(client: Db, companyId: string, id: string, actor: AuthorizationActor) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    return (await authorizationService(client).decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: id } })).allowed;
  }
  async function readableProject(client: Db, companyId: string, id: string, actor: AuthorizationActor) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    return (await authorizationService(client).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId: id } })).allowed;
  }
  async function occurrenceAccess(client: Db, companyId: string, row: OccurrenceRow, actor: AuthorizationActor, lockSources = false) {
    const routineQuery = client.select().from(routines).where(and(eq(routines.companyId, companyId), eq(routines.id, row.routineId))).limit(1);
    const [routine] = await (lockSources ? routineQuery.for("share", { noWait: true }) : routineQuery);
    if (!routine || row.companyId !== companyId) return false;
    if (lockSources) {
      await client.execute(sql`SELECT id FROM cases WHERE company_id = ${companyId} AND id IN (${routine.caseId}, ${row.caseId}) ORDER BY id FOR SHARE NOWAIT`);
      await client.execute(sql`WITH RECURSIVE source_tasks AS (
        SELECT id, privacy_parent_issue_id FROM issues WHERE company_id = ${companyId} AND (id IN (${routine.parentIssueId}, ${row.taskId}) OR id IN (
          SELECT source_id FROM case_access_sources WHERE company_id = ${companyId} AND case_id IN (${routine.caseId}, ${row.caseId}) AND source_kind = 'issue'
        ) OR id IN (SELECT work_issue_id FROM cases WHERE company_id = ${companyId} AND id IN (${routine.caseId}, ${row.caseId})))
        UNION SELECT p.id, p.privacy_parent_issue_id FROM issues p JOIN source_tasks c ON p.id = c.privacy_parent_issue_id WHERE p.company_id = ${companyId}
      ) SELECT i.id FROM issues i WHERE i.id IN (SELECT id FROM source_tasks) ORDER BY i.id FOR SHARE NOWAIT`);
      await client.execute(sql`WITH RECURSIVE source_tasks AS (
        SELECT id, privacy_parent_issue_id, project_id FROM issues WHERE company_id = ${companyId} AND (id IN (${routine.parentIssueId}, ${row.taskId}) OR id IN (
          SELECT source_id FROM case_access_sources WHERE company_id = ${companyId} AND case_id IN (${routine.caseId}, ${row.caseId}) AND source_kind = 'issue'
        ) OR id IN (SELECT work_issue_id FROM cases WHERE company_id = ${companyId} AND id IN (${routine.caseId}, ${row.caseId})))
        UNION SELECT p.id, p.privacy_parent_issue_id, p.project_id FROM issues p JOIN source_tasks c ON p.id = c.privacy_parent_issue_id WHERE p.company_id = ${companyId}
      ) SELECT p.id FROM projects p WHERE p.company_id = ${companyId} AND (p.id = ${routine.projectId} OR p.id IN (
        SELECT project_id FROM source_tasks
        UNION SELECT project_id FROM cases WHERE company_id = ${companyId} AND id IN (${routine.caseId}, ${row.caseId})
        UNION SELECT source_id FROM case_access_sources WHERE company_id = ${companyId} AND case_id IN (${routine.caseId}, ${row.caseId}) AND source_kind = 'project'
      )) ORDER BY p.id FOR SHARE NOWAIT`);
    }
    for (const id of new Set([routine.parentIssueId, row.taskId].filter((id): id is string => !!id))) if (!(await readableIssue(client, companyId, id, actor))) return false;
    if (routine.projectId && !(await readableProject(client, companyId, routine.projectId, actor))) return false;
    for (const id of new Set([routine.caseId, row.caseId].filter((id): id is string => !!id))) if (!(await canActorReadCase(client, actor, { companyId, id }))) return false;
    return true;
  }
  async function event(client: Db, row: ExceptionRow, kind: string, actorUserId: string | null, reason: string | null, now: Date, details: Record<string, unknown> = {}) {
    await client.insert(governanceOperationExceptionEvents).values({ companyId: row.companyId, exceptionId: row.id, eventKey: `${kind}:${row.revision}`, kind, actorUserId, reason, details, createdAt: now });
  }
  async function exceptionForMutation(client: Db, companyId: string, id: string, expectedRevision: number, actor: AuthorizationActor, requireActiveOwner: boolean) {
    await beginMutation(client, companyId);
    await manager(client, companyId, actor);
    const [row] = await client.select().from(governanceOperationExceptions).where(and(eq(governanceOperationExceptions.id, id), eq(governanceOperationExceptions.companyId, companyId))).for("update").limit(1);
    if (!row) throw notFound("Exception not found");
    const [occurrence] = await client.select().from(routineOccurrences).where(and(eq(routineOccurrences.id, row.occurrenceId), eq(routineOccurrences.companyId, companyId))).for("share", { noWait: true }).limit(1);
    if (!occurrence || !(await occurrenceAccess(client, companyId, occurrence, actor, true))) throw notFound("Exception not found");
    // Closing an obligation delegates no new work to its former owner.
    if (requireActiveOwner) await owner(client, companyId, row.ownerUserId);
    if (row.revision !== expectedRevision || row.state !== "open") throw conflict("Exception changed; reload its current revision");
    return row;
  }
  async function admitException(companyId: string, occurrenceId: string, input: GovernanceOperationExceptionAdmission, actor: AuthorizationActor, now = new Date()) {
    const parsed = governanceOperationExceptionAdmissionSchema.safeParse(input);
    if (!parsed.success || !Number.isFinite(now.getTime())) throw unprocessable("Invalid exception admission");
    const deadlineAt = new Date(parsed.data.deadlineAt);
    if (deadlineAt <= now) throw unprocessable("Deadline must be after admission");
    return mutate(async transaction => {
      const tx = transaction as unknown as Db;
      await beginMutation(tx, companyId);
      await manager(tx, companyId, actor);
      await owner(tx, companyId, parsed.data.ownerUserId);
      const [occurrence] = await tx.select().from(routineOccurrences).where(and(eq(routineOccurrences.id, occurrenceId), eq(routineOccurrences.companyId, companyId))).for("update", { noWait: true }).limit(1);
      if (!occurrence || !(await occurrenceAccess(tx, companyId, occurrence, actor, true))) throw notFound("Occurrence not found");
      if (occurrence.disposition === "satisfied" || occurrence.executionState === "satisfied") throw conflict("Satisfied occurrences are not operational exceptions");
      const [existing] = await tx.select({ id: governanceOperationExceptions.id }).from(governanceOperationExceptions).where(and(eq(governanceOperationExceptions.companyId, companyId), eq(governanceOperationExceptions.occurrenceId, occurrenceId))).limit(1);
      if (existing) throw conflict("This occurrence already has an exception");
      const [row] = await tx.insert(governanceOperationExceptions).values({ companyId, occurrenceId, reason: parsed.data.reason, ownerUserId: parsed.data.ownerUserId, receivedAt: now, admittedAt: now, deadlineAt, createdByUserId: actor.userId, createdAt: now, updatedAt: now }).returning();
      await event(tx, row!, "received", actor.userId!, parsed.data.reason, now, { occurrenceId });
      await event(tx, row!, "admitted", actor.userId!, parsed.data.reason, now, { deadlineAt: deadlineAt.toISOString(), clockPolicy: GOVERNANCE_EXCEPTION_CLOCK_POLICY });
      return row!;
    });
  }
  async function transition(companyId: string, id: string, input: GovernanceOperationExceptionPause | GovernanceOperationExceptionResume | GovernanceOperationExceptionResolve, actor: AuthorizationActor, kind: "paused" | "resumed" | "resolved", now: Date) {
    const schema = kind === "paused" ? governanceOperationExceptionPauseSchema : kind === "resumed" ? governanceOperationExceptionResumeSchema : governanceOperationExceptionResolveSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success || !Number.isFinite(now.getTime())) throw unprocessable("Invalid exception transition");
    return mutate(async transaction => {
      const tx = transaction as unknown as Db;
      const row = await exceptionForMutation(tx, companyId, id, input.expectedRevision, actor, kind !== "resolved");
      if (now < row.updatedAt || (row.clockPausedAt && now < row.clockPausedAt)) throw unprocessable("Clock cannot move backwards");
      if (kind === "paused" && (row.clockPausedAt || now >= row.deadlineAt || row.escalationGeneration > 0)) throw conflict("Only an unpaused, not-yet-due exception can be paused");
      if (kind === "resumed" && !row.clockPausedAt) throw conflict("Exception is not paused");
      const reason = "reason" in parsed.data ? string(parsed.data.reason) : null;
      const pausedDuration = row.clockPausedAt ? now.getTime() - row.clockPausedAt.getTime() : 0;
      const patch = kind === "paused" ? { clockPausedAt: now, pauseReason: reason }
        : kind === "resumed" ? { clockPausedAt: null, pauseReason: null, lastResumedAt: now, clockPausedTotalMs: row.clockPausedTotalMs + pausedDuration, deadlineAt: new Date(row.deadlineAt.getTime() + pausedDuration) }
        : { state: "resolved", resolvedAt: now, resolutionNote: reason, clockPausedAt: null, pauseReason: null, clockPausedTotalMs: row.clockPausedTotalMs + pausedDuration, escalationRetryAt: null, escalationBlockReason: null };
      const [updated] = await tx.update(governanceOperationExceptions).set({ ...patch, revision: row.revision + 1, updatedAt: now }).where(and(eq(governanceOperationExceptions.id, id), eq(governanceOperationExceptions.revision, input.expectedRevision))).returning();
      if (!updated) throw conflict("Exception revision changed");
      await event(tx, updated, kind, actor.userId!, reason, now, { previousDeadlineAt: row.deadlineAt.toISOString(), deadlineAt: updated.deadlineAt.toISOString() });
      return updated;
    });
  }
  async function tickExceptions(now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw unprocessable("Invalid escalation clock");
    const due = await db.select({ id: governanceOperationExceptions.id, companyId: governanceOperationExceptions.companyId }).from(governanceOperationExceptions).where(and(eq(governanceOperationExceptions.state, "open"), isNull(governanceOperationExceptions.clockPausedAt), eq(governanceOperationExceptions.escalationGeneration, 0), lte(governanceOperationExceptions.deadlineAt, now), or(isNull(governanceOperationExceptions.escalationRetryAt), lte(governanceOperationExceptions.escalationRetryAt, now)))).orderBy(asc(governanceOperationExceptions.deadlineAt), asc(governanceOperationExceptions.id)).limit(LIMIT);
    let delivered = 0;
    for (const candidate of due) {
      const applied = await mutate(async transaction => {
        const tx = transaction as unknown as Db;
        // Match native creation/final dispatch: company, privacy, then source
        // endpoints. Waiting for privacy after source SHARE locks can deadlock
        // a native privacy mutation that is waiting to update those endpoints.
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, candidate.companyId)).for("no key update").limit(1);
        if (!company) return false;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${candidate.companyId}`}, 0))`);
        await beginMutation(tx, candidate.companyId);
        const [row] = await tx.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, candidate.id)).for("update").limit(1);
        if (!row || row.state !== "open" || row.clockPausedAt || row.escalationGeneration !== 0 || row.deadlineAt > now || (row.escalationRetryAt && row.escalationRetryAt > now)) return false;
        async function deferEscalation(reason: string) {
          const [deferred] = await tx.update(governanceOperationExceptions).set({ escalationRetryAt: new Date(now.getTime() + 60_000), escalationBlockReason: reason, revision: row!.revision + 1, updatedAt: now }).where(and(eq(governanceOperationExceptions.id, row!.id), eq(governanceOperationExceptions.revision, row!.revision))).returning();
          if (!deferred) throw conflict("Exception changed during escalation deferral");
          await event(tx, deferred, "escalation_blocked", null, reason, now);
          return false;
        }
        if (company.status !== "active") return deferEscalation("Current company authority is unavailable");
        const actor: AuthorizationActor = { type: "board", userId: row.createdByUserId, source: "session", companyIds: [row.companyId] };
        // Admission is not perpetual delegated authority. Revalidate the human
        // operator, owner, and every current source before creating internal work.
        const [operator] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, row.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, row.createdByUserId ?? ""), eq(companyMemberships.status, "active"))).for("share").limit(1);
        const [ownerMember] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, row.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, row.ownerUserId), eq(companyMemberships.status, "active"))).for("share").limit(1);
        if (!operator || !["owner", "admin", "member"].includes(operator.membershipRole ?? "") || !ownerMember) return deferEscalation("Current operator or owner membership is unavailable");
        const [occurrence] = await tx.select().from(routineOccurrences).where(and(eq(routineOccurrences.companyId, row.companyId), eq(routineOccurrences.id, row.occurrenceId))).for("share", { noWait: true }).limit(1);
        if (!occurrence || !(await occurrenceAccess(tx, row.companyId, occurrence, actor, true))) return deferEscalation("Current occurrence source authority is unavailable");
        const ownerActor: AuthorizationActor = { ...actor, userId: row.ownerUserId };
        if (!(await occurrenceAccess(tx, row.companyId, occurrence, ownerActor))) return deferEscalation("The exception owner cannot currently read the source");
        const [routine] = await tx.select().from(routines).where(eq(routines.id, occurrence.routineId)).limit(1);
        const parentId = occurrence.taskId ?? routine?.parentIssueId ?? null;
        const task = await issueService(db).create(row.companyId, {
          title: "Recurring exception deadline exceeded", description: `Operational exception ${row.id}; generation 1. Review the authorized occurrence and exception history before deciding disposition.`,
          parentId, visibility: "private", status: "todo", projectId: routine?.projectId ?? null, assigneeUserId: row.ownerUserId, responsibleUserId: row.ownerUserId,
          createdByUserId: row.createdByUserId, originKind: "governance_operation_escalation", originId: `${row.id}:1`, idempotencyKey: `governance-operation:${row.companyId}:${row.id}:1`,
        }, transaction);
        await tx.insert(governanceOperationExceptionEscalations).values({ companyId: row.companyId, exceptionId: row.id, generation: 1, taskIssueId: task.id, deadlineAt: row.deadlineAt, createdAt: now });
        const [updated] = await tx.update(governanceOperationExceptions).set({ escalationGeneration: 1, escalatedAt: now, escalationRetryAt: null, escalationBlockReason: null, revision: row.revision + 1, updatedAt: now }).where(and(eq(governanceOperationExceptions.id, row.id), eq(governanceOperationExceptions.revision, row.revision))).returning();
        if (!updated) throw conflict("Exception escalation revision changed");
        await event(tx, updated, "escalated", null, "Deadline exceeded", now, { generation: 1, issueId: task.id });
        return true;
      });
      if (applied) delivered += 1;
    }
    return { delivered, batchLimit: LIMIT, scanned: due.length };
  }

  async function read(companyId: string, actor: AuthorizationActor, now = new Date()): Promise<GovernanceOperationsReadModel> {
    await companyAccess(db, companyId, actor);
    const access = authorizationService(db), truncated: string[] = [];
    function page<T>(_name: string, rows: T[]) { return rows.slice(0, LIMIT); }
    const issueRows = page("issues", await db.select().from(issues).where(and(eq(issues.companyId, companyId), await issueReadSqlCondition(db, actor))).orderBy(desc(issues.updatedAt), asc(issues.id)).limit(LIMIT + 1));
    const issueDecisions = await access.decideReads(actor, issueRows.map(row => ({ type: "issue" as const, companyId, issueId: row.id })));
    const visibleIssues = issueRows.filter((_, index) => issueDecisions[index]?.allowed);
    const issueIds = new Set(visibleIssues.map(row => row.id));
    const fullFinance = actor.type === "board" && !actor.keyScope && !actor.ignoreInstanceAdmin && !actor.authorizingUserId && actor.source !== "mcp_oauth" && (actor.source === "local_implicit" || actor.isInstanceAdmin === true);
    const runCandidates = page("runs", await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(desc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id)).limit(LIMIT + 1));
    const nativeRunDecisions = await getHeartbeatRunReadDecisions(db, access, actor, runCandidates);
    const runRows: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (const [index, row] of runCandidates.entries()) {
      if (!nativeRunDecisions[index]) continue;
      const context = object(row.contextSnapshot);
      const refs = [...new Set([row.issueId, row.nativeIssueId, string(context.issueId), string(context.sourceIssueId)].filter((id): id is string => !!id))];
      if (refs.length ? (await Promise.all(refs.map(id => readableIssue(db, companyId, id, actor)))).every(Boolean) : fullFinance && (await access.decide({ actor, action: "agent:read", resource: { type: "agent", companyId, agentId: row.agentId } })).allowed) runRows.push(row);
    }
    const runIds = runRows.map(row => row.id);
    const reservations = runIds.length ? await db.select().from(budgetReservations).where(and(eq(budgetReservations.companyId, companyId), inArray(budgetReservations.runId, runIds), eq(budgetReservations.state, "held"))).limit(LIMIT + 1) : [];
    if (reservations.length > LIMIT) truncated.push("reservations");
    const receipts = runIds.length ? await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), inArray(costEvents.heartbeatRunId, runIds))).orderBy(desc(costEvents.occurredAt), asc(costEvents.id)).limit(LIMIT + 1) : [];
    if (receipts.length > LIMIT) truncated.push("cost receipts");
    const finalizations = runIds.length ? await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(nativeRunFinalizations.runId, runIds))).limit(LIMIT + 1) : [];
    const runs: GovernanceOperationsRun[] = runRows.map(row => {
      const receipt = receipts.find(item => item.heartbeatRunId === row.id), held = reservations.find(item => item.runId === row.id), recovery = finalizations.find(item => item.runId === row.id && item.resultId === null);
      const usage = object(row.usageJson), projection = object(usage.budgetExposure);
      let liveObservedCents: string | null = null;
      if (!row.costAccountedAt) {
        if (typeof projection.sourceId === "string" && typeof projection.sequence === "number") {
          if (typeof projection.costCents === "string" || typeof projection.costCents === "number") {
            try { liveObservedCents = normalizeCents(String(projection.costCents)); }
            catch { liveObservedCents = null; }
          }
        } else liveObservedCents = knownRunCostCents(usage);
      }
      const runReceipts = receipts.slice(0, LIMIT).filter(item => item.heartbeatRunId === row.id);
      const settledCents = row.costAccountedAt && runReceipts.length && receipts.length <= LIMIT
        ? addCents(...runReceipts.map(item => String(item.costCents))) : null;
      const unknown = row.status === "unknown" || row.livenessState === "unknown" || (row.status === "running" && row.runtimeMode === "legacy" && !!row.controllerLeaseExpiresAt && row.controllerLeaseExpiresAt <= now) || (!!recovery && recovery.phase !== "terminal_failure");
      const operationalState = unknown ? "unknown" : row.status === "running" ? "running" : row.status === "queued" ? "queued" : row.status === "scheduled_retry" ? "parked" : "settled";
      return { id: row.id, agentId: row.agentId, issueId: row.issueId ?? row.nativeIssueId ?? string(object(row.contextSnapshot).issueId), status: row.status,
        operationalState, reason: unknown ? "Execution or receipt reconciliation is incomplete; capacity is not proven free" : row.scheduledRetryReason ?? row.errorCode ?? row.status,
        ageSeconds: age(now, row.updatedAt), effectiveProvider: receipt?.provider ?? null, effectiveModel: receipt?.model ?? null, providerIdentitySource: receipt ? "receipt" : "unknown",
        heldCents: held?.amountCents ?? null, liveObservedCents, settledCents,
        unpriced: runReceipts.some(item => item.costStatus === "unpriced") || (row.costAccountingPending && !row.costAccountedAt && liveObservedCents === null), recoveryPhase: recovery?.phase ?? null,
        runtimeMode: row.runtimeMode === "native" ? "native" : "legacy", errorCode: row.errorCode, startedAt: iso(row.startedAt), scheduledRetryAt: iso(row.scheduledRetryAt), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), costAccountingPending: row.costAccountingPending, costAccountedAt: iso(row.costAccountedAt) };
    });
    const issueViews: GovernanceOperationsReadModel["issues"] = [];
    for (const row of visibleIssues) {
      const reasons: string[] = [];
      if (["blocked", "done", "cancelled", "backlog"].includes(row.status)) reasons.push(`Task status: ${row.status}`);
      const readiness = await issueService(db).getDependencyReadiness(row.id);
      if (!readiness.isDependencyReady) reasons.push("Unresolved predecessor; cancelled predecessors are not successful completion");
      if (await issueTreeControlService(db).getActivePauseHoldGate(companyId, row.id)) reasons.push("Active execution pause");
      const blocker = await getExecutionBlocker(db, companyId, row.id);
      if (blocker) reasons.push("Execution reconciliation required");
      const planning = await getIssuePlanningGate(db, companyId, row.id, now);
      if (!planning.eligible) reasons.push(planning.reason === "earliest_start" ? `Earliest start: ${planning.earliestStart}` : "Planning readiness unknown");
      const state = parseIssueExecutionState(row.executionState);
      const participant = state?.currentParticipant;
      const reviewParticipant = row.status === "in_review" && participant ? participant.type === "agent" ? `agent:${participant.agentId}` : "Human review decision" : null;
      if (reviewParticipant) reasons.push("Waiting for current authorized reviewer; execution completion is not acceptance");
      const active = runs.filter(run => run.issueId === row.id && run.operationalState !== "settled");
      const missingExecution = !!row.executionRunId && !runRows.some(run => run.id === row.executionRunId);
      if (missingExecution) reasons.push("Execution ownership exists outside this bounded run snapshot; capacity is unknown");
      if (!active.length && !reasons.length) reasons.push("No native queued or running execution is proven in this snapshot; current native admission is still required");
      issueViews.push({ id: row.id, identifier: row.identifier, title: row.title, status: row.status, priority: row.priority, assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId, projectId: row.projectId, updatedAt: row.updatedAt.toISOString(), admissionState: missingExecution || active.some(run => run.operationalState === "unknown") ? "unknown" : active.some(run => run.operationalState === "running") ? "running" : active.some(run => run.operationalState === "queued") ? "queued" : "parked", reasons: reasons.length ? reasons : ["No visible hard hold; dispatch still requires current native admission"], ageSeconds: age(now, row.updatedAt), reviewParticipant });
    }
    const routineCandidates = page("routines", await db.select().from(routines).where(eq(routines.companyId, companyId)).orderBy(desc(routines.updatedAt), asc(routines.id)).limit(LIMIT + 1));
    const routineRows: Array<typeof routines.$inferSelect> = [];
    for (const row of routineCandidates) if ((!row.parentIssueId || await readableIssue(db, companyId, row.parentIssueId, actor)) && (!row.projectId || await readableProject(db, companyId, row.projectId, actor)) && (!row.caseId || await canActorReadCase(db, actor, { companyId, id: row.caseId }))) routineRows.push(row);
    const routineIds = routineRows.map(row => row.id);
    const triggers = routineIds.length ? await db.select().from(routineTriggers).where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds))).orderBy(asc(routineTriggers.nextRunAt)).limit(LIMIT + 1) : [];
    if (triggers.length > LIMIT) truncated.push("routine triggers");
    const occurrenceCandidates = routineIds.length ? page("occurrences", await db.select().from(routineOccurrences).where(and(eq(routineOccurrences.companyId, companyId), inArray(routineOccurrences.routineId, routineIds))).orderBy(desc(routineOccurrences.scheduledAt), asc(routineOccurrences.id)).limit(LIMIT + 1)) : [];
    const occurrenceRows: OccurrenceRow[] = [];
    for (const row of occurrenceCandidates) if (await occurrenceAccess(db, companyId, row, actor)) occurrenceRows.push(row);
    const occurrenceIds = occurrenceRows.map(row => row.id);
    const exceptions = occurrenceIds.length ? page("exceptions", await db.select().from(governanceOperationExceptions).where(and(eq(governanceOperationExceptions.companyId, companyId), inArray(governanceOperationExceptions.occurrenceId, occurrenceIds))).orderBy(asc(governanceOperationExceptions.deadlineAt)).limit(LIMIT + 1)) : [];
    const exceptionIds = exceptions.map(row => row.id);
    const events = exceptionIds.length ? await db.select().from(governanceOperationExceptionEvents).where(and(eq(governanceOperationExceptionEvents.companyId, companyId), inArray(governanceOperationExceptionEvents.exceptionId, exceptionIds))).orderBy(desc(governanceOperationExceptionEvents.createdAt)).limit(LIMIT + 1) : [];
    if (events.length > LIMIT) truncated.push("exception history");
    const escalations = exceptionIds.length ? await db.select().from(governanceOperationExceptionEscalations).where(inArray(governanceOperationExceptionEscalations.exceptionId, exceptionIds)).limit(LIMIT) : [];
    const ownerRows = page("owner options", await db.select({ id: authUsers.id, name: authUsers.name }).from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"))).orderBy(asc(authUsers.name), asc(authUsers.id)).limit(LIMIT + 1));
    const exceptionOwnerIds = [...new Set(exceptions.map(row => row.ownerUserId))];
    const exceptionOwners = exceptionOwnerIds.length ? await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, exceptionOwnerIds)).limit(LIMIT) : [];
    const exceptionViews = new Map<string, GovernanceOperationException>();
    for (const row of exceptions) {
      const escalation = escalations.find(item => item.exceptionId === row.id);
      const escalationVisible = escalation && await readableIssue(db, companyId, escalation.taskIssueId, actor);
      const occurrence = occurrenceRows.find(item => item.id === row.occurrenceId)!;
      const history = events.slice(0, LIMIT).filter(item => item.exceptionId === row.id).map(item => ({ id: item.id, kind: item.kind as GovernanceOperationException["events"][number]["kind"], actorUserId: item.actorUserId, reason: item.reason, details: item.kind === "escalated" && !escalationVisible ? { generation: 1 } : item.details, createdAt: item.createdAt.toISOString() }));
      const stoppedAt = row.resolvedAt ?? row.clockPausedAt ?? now;
      const activeAgeSeconds = Math.max(0, Math.floor((stoppedAt.getTime() - row.admittedAt.getTime() - row.clockPausedTotalMs) / 1000));
      exceptionViews.set(row.occurrenceId, {
        id: row.id, occurrenceId: row.occurrenceId, taskIssueId: occurrence.taskId,
        reason: row.reason, ownerUserId: row.ownerUserId,
        ownerName: exceptionOwners.find(owner => owner.id === row.ownerUserId)?.name ?? "Owner account unavailable",
        receivedAt: row.receivedAt.toISOString(), admittedAt: row.admittedAt.toISOString(), receivedAgeSeconds: age(now, row.receivedAt), activeAgeSeconds,
        deadlineAt: row.deadlineAt.toISOString(), clockPausedAt: iso(row.clockPausedAt), pauseReason: row.pauseReason,
        lastResumedAt: iso(row.lastResumedAt), state: row.state as "open" | "resolved", resolvedAt: iso(row.resolvedAt), resolutionNote: row.resolutionNote,
        escalationGeneration: row.escalationGeneration, escalatedAt: iso(row.escalatedAt), escalationIssueId: escalationVisible ? escalation!.taskIssueId : null,
        escalationRetryAt: iso(row.escalationRetryAt), escalationBlockReason: row.escalationBlockReason, revision: row.revision, events: history,
      });
    }
    const caseCandidates = await filterCasesForActor(db, actor, page("cases", await db.select().from(cases).where(and(eq(cases.companyId, companyId), await caseReadSqlCondition(db, actor))).orderBy(desc(cases.updatedAt), asc(cases.id)).limit(LIMIT + 1)));
    const caseRows: Array<typeof cases.$inferSelect> = [];
    for (const row of caseCandidates) if ((!row.projectId || await readableProject(db, companyId, row.projectId, actor)) && (!row.workIssueId || await readableIssue(db, companyId, row.workIssueId, actor))) caseRows.push(row);
    const recoveryCandidates = page("recoveries", await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.status, ["active", "escalated"]))).orderBy(desc(issueRecoveryActions.updatedAt)).limit(LIMIT + 1));
    const recoveries: GovernanceOperationsReadModel["recoveries"] = [];
    for (const row of recoveryCandidates) if (await readableIssue(db, companyId, row.sourceIssueId, actor)) { const task = visibleIssues.find(item => item.id === row.sourceIssueId); recoveries.push({ id: row.id, issueId: row.sourceIssueId, issueIdentifier: task?.identifier ?? null, issueTitle: task?.title ?? "Authorized task", cause: row.cause, status: row.status, updatedAt: row.updatedAt.toISOString() }); }
    const milestoneCandidates = page("milestones", await db.select().from(governanceMilestones).where(eq(governanceMilestones.companyId, companyId)).orderBy(desc(governanceMilestones.updatedAt)).limit(LIMIT + 1));
    const milestones: GovernanceOperationsReadModel["milestones"] = [];
    for (const row of milestoneCandidates) if (await readableIssue(db, companyId, row.issueId, actor) && await canActorReadCase(db, actor, { companyId, id: row.caseId })) {
      const [revision] = await db.select().from(governanceMilestoneRevisions).where(and(eq(governanceMilestoneRevisions.companyId, companyId), eq(governanceMilestoneRevisions.milestoneId, row.id))).orderBy(desc(governanceMilestoneRevisions.revision)).limit(1);
      const task = visibleIssues.find(item => item.id === row.issueId); milestones.push({ id: row.id, caseId: row.caseId, issueId: row.issueId, issueIdentifier: task?.identifier ?? null, issueTitle: task?.title ?? "Authorized milestone task", revision: revision?.revision ?? null, revisionState: revision?.state ?? null, updatedAt: row.updatedAt.toISOString() });
    }
    const queues: GovernanceOperationsReadModel["decisionQueues"] = [];
    if ((await access.decide({ actor, action: "decision_queue:read", resource: { type: "company", companyId } })).allowed) {
      const queueRows = page("decision queues", await db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId)).orderBy(desc(decisionQueues.updatedAt)).limit(LIMIT + 1));
      for (const queue of queueRows) {
        const candidates = page("decision items", await db.select().from(decisionQueueItems).where(and(eq(decisionQueueItems.companyId, companyId), eq(decisionQueueItems.queueId, queue.id))).orderBy(asc(decisionQueueItems.createdAt)).limit(LIMIT + 1));
        const items: GovernanceOperationsReadModel["decisionQueues"][number]["items"] = [];
        for (const row of candidates) if (await canReadDecisionSource(db, actor, companyId, row.sourceKind as AttentionSourceKind, row.sourceId)) items.push({ id: row.id, sourceKind: row.sourceKind, sourceId: row.sourceId, createdAt: row.createdAt.toISOString() });
        if (items.length) queues.push({ id: queue.id, key: queue.key, title: queue.title, itemCount: items.length, items });
      }
    }
    const policies = fullFinance ? page("budgets", await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.metric, "billed_cents"))).orderBy(asc(budgetPolicies.id)).limit(LIMIT + 1)) : [];
    const exposure = await computeObservedSpends(db, policies, now);
    const budgets = policies.map((row, index) => ({ id: row.id, scopeType: row.scopeType, scopeName: row.scopeId, metric: row.metric, windowKind: row.windowKind, amount: row.amount, isActive: row.isActive, hardStopEnabled: row.hardStopEnabled, enforcementPending: row.enforcementVersion > row.enforcementDeliveredVersion, ledgerCents: exposure[index]!.ledgerCents, liveObservedCents: exposure[index]!.liveObservedCents, effectiveHeldCents: exposure[index]!.effectiveHeldCents, pendingTerminalRunCount: exposure[index]!.pendingTerminalRunCount, unpricedEventCount: exposure[index]!.unpricedEventCount, unknownBrowserRunCount: exposure[index]!.unknownBrowserRunCount }));
    let canManageExceptions = false;
    if (actor.type === "board" && actor.userId && !actor.authorizingUserId && actor.source !== "mcp_oauth") { const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active"))).limit(1); canManageExceptions = ["owner", "admin", "member"].includes(member?.membershipRole ?? ""); }
    const activeRuns = runs.filter(run => ["running", "queued", "unknown"].includes(run.operationalState));
    const agentIds = [...new Set(activeRuns.map(run => run.agentId))];
    const agentCandidates = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))).limit(LIMIT) : [];
    const agentDecisions = await Promise.all(agentCandidates.map(row => access.decide({ actor, action: "agent:read", resource: { type: "agent", companyId, agentId: row.id } })));
    const agentRows = agentCandidates.filter((_, index) => agentDecisions[index]?.allowed);
    return { companyId, generatedAt: now.toISOString(), canManageExceptions, clockPolicy: GOVERNANCE_EXCEPTION_CLOCK_POLICY, truncation: { limitPerSource: LIMIT, sources: [...new Set(truncated)], note: "Bounded recent authorized projections; omitted/filtered records are not totals. No hidden counts are returned." }, issues: issueViews, runs,
      routines: routineRows.map(row => { const trigger = triggers.find(item => item.routineId === row.id && item.enabled && !item.archived); return { id: row.id, name: row.title, status: row.status, enabled: !!trigger, nextRunAt: iso(trigger?.nextRunAt ?? null), timezone: trigger?.timezone ?? null }; }),
      cases: caseRows.map(row => ({ id: row.id, title: row.title, status: row.status, projectId: row.projectId, workIssueId: row.workIssueId && issueIds.has(row.workIssueId) ? row.workIssueId : null, updatedAt: row.updatedAt.toISOString() })),
      occurrences: occurrenceRows.map(row => ({ id: row.id, routineId: row.routineId, scheduledAt: row.scheduledAt.toISOString(), disposition: row.disposition, executionState: row.executionState, decisionReason: row.decisionReason, taskId: row.taskId, runId: row.runId, caseId: row.caseId, ownerUserId: row.ownerUserId, exception: exceptionViews.get(row.id) ?? null })), decisionQueues: queues, recoveries, milestones, budgets,
      capacity: {
        visibleActiveRuns: activeRuns.length,
        perAgentActiveRuns: agentRows.map(row => ({ agentId: row.id, agentName: row.name, activeRuns: activeRuns.filter(run => run.agentId === row.id).length })),
        guarantees: [
          "Visible run occupancy is not free-worker capacity; unknown/recovering execution remains occupied or unproven.",
          "Native reservation generation, held/live/settled receipt accounting and recovery-owner fences remain authoritative.",
          "Per-agent start serialization uses native process-local locks; this projection does not claim universal cross-controller slot enforcement.",
          "Provider pooling and effective credential/quota selection remain native preparation decisions. A receipt records observed provider/model, not proof that every custom adapter honors pool admission.",
          "Custom adapters may lack enforceable Stop, isolation, or complete metering; unknown is not zero.",
        ],
      },
      policyNotes: {
        ranking: "Native queues keep their existing priority, readiness, schedule, retry and concurrency ordering. Hard gates exclude work before selection; there is no invented universal governance score.",
        exclusions: [
          "Current private/source/run/key authority, review participant, Stop/cancellation, native lease, budget and execution recovery fences remain required.",
          "Cancelled dependencies are not successful predecessors. Review readiness is not accepted fulfillment.",
          "Decision sources are filtered by native canReadDecisionSource; visible item counts are bounded projections, not raw queue totals.",
        ],
      },
      financialVisibility: fullFinance ? "Native complete-scope billed-cents budget exposure; ledger, live observations and effective holds are separate and must not be summed naively." : "Company-wide budget aggregates withheld: they can reveal private work. Only authorized run-level evidence is shown.",
      ownerOptions: canManageExceptions ? ownerRows : [],
    };
  }
  return { read, admitException, pauseException: (companyId: string, id: string, input: GovernanceOperationExceptionPause, actor: AuthorizationActor, now = new Date()) => transition(companyId, id, input, actor, "paused", now), resumeException: (companyId: string, id: string, input: GovernanceOperationExceptionResume, actor: AuthorizationActor, now = new Date()) => transition(companyId, id, input, actor, "resumed", now), resolveException: (companyId: string, id: string, input: GovernanceOperationExceptionResolve, actor: AuthorizationActor, now = new Date()) => transition(companyId, id, input, actor, "resolved", now), tickExceptions };
}
