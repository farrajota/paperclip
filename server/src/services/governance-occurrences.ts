import { and, desc, eq, inArray, isNotNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, caseDocuments, cases, companyMemberships, issueDocuments, issues, routineOccurrences, routineRuns, routineTriggers } from "@paperclipai/db";
import type {
  RoutineOccurrence,
  RoutineOccurrenceAuditEvent,
  RoutineOccurrenceDispositionRequest,
  RoutineOccurrenceHistoryItem,
  RoutineOccurrencePage,
} from "@paperclipai/shared/governance-occurrences";
import { ROUTINE_OCCURRENCE_CATCHUP_BATCH_LIMIT, ROUTINE_OCCURRENCE_CATCHUP_EXECUTION_LIMIT } from "@paperclipai/shared/governance-occurrences";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { canActorReadCase, caseReadSqlCondition } from "./case-access.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { persistActivity, publishActivity } from "./activity-log.js";

type OccurrenceRow = typeof routineOccurrences.$inferSelect;
const MAX_HISTORY_PAGE_SIZE = 200;

export function routineOccurrenceDeadlineQuery(now: Date): SQL {
  const cutoff = now.toISOString();
  return sql`SELECT min(CASE
    WHEN o.disposition = 'obligation' AND o.execution_state = 'pending'
      THEN greatest(coalesce(o.retry_at, o.created_at), ${cutoff}::timestamptz)
    WHEN o.disposition = 'obligation' AND o.execution_state = 'dispatching'
      THEN greatest(coalesce(o.lease_expires_at, ${cutoff}::timestamptz), ${cutoff}::timestamptz)
    WHEN (o.execution_state IN ('waiting', 'unknown', 'failed', 'cancelled')
        OR (o.execution_state = 'satisfied' AND (o.milestone_id IS NOT NULL OR i.id IS NULL OR i.status <> 'done' OR i.status_version <> o.accepted_task_status_version)))
      AND (o.run_id IS NOT NULL OR EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.company_id = o.company_id
        AND rr.routine_id = o.routine_id AND rr.trigger_id = o.trigger_id AND rr.idempotency_key = 'routine-occurrence:' || o.id::text))
      THEN greatest(o.updated_at + interval '60 seconds', ${cutoff}::timestamptz)
    END) AS next_at
    FROM routine_occurrences o JOIN companies c ON c.id = o.company_id
    LEFT JOIN issues i ON i.id = o.task_id AND i.company_id = o.company_id
    WHERE c.status = 'active' AND o.disposition IN ('obligation', 'satisfied')`;
}

export async function canActorReadRoutineWorkflow(db: Db, actor: AuthorizationActor, companyId: string, documentId: string): Promise<boolean> {
  const taskLinks = await db.select({ issueId: issueDocuments.issueId }).from(issueDocuments).where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.documentId, documentId)));
  const caseLinks = await db.select({ caseId: caseDocuments.caseId }).from(caseDocuments).where(and(eq(caseDocuments.companyId, companyId), eq(caseDocuments.documentId, documentId)));
  const authorization = authorizationService(db);
  if (!taskLinks.length && !caseLinks.length) return (await authorization.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed;
  const decisions = await authorization.decideReads(actor, taskLinks.map(link => ({ type: "issue" as const, companyId, issueId: link.issueId })));
  if (decisions.some(decision => decision.allowed)) return true;
  for (const link of caseLinks) if (await canActorReadCase(db, actor, { id: link.caseId, companyId })) return true;
  return false;
}

function mapOccurrence(row: OccurrenceRow): RoutineOccurrence {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    triggerId: row.triggerId,
    scheduledAt: row.scheduledAt.toISOString(),
    revisionId: row.revisionId,
    revisionNumber: row.revisionNumber,
    occurrenceKey: row.occurrenceKey,
    disposition: row.disposition as RoutineOccurrence["disposition"],
    executionState: row.executionState as RoutineOccurrence["executionState"],
    decisionReason: row.decisionReason,
    ownerUserId: row.ownerUserId,
    taskId: row.taskId,
    runId: row.runId,
    approvedWorkflowDocumentId: row.approvedWorkflowDocumentId,
    approvedWorkflowRevisionId: row.approvedWorkflowRevisionId,
    milestoneId: row.milestoneId,
    milestoneRevisionId: row.milestoneRevisionId,
    caseId: row.caseId,
    caseHandoffVersion: row.caseHandoffVersion,
    retryAt: row.retryAt?.toISOString() ?? null,
    dispatchAttempts: row.dispatchAttempts,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedTaskStatusVersion: row.acceptedTaskStatusVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cursorFor(row: OccurrenceRow) {
  return Buffer.from(JSON.stringify({ scheduledAt: row.scheduledAt.toISOString(), id: row.id })).toString("base64url");
}

function parseCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { scheduledAt?: unknown; id?: unknown };
    if (typeof parsed.scheduledAt !== "string" || !Number.isFinite(Date.parse(parsed.scheduledAt)) ||
      typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error("Invalid occurrence cursor");
    }
    return { scheduledAt: new Date(parsed.scheduledAt), id: parsed.id };
  } catch {
    throw unprocessable("Invalid routine occurrence cursor");
  }
}

function mapAuditEvent(row: typeof activityLog.$inferSelect): RoutineOccurrenceAuditEvent {
  const details = row.details ?? {};
  return {
    id: row.id,
    action: row.action,
    actorType: (row.actorType === "board" ? "user" : row.actorType) as RoutineOccurrenceAuditEvent["actorType"],
    actorId: row.actorId,
    reason: typeof details.reason === "string" ? details.reason : null,
    ownerUserId: typeof details.ownerUserId === "string" ? details.ownerUserId : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function governanceOccurrenceService(db: Db) {
  const authorization = authorizationService(db);

  async function assertCompanyVisible(companyId: string, actor: AuthorizationActor) {
    const decision = await authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) throw notFound("Routine occurrence not found");
  }

  async function redactPrivateReferences<T extends RoutineOccurrenceHistoryItem | RoutineOccurrence>(
    rows: T[],
    actor: AuthorizationActor,
  ): Promise<T[]> {
    if (!rows.length) return rows;
    const taskIds = [...new Set(rows.map((row) => row.taskId).filter((id): id is string => !!id))];
    const taskRows = taskIds.length
      ? await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
        .where(and(inArray(issues.id, taskIds), eq(issues.companyId, rows[0]!.companyId)))
      : [];
    const taskDecisions = await authorization.decideReads(actor, taskRows.map((task) => ({
      type: "issue" as const,
      companyId: task.companyId,
      issueId: task.id,
    })));
    const readableTasks = new Set(taskRows.filter((_, index) => taskDecisions[index]?.allowed).map((task) => task.id));
    const caseIds = [...new Set(rows.map((row) => row.caseId).filter((id): id is string => !!id))];
    const readableCases = new Set<string>();
    for (const caseId of caseIds) {
      const visible = await canActorReadCase(db, actor, { id: caseId, companyId: rows[0]!.companyId });
      if (visible) readableCases.add(caseId);
    }
    const workflowIds = [...new Set(rows.map(row => row.approvedWorkflowDocumentId).filter((id): id is string => !!id))];
    const readableWorkflows = new Set<string>();
    for (const documentId of workflowIds) if (await canActorReadRoutineWorkflow(db, actor, rows[0]!.companyId, documentId)) readableWorkflows.add(documentId);
    return rows.filter(row => (!row.taskId || readableTasks.has(row.taskId)) && (!row.caseId || readableCases.has(row.caseId)) && (!row.approvedWorkflowDocumentId || readableWorkflows.has(row.approvedWorkflowDocumentId)));
  }

  return {
    listForRoutine: async (
      companyId: string,
      routineId: string,
      actor: AuthorizationActor,
      options: { limit?: number; cursor?: string } = {},
    ): Promise<RoutineOccurrencePage> => {
      await assertCompanyVisible(companyId, actor);
      const limit = Math.max(1, Math.min(MAX_HISTORY_PAGE_SIZE, options.limit ?? 100));
      const cursor = parseCursor(options.cursor);
      const [readableIssue, readableCase] = await Promise.all([issueReadSqlCondition(db, actor), caseReadSqlCondition(db, actor)]);
      const rows = await db.select().from(routineOccurrences).where(and(
        eq(routineOccurrences.companyId, companyId),
        eq(routineOccurrences.routineId, routineId),
        or(sql`${routineOccurrences.taskId} IS NULL`, sql`EXISTS (SELECT 1 FROM ${issues} WHERE ${issues.id} = ${routineOccurrences.taskId} AND ${issues.companyId} = ${routineOccurrences.companyId} AND ${readableIssue})`),
        or(sql`${routineOccurrences.caseId} IS NULL`, sql`EXISTS (SELECT 1 FROM ${cases} WHERE ${cases.id} = ${routineOccurrences.caseId} AND ${cases.companyId} = ${routineOccurrences.companyId} AND ${readableCase})`),
        or(sql`${routineOccurrences.approvedWorkflowDocumentId} IS NULL`, sql`(
          (NOT EXISTS (SELECT 1 FROM ${issueDocuments} WHERE ${issueDocuments.documentId} = ${routineOccurrences.approvedWorkflowDocumentId} AND ${issueDocuments.companyId} = ${routineOccurrences.companyId})
            AND NOT EXISTS (SELECT 1 FROM ${caseDocuments} WHERE ${caseDocuments.documentId} = ${routineOccurrences.approvedWorkflowDocumentId} AND ${caseDocuments.companyId} = ${routineOccurrences.companyId}))
          OR EXISTS (SELECT 1 FROM ${issueDocuments} JOIN ${issues} ON ${issues.id} = ${issueDocuments.issueId} AND ${issues.companyId} = ${issueDocuments.companyId}
            WHERE ${issueDocuments.documentId} = ${routineOccurrences.approvedWorkflowDocumentId} AND ${issueDocuments.companyId} = ${routineOccurrences.companyId} AND ${readableIssue})
          OR EXISTS (SELECT 1 FROM ${caseDocuments} JOIN ${cases} ON ${cases.id} = ${caseDocuments.caseId} AND ${cases.companyId} = ${caseDocuments.companyId}
            WHERE ${caseDocuments.documentId} = ${routineOccurrences.approvedWorkflowDocumentId} AND ${caseDocuments.companyId} = ${routineOccurrences.companyId} AND ${readableCase})
        )`),
        ...(cursor ? [or(
          lt(routineOccurrences.scheduledAt, cursor.scheduledAt),
          and(eq(routineOccurrences.scheduledAt, cursor.scheduledAt), lt(routineOccurrences.id, cursor.id)),
        )!] : []),
      )).orderBy(desc(routineOccurrences.scheduledAt), desc(routineOccurrences.id)).limit(limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const occurrenceIds = pageRows.map((row) => row.id);
      const auditRows = occurrenceIds.length
        ? await db.select().from(activityLog).where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "routine_occurrence"),
          inArray(activityLog.entityId, occurrenceIds),
        )).orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        : [];
      const auditByOccurrence = new Map<string, RoutineOccurrenceAuditEvent[]>();
      for (const row of auditRows) {
        const events = auditByOccurrence.get(row.entityId) ?? [];
        events.push(mapAuditEvent(row));
        auditByOccurrence.set(row.entityId, events);
      }
      const items: RoutineOccurrenceHistoryItem[] = pageRows.map((row) => ({
        ...mapOccurrence(row),
        decisionHistory: auditByOccurrence.get(row.id) ?? [],
      }));
      const visibleItems = await redactPrivateReferences(items, actor);
      const [nextDue] = await db.select({ scheduledAt: routineTriggers.nextRunAt }).from(routineTriggers).where(and(
        eq(routineTriggers.companyId, companyId),
        eq(routineTriggers.routineId, routineId),
        eq(routineTriggers.kind, "schedule"),
        eq(routineTriggers.enabled, true),
        eq(routineTriggers.archived, false),
        eq(routineTriggers.setupPending, false),
        isNotNull(routineTriggers.nextRunAt),
      )).orderBy(routineTriggers.nextRunAt).limit(1);
      const episodes = await db.select({ triggerId: routineTriggers.id, cutoff: routineTriggers.catchUpCutoff, revisionId: routineTriggers.catchUpRevisionId,
        executionsConsumed: routineTriggers.catchUpExecutionsConsumed, latestOnly: routineTriggers.catchUpLatestOnly }).from(routineTriggers).where(and(
          eq(routineTriggers.companyId, companyId), eq(routineTriggers.routineId, routineId), isNotNull(routineTriggers.catchUpCutoff),
        ));
      return {
        items: visibleItems,
        nextCursor: hasMore && pageRows.length ? cursorFor(pageRows.at(-1)!) : null,
        canDecide: actor.type === "board" && !!actor.userId && (await authorization.decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId } })).allowed,
        catchup: {
          batchLimit: ROUTINE_OCCURRENCE_CATCHUP_BATCH_LIMIT,
          hasMoreDue: !!nextDue?.scheduledAt && nextDue.scheduledAt <= new Date(),
          nextScheduledAt: nextDue?.scheduledAt?.toISOString() ?? null,
          executionLimit: ROUTINE_OCCURRENCE_CATCHUP_EXECUTION_LIMIT,
          episodes: episodes.map(episode => ({ ...episode, cutoff: episode.cutoff!.toISOString(), revisionId: episode.revisionId! })),
        },
      };
    },

    get: async (companyId: string, occurrenceId: string, actor: AuthorizationActor) => {
      await assertCompanyVisible(companyId, actor);
      const row = await db.select().from(routineOccurrences).where(and(
        eq(routineOccurrences.companyId, companyId),
        eq(routineOccurrences.id, occurrenceId),
      )).then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [visible] = await redactPrivateReferences([mapOccurrence(row)], actor);
      return visible ?? null;
    },

    setDisposition: async (
      companyId: string,
      occurrenceId: string,
      input: RoutineOccurrenceDispositionRequest,
      actor: AuthorizationActor,
    ) => {
      const actorUserId = actor.userId;
      if (actor.type !== "board" || !actorUserId) throw forbidden("Only a board user may skip or waive a routine obligation");
      await assertCompanyVisible(companyId, actor);
      const committed = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const [locked] = await tx.select().from(routineOccurrences).where(and(
          eq(routineOccurrences.companyId, companyId),
          eq(routineOccurrences.id, occurrenceId),
        )).for("update");
        if (!locked) throw notFound("Routine occurrence not found");
        if (locked.taskId && !(await authorizationService(tx).decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: locked.taskId } })).allowed) throw notFound("Routine occurrence not found");
        if (locked.caseId && !(await canActorReadCase(tx, actor, { id: locked.caseId, companyId }))) throw notFound("Routine occurrence not found");
        if (locked.approvedWorkflowDocumentId && !(await canActorReadRoutineWorkflow(tx, actor, companyId, locked.approvedWorkflowDocumentId))) throw notFound("Routine occurrence not found");
        const permission = await authorizationService(tx).decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId, issueId: locked.taskId } });
        if (!permission.allowed) throw forbidden(permission.explanation);
        const ownerUserId = input.ownerUserId ?? actorUserId;
        const [owner] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, ownerUserId),
          eq(companyMemberships.status, "active"),
        )).limit(1).for("share");
        if (!owner) throw unprocessable("Occurrence owner must have active membership in this company");
        if (locked.disposition !== "obligation" || locked.executionState === "satisfied" || locked.acceptedAt) {
          throw unprocessable("Accepted or already disposed routine obligations cannot be changed");
        }
        if (locked.executionState === "unknown" && input.disposition !== "waived") {
          throw unprocessable("An uncertain execution may only be explicitly waived after review");
        }
        if (locked.executionState === "dispatching") {
          throw unprocessable("A dispatch lease is active or uncertain and cannot be disposed");
        }
        let linkedTaskId = locked.taskId;
        if (!linkedTaskId && locked.runId) {
          const [receipt] = await tx.select({ linkedIssueId: routineRuns.linkedIssueId }).from(routineRuns).where(and(
            eq(routineRuns.id, locked.runId),
            eq(routineRuns.companyId, companyId),
            eq(routineRuns.routineId, locked.routineId),
          )).limit(1);
          linkedTaskId = receipt?.linkedIssueId ?? null;
        }
        if (linkedTaskId && locked.executionState !== "unknown") {
          const [task] = await tx.select({ status: issues.status }).from(issues).where(and(
            eq(issues.id, linkedTaskId),
            eq(issues.companyId, companyId),
          )).limit(1);
          if (task && !["done", "cancelled", "blocked"].includes(task.status)) {
            throw unprocessable("A linked native task may still be executing; review its current task state before disposition");
          }
        }
        const [updated] = await tx.update(routineOccurrences).set({
          disposition: input.disposition,
          executionState: locked.executionState === "unknown" ? "unknown" : "skipped",
          decisionReason: input.reason,
          ownerUserId,
          leaseOwner: null,
          leaseExpiresAt: null,
          retryAt: null,
          acceptedAt: null,
          acceptedTaskStatusVersion: null,
          updatedAt: new Date(),
        }).where(and(
          eq(routineOccurrences.id, locked.id),
          eq(routineOccurrences.companyId, companyId),
          eq(routineOccurrences.disposition, "obligation"),
          ne(routineOccurrences.executionState, "satisfied"),
        )).returning();
        if (!updated) throw unprocessable("Routine occurrence changed before the disposition was recorded");
        const { publication } = await persistActivity(tx, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: `routine.occurrence_${input.disposition}`,
          entityType: "routine_occurrence",
          entityId: locked.id,
          responsibleUserIdOverride: ownerUserId,
          details: {
            routineId: locked.routineId,
            triggerId: locked.triggerId,
            scheduledAt: locked.scheduledAt.toISOString(),
            occurrenceKey: locked.occurrenceKey,
            revisionId: locked.revisionId,
            reason: input.reason,
            ownerUserId,
          },
        });
        return { row: updated, publication };
      });
      publishActivity(committed.publication);
      const [visible] = await redactPrivateReferences([mapOccurrence(committed.row)], actor);
      return visible!;
    },
  };
}
