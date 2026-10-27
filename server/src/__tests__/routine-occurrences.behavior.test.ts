import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  createDb,
  companyMemberships,
  agentWakeupRequests,
  agentApiKeys,
  cases,
  caseHandoffs,
  caseDocuments,
  caseAccessSources,
  documents,
  documentRevisions,
  type Db,
  issueDocuments,
  heartbeatRuns,
  issues,
  projects,
  routineOccurrences,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { routineOccurrenceIdentity } from "@paperclipai/shared/governance-occurrences";
import { routineService } from "../services/routines.js";
import { routineRoutes } from "../routes/routines.js";
import { governanceMilestoneRoutes } from "../routes/governance-milestones.js";
import { errorHandler } from "../middleware/error-handler.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { governanceMilestoneService } from "../services/governance-milestones.js";
import { routineOccurrenceDeadlineQuery } from "../services/governance-occurrences.js";
import { buildLowTrustSourceTrust } from "../services/source-trust.js";
import { registerScheduledWork } from "../services/scheduled-work.js";
import type { DeliveryWorkTask } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../services/delivery-work-notifications.js";
import type { AuthorizationActor } from "../services/authorization.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type WakeupInput = {
  source?: string;
  triggerDetail?: string;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};
type Wakeup = (agentId: string, input: WakeupInput) => Promise<unknown>;

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("durable routine occurrences", () => {
  let db!: Db;
  let database: EmbeddedPostgresTestDatabase | null = null;
  const ownedUserIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("routine-occurrences-behavior-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    if (ownedUserIds.length) await db.delete(authUsers).where(inArray(authUsers.id, ownedUserIds));
    ownedUserIds.length = 0;
  });

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(wakeup?: Wakeup) {
    const companyId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userCreatedAt = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Occurrence owner", email: `${userId}@occurrences.test`, createdAt: userCreatedAt, updatedAt: userCreatedAt });
    ownedUserIds.push(userId);
    await db.insert(companies).values({
      id: companyId,
      name: "Occurrence fixture",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Occurrence worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ companyId, id: projectId, name: "Occurrence work", status: "in_progress" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });

    let wakeCount = 0;
    const defaultWakeup: Wakeup = async (wakeupAgentId, input) => {
      wakeCount += 1;
      const issueId = typeof input.payload?.issueId === "string"
        ? input.payload.issueId
        : typeof input.contextSnapshot?.issueId === "string"
          ? input.contextSnapshot.issueId
          : null;
      if (!issueId) return null;
      const issue = await db.select({ responsibleUserId: issues.responsibleUserId })
        .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: wakeupAgentId,
        invocationSource: input.source ?? "assignment",
        triggerDetail: input.triggerDetail ?? null,
        status: "queued",
        responsibleUserId: issue?.responsibleUserId ?? userId,
        contextSnapshot: { ...(input.contextSnapshot ?? {}), issueId },
      });
      await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
      await db.insert(agentWakeupRequests).values({ companyId, agentId: wakeupAgentId, source: "assignment", status: "queued", runId, idempotencyKey: input.idempotencyKey });
      return { id: runId };
    };
    const service = (wakeOverride?: Wakeup) => routineService(db, { heartbeat: { wakeup: wakeOverride ?? defaultWakeup } });
    const svc = service(wakeup);
    const routine = await svc.create(companyId, {
      projectId,
      title: "Pinned routine title",
      description: "Run the pinned procedure",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "enqueue_missed_with_cap",
    }, { userId });
    const createdTrigger = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    }, { userId });

    return {
      companyId,
      userId,
      agentId,
      projectId,
      routine,
      trigger: createdTrigger.trigger,
      revision: createdTrigger.revision,
      svc,
      service,
      wakeCount: () => wakeCount,
    };
  }

  function registeredRoutineWork(tickRoutines: () => Promise<unknown>) {
    const tasks = new Map<DeliveryQueue, DeliveryWorkTask>();
    registerScheduledWork({ register: (queue, task) => {
      tasks.set(queue, task);
      return { ready: Promise.resolve(), wake: () => {} };
    } }, db, {
      retryMs: 60_000,
      tickTimers: async () => {},
      tickRoutines,
      governanceOccurrences: { deadlineQuery: routineOccurrenceDeadlineQuery },
    });
    return tasks.get(DELIVERY_QUEUES.routineSchedules)!;
  }

  it("commits original missed instants with one schedule advance and retries from the pinned revision", async () => {
    const fixture = await seed();
    const firstDue = new Date("2026-10-26T08:00:00.000Z");
    const now = new Date("2026-10-26T09:30:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: firstDue }).where(eq(routineTriggers.id, fixture.trigger.id));

    await fixture.svc.tickScheduledTriggers(now);

    const occurrences = await db.select().from(routineOccurrences)
      .where(and(eq(routineOccurrences.companyId, fixture.companyId), eq(routineOccurrences.routineId, fixture.routine.id)))
      .orderBy(routineOccurrences.scheduledAt);
    expect(occurrences.map((row) => row.scheduledAt.toISOString())).toEqual([
      "2026-10-26T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
    expect(occurrences.map((row) => row.occurrenceKey)).toEqual(occurrences.map((row) => routineOccurrenceIdentity({
      companyId: row.companyId,
      routineId: row.routineId,
      triggerId: row.triggerId,
      scheduledAt: row.scheduledAt,
    })));
    expect(occurrences.every((row) => row.revisionId === fixture.revision.id && row.revisionNumber === fixture.revision.revisionNumber)).toBe(true);
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id)))[0]?.nextRunAt)
      .toEqual(new Date("2026-10-26T10:00:00.000Z"));

    const originalOccurrence = occurrences[0]!;
    await fixture.svc.update(fixture.routine.id, {
      title: "Edited after occurrence capture",
      baseRevisionId: fixture.revision.id,
    }, { userId: fixture.userId });
    await db.update(routineOccurrences).set({
      executionState: "failed",
      retryAt: new Date("2026-10-26T09:00:00.000Z"),
    }).where(eq(routineOccurrences.id, originalOccurrence.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T09:31:00.000Z"));

    const persistedRun = await db.select().from(routineRuns).where(eq(routineRuns.idempotencyKey, `routine-occurrence:${originalOccurrence.id}`));
    expect(persistedRun).toHaveLength(1);
    expect(persistedRun[0]).toMatchObject({ routineRevisionId: fixture.revision.id, linkedIssueId: originalOccurrence.taskId });
    const pinnedIssue = persistedRun[0]?.linkedIssueId
      ? await db.select().from(issues).where(eq(issues.id, persistedRun[0].linkedIssueId)).then((rows) => rows[0] ?? null)
      : null;
    expect(pinnedIssue?.title).toBe("Pinned routine title");
  });

  it("allows two controllers to claim one logical occurrence without duplicate native task receipts", async () => {
    const fixture = await seed();
    const due = new Date("2026-10-26T08:00:00.000Z");
    const now = new Date("2026-10-26T08:01:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: due }).where(eq(routineTriggers.id, fixture.trigger.id));

    await Promise.all([
      fixture.svc.tickScheduledTriggers(now),
      fixture.service().tickScheduledTriggers(now),
    ]);

    const occurrences = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id));
    const tasks = await db.select().from(issues).where(and(eq(issues.companyId, fixture.companyId), eq(issues.originId, fixture.routine.id)));
    expect(occurrences).toHaveLength(1);
    expect(runs.filter((run) => run.idempotencyKey === `routine-occurrence:${occurrences[0]!.id}`)).toHaveLength(1);
    expect(tasks).toHaveLength(1);
  });

  it("retains a task and run receipt after a wakeup fails after effect and never blindly repeats it", async () => {
    let calls = 0;
    const fixture = await seed(async (agentId, input) => {
      calls += 1;
      const issueId = typeof input.payload?.issueId === "string" ? input.payload.issueId : null;
      if (issueId) {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: fixture.companyId,
          agentId,
          invocationSource: input.source ?? "assignment",
          triggerDetail: input.triggerDetail ?? null,
          status: "queued",
          responsibleUserId: fixture.userId,
          contextSnapshot: { ...(input.contextSnapshot ?? {}), issueId },
        });
        await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
        await db.insert(agentWakeupRequests).values({ companyId: fixture.companyId, agentId, source: "assignment", status: "queued", runId, idempotencyKey: input.idempotencyKey });
      }
      throw new Error("native wake acknowledgement lost after queue receipt");
    });
    const due = new Date("2026-10-26T08:00:00.000Z");
    const now = new Date("2026-10-26T08:01:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: due }).where(eq(routineTriggers.id, fixture.trigger.id));

    await fixture.svc.tickScheduledTriggers(now);

    const occurrence = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id)).then((rows) => rows[0]!);
    const run = await db.select().from(routineRuns).where(eq(routineRuns.idempotencyKey, `routine-occurrence:${occurrence.id}`)).then((rows) => rows[0]!);
    const task = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!)).then((rows) => rows[0] ?? null);
    expect(occurrence.executionState).toBe("waiting");
    expect(occurrence.taskId).toBe(task?.id);
    expect(task).not.toBeNull();
    expect(run.status).toBe("issue_created");

    await fixture.service(async () => { calls += 1; return null; }).tickScheduledTriggers(new Date("2026-10-26T08:02:00.000Z"));
    expect(calls).toBe(1);
    expect(await db.select().from(issues).where(eq(issues.id, task!.id))).toHaveLength(1);
  });

  it("marks an expired lease without a native run receipt unknown instead of retrying", async () => {
    const fixture = await seed();
    const scheduledAt = new Date("2026-10-26T08:00:00.000Z");
    const occurrenceId = randomUUID();
    await db.insert(routineOccurrences).values({
      id: occurrenceId,
      companyId: fixture.companyId,
      routineId: fixture.routine.id,
      triggerId: fixture.trigger.id,
      scheduledAt,
      revisionId: fixture.revision.id,
      revisionNumber: fixture.revision.revisionNumber,
      occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }),
      executionState: "dispatching",
      leaseOwner: "controller-that-stopped",
      leaseExpiresAt: new Date("2026-10-26T07:59:00.000Z"),
    });

    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00.000Z"));
    const occurrence = await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrenceId)).then((rows) => rows[0]!);
    expect(occurrence.executionState).toBe("unknown");
    expect(occurrence.decisionReason).toMatch(/receipt|uncertain/i);
    expect(fixture.wakeCount()).toBe(0);
    await fixture.service().tickScheduledTriggers(new Date("2026-10-26T08:02:00.000Z"));
    expect(fixture.wakeCount()).toBe(0);
  });
  it("records every skip-missed instant and leaves capped uncovered instants due", async () => {
    const fixture = await seed();
    await db.update(routines).set({ catchUpPolicy: "skip_missed" }).where(eq(routines.id, fixture.routine.id));
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-24T00:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T09:30:00Z"));
    const rows = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id)).orderBy(routineOccurrences.scheduledAt);
    expect(rows).toHaveLength(25);
    expect(rows.every(row => row.disposition === "skipped" && row.executionState === "skipped")).toBe(true);
    expect(rows.at(-1)?.scheduledAt).toEqual(new Date("2026-10-25T00:00:00Z"));
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id)))[0]?.nextRunAt).toEqual(new Date("2026-10-25T01:00:00Z"));
    expect(fixture.wakeCount()).toBe(0);
  });

  it("records paused suppression for each instant without dispatching on resume", async () => {
    const fixture = await seed();
    await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, fixture.projectId));
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T09:30:00Z"));
    const rows = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.disposition === "suppressed" && row.decisionReason === "paused")).toBe(true);
    await db.update(projects).set({ pausedAt: null }).where(eq(projects.id, fixture.projectId));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T09:31:00Z"));
    expect(fixture.wakeCount()).toBe(0);
  });

  it("does not let a stale wake acknowledgement overwrite a replacement fence", async () => {
    const fixture = await seed();
    const svc = fixture.service(async () => {
      await db.update(routineOccurrences).set({ executionState: "unknown", leaseOwner: null, leaseExpiresAt: null, decisionReason: "Operator reconciled expired attempt" }).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
      throw new Error("old attempt returned late");
    });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    const [row] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    expect(row).toMatchObject({ executionState: "unknown", decisionReason: "Operator reconciled expired attempt", leaseOwner: null });
  });

  it("rechecks current project pause before replaying a captured pending intent", async () => {
    const fixture = await seed();
    const scheduledAt = new Date("2026-10-26T08:00:00Z");
    await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt,
      revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }) });
    await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, fixture.projectId));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id)))[0]).toMatchObject({ disposition: "suppressed", executionState: "skipped", decisionReason: "paused" });
    expect(fixture.wakeCount()).toBe(0);
  });
  function http(actor: AuthorizationActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    app.use("/api", routineRoutes(db));
    app.use("/api", governanceMilestoneRoutes(db));
    app.use(errorHandler);
    return request(app);
  }

  it("rolls back trigger advancement when durable occurrence capture fails", async () => {
    const fixture = await seed();
    const due = new Date("2026-10-26T08:00:00Z");
    await db.update(routineTriggers).set({ nextRunAt: due }).where(eq(routineTriggers.id, fixture.trigger.id));
    await db.execute(sql`CREATE FUNCTION occurrence_capture_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled capture crash'; END $$`);
    await db.execute(sql`CREATE TRIGGER occurrence_capture_crash BEFORE INSERT ON routine_occurrences FOR EACH ROW EXECUTE FUNCTION occurrence_capture_crash()`);
    try {
      await expect(fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"))).rejects.toMatchObject({
        cause: { message: "controlled capture crash", code: "P0001" },
      });
      expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id)))[0]?.nextRunAt).toEqual(due);
      expect(await db.select().from(routineOccurrences)).toHaveLength(0);
      expect(await db.select().from(routineRuns)).toHaveLength(0);
      expect(fixture.wakeCount()).toBe(0);
    } finally {
      await db.execute(sql`DROP TRIGGER occurrence_capture_crash ON routine_occurrences`);
      await db.execute(sql`DROP FUNCTION occurrence_capture_crash()`);
    }
  });

  it("recovers a native commit-before-wake without creating another task or receipt", async () => {
    const fixture = await seed();
    const scheduledAt = new Date("2026-10-26T08:00:00Z");
    const occurrenceId = randomUUID(), runId = randomUUID();
    const [task] = await db.insert(issues).values({ companyId: fixture.companyId, projectId: fixture.projectId, title: "Committed pinned task", status: "todo", assigneeAgentId: fixture.agentId,
      responsibleUserId: fixture.userId, originKind: "routine_execution", originId: fixture.routine.id, originRunId: runId }).returning();
    await db.insert(routineRuns).values({ id: runId, companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, source: "schedule", status: "issue_created",
      linkedIssueId: task!.id, routineRevisionId: fixture.revision.id, idempotencyKey: `routine-occurrence:${occurrenceId}` });
    await db.insert(routineOccurrences).values({ id: occurrenceId, companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt,
      revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber, occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }),
      runId, taskId: task!.id, executionState: "dispatching", dispatchAttempts: 1, leaseOwner: "crashed-before-wake", leaseExpiresAt: new Date("2026-10-26T07:59:00Z") });
    await fixture.service().tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrenceId)))[0]).toMatchObject({ taskId: task!.id, runId, executionState: "waiting", dispatchAttempts: 2 });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.originId, fixture.routine.id))).toHaveLength(1);
    expect(fixture.wakeCount()).toBe(1);
  });

  it("attaches once through native case handoff and leaves wake ownership to native delivery", async () => {
    const fixture = await seed();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const board = { type: "board" as const, source: "local_implicit" as const, userId: fixture.userId };
    const [caseRow] = await db.insert(cases).values({ companyId: fixture.companyId, projectId: fixture.projectId, caseNumber: 1, identifier: `${fixture.companyId}-C1`, caseType: "work", title: "Scheduled case" }).returning();
    await fixture.svc.update(fixture.routine.id, { caseId: caseRow!.id }, { userId: fixture.userId, authorizationActor: board });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    const [occurrence] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    expect(occurrence).toMatchObject({ caseId: caseRow!.id, caseHandoffVersion: 0, executionState: "waiting" });
    expect(fixture.wakeCount()).toBe(0);
    const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.issueId, occurrence!.taskId!));
    expect(handoff).toMatchObject({ state: "pending_dispatch", idempotencyKey: `routine-occurrence:${occurrence!.id}:case-handoff` });
    let delivered = 0;
    const delivery = caseHandoffDeliveryService(db, { heartbeat: { wakeup: async (agentId, options) => {
      delivered++;
      const receipt = options.durableCaseHandoffRequest!;
      await db.insert(agentWakeupRequests).values({ id: receipt.wakeupRequestId, companyId: fixture.companyId, agentId, source: "assignment", status: "queued", idempotencyKey: options.idempotencyKey, payload: options.payload }).onConflictDoNothing();
      return { id: receipt.wakeupRequestId };
    } } });
    await delivery.sweepPending();
    await delivery.sweepPending();
    await fixture.service().tickScheduledTriggers(new Date("2026-10-26T08:02:00Z"));
    expect(delivered).toBe(1);
    expect(fixture.wakeCount()).toBe(0);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.issueId, occurrence!.taskId!))).toHaveLength(1);
  });

  it("records skip-if-active separately and never fulfills it with the shared task", async () => {
    const fixture = await seed();
    await db.update(routines).set({ concurrencyPolicy: "skip_if_active" }).where(eq(routines.id, fixture.routine.id));
    await fixture.svc.createTrigger(fixture.routine.id, { kind: "api" }, { userId: fixture.userId });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T09:01:00Z"));
    const rows = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id)).orderBy(routineOccurrences.scheduledAt);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ disposition: "suppressed", executionState: "skipped" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, rows[0]!.taskId!));
    await fixture.svc.reconcileExecutionRunStatuses();
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, rows[1]!.id)))[0]).toMatchObject({ disposition: "suppressed", executionState: "skipped", acceptedAt: null });
  });

  it("passes native source restrictions and validated pagination through real occurrence routes", async () => {
    const fixture = await seed();
    const scheduledAt = new Date("2026-10-26T08:00:00Z");
    const [occurrence] = await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }) }).returning();
    const board: AuthorizationActor = { type: "board", source: "none", userId: fixture.userId, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }] };
    await http(board).get(`/api/routines/${fixture.routine.id}/occurrences?limit=NaN`).expect(400);
    await http(board).get(`/api/routines/${fixture.routine.id}/occurrences?cursor=invalid`).expect(422);
    const page = await http(board).get(`/api/routines/${fixture.routine.id}/occurrences?limit=1`).expect(200);
    expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([occurrence!.id]);
    const [key] = await db.insert(agentApiKeys).values({ companyId: fixture.companyId, agentId: fixture.agentId, name: "Scoped native source", keyHash: randomUUID(), scopeConfig: { kind: "task_bridge", projectId: fixture.projectId } }).returning();
    const source: AuthorizationActor = { type: "agent", source: "agent_key", agentId: fixture.agentId, companyId: fixture.companyId, keyId: key!.id, keyScope: { kind: "task_bridge", projectId: fixture.projectId } };
    await http(source).get(`/api/routines/${fixture.routine.id}/occurrences`).expect(404);
    await http(source).post(`/api/routines/${fixture.routine.id}/run`).send({}).expect(403);
    await http(source).post(`/api/routines/${fixture.routine.id}/occurrences/${occurrence!.id}/disposition`).send({ disposition: "waived", reason: "No source authority" }).expect(403);
    await http(board).post(`/api/routines/${fixture.routine.id}/occurrences/${occurrence!.id}/disposition`).send({ disposition: "waived", reason: "Reviewed explicit exception", ownerUserId: randomUUID() }).expect(422);
    await http(board).post(`/api/routines/${fixture.routine.id}/occurrences/${occurrence!.id}/disposition`).send({ disposition: "waived", reason: "Reviewed explicit exception", ownerUserId: fixture.userId }).expect(200);
    const history = await http(board).get(`/api/routines/${fixture.routine.id}/occurrences`).expect(200);
    expect(history.body.items[0].decisionHistory[0]).toMatchObject({ actorType: "user", actorId: fixture.userId, ownerUserId: fixture.userId, reason: "Reviewed explicit exception" });
  });

  it("hides private execution rows and denies disposition by UUID possession", async () => {
    const fixture = await seed();
    const outsider = randomUUID();
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: outsider, membershipRole: "member", status: "active" });
    const [task] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Private scheduled task", status: "cancelled", visibility: "private", responsibleUserId: fixture.userId, createdByUserId: fixture.userId }).returning();
    const scheduledAt = new Date("2026-10-26T08:00:00Z");
    const [occurrence] = await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      taskId: task!.id, executionState: "cancelled", decisionReason: "Private acceptance information", occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }) }).returning();
    const later = new Date("2026-10-26T09:00:00Z");
    await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: later, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      taskId: task!.id, executionState: "cancelled", occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: later }) });
    const actor: AuthorizationActor = { type: "board", source: "none", userId: outsider, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "member", status: "active" }] };
    const page = await http(actor).get(`/api/routines/${fixture.routine.id}/occurrences?limit=1`).expect(200);
    expect(page.body.items).toEqual([]);
    expect(page.body.nextCursor).toBeNull();
    const older = new Date("2026-10-26T07:00:00Z");
    const [visible] = await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: older, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: older }) }).returning();
    const visiblePage = await http(actor).get(`/api/routines/${fixture.routine.id}/occurrences?limit=1`).expect(200);
    expect(visiblePage.body.items.map((item: { id: string }) => item.id)).toEqual([visible!.id]);
    expect(visiblePage.body.nextCursor).toBeNull();
    await http(actor).post(`/api/routines/${fixture.routine.id}/occurrences/${occurrence!.id}/disposition`).send({ disposition: "waived", reason: "Guessing UUID is not authority" }).expect(404);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]?.disposition).toBe("obligation");
  });
  it("runs an approved bound-case producer before evidence exists and fulfills only its exact accepted revision", async () => {
    const fixture = await seed();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const board: AuthorizationActor = { type: "board", source: "local_implicit", userId: fixture.userId };
    const client = http(board);
    const [task] = await db.insert(issues).values({ companyId: fixture.companyId, projectId: fixture.projectId, title: "Native case producer", status: "todo", assigneeAgentId: fixture.agentId, responsibleUserId: fixture.userId }).returning();
    const [caseRow] = await db.insert(cases).values({ companyId: fixture.companyId, projectId: fixture.projectId, workIssueId: task!.id, caseNumber: 1, identifier: `${fixture.companyId}-C1`, caseType: "work", title: "Milestone producer case" }).returning();
    const [playbook] = await db.insert(documents).values({ companyId: fixture.companyId, title: "Approved producer procedure", latestBody: "Produce then independently accept the deliverable" }).returning();
    const [playbookRevision] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId: playbook!.id, revisionNumber: 1, body: playbook!.latestBody, createdByUserId: fixture.userId }).returning();
    await db.update(documents).set({ latestRevisionId: playbookRevision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, playbook!.id));
    await db.insert(caseDocuments).values({ companyId: fixture.companyId, caseId: caseRow!.id, documentId: playbook!.id, key: "playbook" });
    const milestone = (await client.post(`/api/cases/${caseRow!.id}/milestones`).send({}).expect(201)).body;
    const contract = { title: "Producer acceptance", playbookBinding: { documentId: playbook!.id, documentRevisionId: playbookRevision!.id },
      requiredDeliverables: [{ key: "work", label: "Native task accepted", evidenceKind: "issue_completion", reference: { kind: "task", taskId: task!.id }, maxAgeHours: 168 }],
      executorPolicy: { kind: "any_internal_agent" }, reviewerPolicy: { kind: "board_user" }, followups: [] };
    const revision = (await client.post(`/api/milestones/${milestone.id}/revisions`).send(contract).expect(201)).body;
    await client.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/promote`).send({ expectedActiveRevisionId: null }).expect(200);
    await fixture.svc.update(fixture.routine.id, { caseId: caseRow!.id, milestoneId: milestone.id, approvedWorkflowDocumentId: playbook!.id, approvedWorkflowRevisionId: playbookRevision!.id }, { userId: fixture.userId, authorizationActor: board });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    const [occurrence] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    expect(occurrence).toMatchObject({ taskId: task!.id, disposition: "obligation", executionState: "waiting", milestoneId: milestone.id, milestoneRevisionId: revision.id, approvedWorkflowRevisionId: playbookRevision!.id });
    expect(fixture.wakeCount()).toBe(0);
    const [procedure] = await db.select({ body: documents.latestBody }).from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(eq(issueDocuments.issueId, task!.id), eq(issueDocuments.key, `routine-occurrence-${occurrence!.id}`)));
    expect(procedure?.body).toContain(playbook!.latestBody);
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(1);
    await db.update(routineTriggers).set({ nextRunAt: new Date("2030-01-01T00:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await db.update(issues).set({ status: "done", completedAt: new Date(), updatedAt: new Date(), statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, task!.id));
    await client.post(`/api/milestones/${milestone.id}/evidence`).send({ deliverableKey: "work", evidenceKind: "issue_completion", artifactId: task!.id, expectedRevision: revision.revision, expectedEvidenceVersion: 0 }).expect(201);
    const ready = await governanceMilestoneService(db).getMilestoneReadiness(fixture.companyId, milestone.id);
    expect(ready).toMatchObject({ eligible: true, accepted: false });
    const scheduled = registeredRoutineWork(() => fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:30Z")));
    const beforeReconciliation = Date.now();
    await scheduled.run(new AbortController().signal);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]?.disposition).toBe("obligation");
    expect(scheduled.nextRunAt!()).toBeGreaterThanOrEqual(beforeReconciliation);
    expect(scheduled.nextRunAt!()).toBeLessThanOrEqual(Date.now() + 60_000);
    await client.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send({ outcome: "accept", reason: "Independent human review", expectedRevision: revision.revision, expectedEvidenceVersion: ready.evidenceVersion, expectedEvidenceSnapshotHash: ready.evidenceSnapshotHash }).expect(200);
    await scheduled.run(new AbortController().signal);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]).toMatchObject({ disposition: "satisfied", executionState: "satisfied", acceptedTaskStatusVersion: expect.any(Number) });
    const nextRevision = (await client.post(`/api/milestones/${milestone.id}/revisions`).send(contract).expect(201)).body;
    await client.post(`/api/milestones/${milestone.id}/revisions/${nextRevision.id}/promote`).send({ expectedActiveRevisionId: revision.id }).expect(200);
    await scheduled.run(new AbortController().signal);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]).toMatchObject({ disposition: "obligation", executionState: "waiting", acceptedAt: null, milestoneRevisionId: revision.id });
  });
  it("does not create a native manual run when its real board actor cannot read the private parent", async () => {
    const fixture = await seed();
    const outsider = randomUUID();
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: outsider, membershipRole: "owner", status: "active" });
    const [parent] = await db.insert(issues).values({ companyId: fixture.companyId, projectId: fixture.projectId, title: "Private producer parent", visibility: "private", createdByUserId: fixture.userId }).returning();
    await db.update(routines).set({ parentIssueId: parent!.id }).where(eq(routines.id, fixture.routine.id));
    const actor: AuthorizationActor = { type: "board", source: "none", userId: outsider, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }] };
    await http(actor).post(`/api/routines/${fixture.routine.id}/run`).send({}).expect(404);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(0);
    expect(fixture.wakeCount()).toBe(0);
  });
  it.each(["company", "privacy"] as const)("waits for native %s authority before holding routine/source locks", async authority => {
    const fixture = await seed();
    let unlock!: () => void;
    let signalLocked!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const holder = db.transaction(async tx => {
      if (authority === "company") await tx.execute(sql`select id from ${companies} where ${companies.id} = ${fixture.companyId} for no key update`);
      else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${fixture.companyId}`}, 0))`);
      signalLocked();
      await released;
    });
    await locked;
    const board: AuthorizationActor = { type: "board", source: "local_implicit", userId: fixture.userId };
    const dispatch = http(board).post(`/api/routines/${fixture.routine.id}/run`).send({}).then(response => response);
    try {
      await expect.poll(async () => {
        const blockedQuery = authority === "company" ? "%companies%for no key update%" : "%pg_advisory_xact_lock%";
        const result = await db.execute(sql`select exists (select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like ${blockedQuery}) as waiting`);
        return result[0]?.waiting;
      }).toBe(true);
      await db.transaction(async tx => {
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${fixture.routine.id} for update nowait`);
      });
    } finally {
      unlock();
      await holder;
      await dispatch;
    }
    expect((await dispatch).status).toBe(202);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(1);
  });
  it("retains accepted native completion when obsolete case wake delivery is cancelled", async () => {
    const fixture = await seed();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const board: AuthorizationActor = { type: "board", source: "local_implicit", userId: fixture.userId };
    const [caseRow] = await db.insert(cases).values({ companyId: fixture.companyId, projectId: fixture.projectId, caseNumber: 1, identifier: `${fixture.companyId}-C1`, caseType: "work", title: "Completion before delivery" }).returning();
    await fixture.svc.update(fixture.routine.id, { caseId: caseRow!.id }, { userId: fixture.userId, authorizationActor: board });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    const [occurrence] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    await db.update(issues).set({ status: "done", completedAt: new Date(), updatedAt: new Date(), statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, occurrence!.taskId!));
    let wakes = 0;
    await caseHandoffDeliveryService(db, { heartbeat: { wakeup: async () => { wakes++; throw new Error("A completed task must not be woken"); } } }).sweepPending();
    expect(wakes).toBe(0);
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.issueId, occurrence!.taskId!)))[0]?.state).toBe("cancelled");
    await fixture.svc.reconcileExecutionRunStatuses();
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]).toMatchObject({ disposition: "satisfied", executionState: "satisfied", acceptedTaskStatusVersion: expect.any(Number) });
  });
  it("rejects a same-company playbook UUID when its native private source is unreadable", async () => {
    const fixture = await seed();
    const outsider = randomUUID();
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: outsider, membershipRole: "owner", status: "active" });
    const [source] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Private procedure source", visibility: "private", createdByUserId: fixture.userId }).returning();
    const [document] = await db.insert(documents).values({ companyId: fixture.companyId, title: "Private approved procedure", latestBody: "Private business procedure" }).returning();
    const [revision] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId: document!.id, revisionNumber: 1, body: document!.latestBody }).returning();
    await db.insert(issueDocuments).values({ companyId: fixture.companyId, issueId: source!.id, documentId: document!.id, key: "workflow" });
    const actor: AuthorizationActor = { type: "board", source: "none", userId: outsider, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }] };
    await http(actor).patch(`/api/routines/${fixture.routine.id}`).send({ approvedWorkflowDocumentId: document!.id, approvedWorkflowRevisionId: revision!.id }).expect(404);
    expect((await db.select().from(routines).where(eq(routines.id, fixture.routine.id)))[0]?.approvedWorkflowDocumentId).toBeNull();
  });
  it("restores pending, retry, and lease deadlines independently of the advanced trigger", async () => {
    const fixture = await seed();
    const now = new Date("2026-10-26T08:00:00Z");
    const retry = new Date("2026-10-26T08:05:00Z");
    const lease = new Date("2026-10-26T08:06:00Z");
    await db.update(routineTriggers).set({ nextRunAt: new Date("2027-01-01T00:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    const [occurrence] = await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: now, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      createdAt: now, occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: now }) }).returning();
    const deadline = async (cutoff: Date) => {
      const [row] = await db.execute<{ next_at: Date | string | null }>(routineOccurrenceDeadlineQuery(cutoff));
      return row!.next_at === null ? null : new Date(row!.next_at);
    };
    expect(await deadline(now)).toEqual(now);
    await db.update(routineOccurrences).set({ retryAt: retry }).where(eq(routineOccurrences.id, occurrence!.id));
    expect(await deadline(now)).toEqual(retry);
    await db.update(routineOccurrences).set({ executionState: "dispatching", leaseOwner: "stopped-native-controller", leaseExpiresAt: lease }).where(eq(routineOccurrences.id, occurrence!.id));
    expect(await deadline(now)).toEqual(lease);
    expect(await deadline(new Date("2026-10-26T08:07:00Z"))).toEqual(new Date("2026-10-26T08:07:00Z"));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:07:00Z"));
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]?.executionState).toBe("unknown");
    expect(await deadline(new Date("2026-10-26T08:07:00Z"))).toBeNull();
    expect(fixture.wakeCount()).toBe(0);
  });
  it("repairs a late native receipt link after completion without replaying uncertain effects", async () => {
    const fixture = await seed();
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    const [occurrence] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    await db.update(issues).set({ status: "done", statusVersion: sql`${issues.statusVersion} + 1`, completedAt: new Date(), updatedAt: new Date() }).where(eq(issues.id, occurrence!.taskId!));
    await db.update(routineOccurrences).set({ executionState: "unknown", runId: null, taskId: null }).where(eq(routineOccurrences.id, occurrence!.id));
    await fixture.service().tickScheduledTriggers(new Date("2026-10-26T08:02:00Z"));
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]).toMatchObject({ disposition: "satisfied", executionState: "satisfied", runId: occurrence!.runId, taskId: occurrence!.taskId });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(1);
    expect(fixture.wakeCount()).toBe(1);
  });
  it("recovers persisted pending work through the registered queue after cron has advanced", async () => {
    const fixture = await seed();
    const now = new Date();
    const scheduledAt = new Date(now.getTime() - 60_000);
    const retryAt = new Date(now.getTime() + 300_000);
    const advancedTrigger = new Date("2030-01-01T00:00:00Z");
    await db.update(routineTriggers).set({ nextRunAt: advancedTrigger }).where(eq(routineTriggers.id, fixture.trigger.id));
    const [occurrence] = await db.insert(routineOccurrences).values({
      companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id,
      scheduledAt, revisionId: fixture.revision.id, revisionNumber: fixture.revision.revisionNumber,
      retryAt, occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId,
        routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt }),
    }).returning();
    const scheduled = registeredRoutineWork(() => fixture.svc.tickScheduledTriggers(now));
    await scheduled.run(new AbortController().signal);
    expect(scheduled.nextRunAt!()).toBe(retryAt.getTime());
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toEqual([]);

    await db.update(routineOccurrences).set({ retryAt: now }).where(eq(routineOccurrences.id, occurrence!.id));
    await scheduled.run(new AbortController().signal);
    await scheduled.run(new AbortController().signal);
    const tasks = await db.select().from(issues).where(and(eq(issues.companyId, fixture.companyId), eq(issues.originId, fixture.routine.id)));
    expect(tasks.map(task => task.title)).toEqual(["Pinned routine title"]);
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id));
    expect(runs.map(run => run.idempotencyKey)).toEqual([`routine-occurrence:${occurrence!.id}`]);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, occurrence!.id)))[0]).toMatchObject({
      disposition: "obligation", executionState: "waiting", taskId: tasks[0]!.id, runId: runs[0]!.id,
    });
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id)))[0]?.nextRunAt).toEqual(advancedTrigger);
    expect(fixture.wakeCount()).toBe(1);
  });
  it("keeps unknown native effects unknown while advancing the persisted reconciliation deadline", async () => {
    let calls = 0;
    const fixture = await seed(async () => { calls++; throw new Error("Uncertain wake without receipt"); });
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-26T08:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(new Date("2026-10-26T08:01:00Z"));
    await db.update(routineTriggers).set({ nextRunAt: new Date("2030-01-01T00:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    const [original] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
    expect(original).toMatchObject({ executionState: "unknown", taskId: expect.any(String), runId: expect.any(String) });
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.update(routineOccurrences).set({ updatedAt: new Date(Date.now() - 120_000) }).where(eq(routineOccurrences.id, original!.id));
      const cutoff = new Date();
      await fixture.service().tickScheduledTriggers(cutoff);
      const [deadline] = await db.execute<{ next_at: string | Date }>(routineOccurrenceDeadlineQuery(cutoff));
      expect(new Date(deadline!.next_at).getTime()).toBeGreaterThan(cutoff.getTime());
      expect(new Date(deadline!.next_at).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
      expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, original!.id)))[0]).toMatchObject({ executionState: "unknown", taskId: original!.taskId, runId: original!.runId, dispatchAttempts: original!.dispatchAttempts });
    }
    expect(calls).toBe(1);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(1);
  });

  it("accounts for every instant without resetting an episode execution cap across controllers and definition edits", async () => {
    const fixture = await seed();
    const cutoff = new Date("2026-10-26T09:30:00Z");
    const start = new Date("2026-10-24T00:00:00Z");
    await db.update(routineTriggers).set({ nextRunAt: start }).where(eq(routineTriggers.id, fixture.trigger.id));
    await fixture.svc.tickScheduledTriggers(cutoff);
    const [episode] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id));
    expect(episode).toMatchObject({ catchUpCutoff: cutoff, catchUpExecutionsConsumed: 25, catchUpRevisionId: fixture.revision.id });
    const coverage = await http({ type: "board", source: "local_implicit", userId: fixture.userId }).get(`/api/routines/${fixture.routine.id}/occurrences?limit=1`).expect(200);
    expect(coverage.body.catchup).toMatchObject({ batchLimit: 25, executionLimit: 25, hasMoreDue: true,
      episodes: [{ triggerId: fixture.trigger.id, cutoff: cutoff.toISOString(), revisionId: fixture.revision.id, executionsConsumed: 25, latestOnly: false }] });
    await fixture.svc.update(fixture.routine.id, { title: "Edited during coverage" }, { userId: fixture.userId });
    await fixture.svc.updateTrigger(fixture.trigger.id, { cronExpression: "0 */2 * * *" }, { userId: fixture.userId });
    await Promise.all([fixture.service().tickScheduledTriggers(cutoff), fixture.service().tickScheduledTriggers(cutoff)]);
    await fixture.service().tickScheduledTriggers(cutoff);
    const rows = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id)).orderBy(routineOccurrences.scheduledAt);
    expect(rows).toHaveLength(58);
    expect(rows.map(row => row.scheduledAt.getTime())).toEqual(Array.from({ length: 58 }, (_, index) => start.getTime() + index * 3_600_000));
    expect(rows.every(row => row.revisionId === fixture.revision.id)).toBe(true);
    expect(rows.filter(row => row.disposition === "obligation")).toHaveLength(25);
    expect(rows.slice(25).every(row => row.disposition === "skipped" && row.decisionReason?.includes("execution cap"))).toBe(true);
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id));
    expect(runs).toHaveLength(58);
    expect(runs.filter(row => row.status !== "skipped")).toHaveLength(25);
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, fixture.trigger.id)))[0]).toMatchObject({ catchUpCutoff: null, catchUpExecutionsConsumed: 0, nextRunAt: new Date("2026-10-26T10:00:00Z") });
  });

  it("filters real detail and run history before limits and enforces canonical source authority", async () => {
    const fixture = await seed();
    const outsider = randomUUID();
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: outsider, membershipRole: "member", status: "active" });
    const [privateTask] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Secret parent and run", visibility: "private", createdByUserId: fixture.userId, responsibleUserId: fixture.userId }).returning();
    const [publicTask] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Visible run", status: "done" }).returning();
    const [visibleRun] = await db.insert(routineRuns).values({ companyId: fixture.companyId, routineId: fixture.routine.id, source: "manual", status: "completed", linkedIssueId: publicTask!.id, createdAt: new Date("2026-10-25T00:00:00Z") }).returning();
    await db.insert(routineRuns).values(Array.from({ length: 26 }, () => ({ companyId: fixture.companyId, routineId: fixture.routine.id, source: "manual", status: "failed", linkedIssueId: privateTask!.id, failureReason: "Secret failure", triggerPayload: { secret: "private payload" } })));
    const actor: AuthorizationActor = { type: "board", source: "none", userId: outsider, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "member", status: "active" }] };
    const detail = await http(actor).get(`/api/routines/${fixture.routine.id}`).expect(200);
    expect(detail.body.recentRuns.map((run: { id: string }) => run.id)).toEqual([visibleRun!.id]);
    const history = await http(actor).get(`/api/routines/${fixture.routine.id}/runs?limit=1`).expect(200);
    expect(history.body.map((run: { id: string }) => run.id)).toEqual([visibleRun!.id]);
    expect(JSON.stringify(detail.body)).not.toContain("Secret");
    expect(JSON.stringify(history.body)).not.toContain("private payload");
    const owner: AuthorizationActor = { type: "board", source: "none", userId: fixture.userId, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }] };
    expect((await http(owner).get(`/api/routines/${fixture.routine.id}/runs?limit=1`).expect(200)).body[0].failureReason).toBe("Secret failure");
    await db.update(routines).set({ parentIssueId: privateTask!.id }).where(eq(routines.id, fixture.routine.id));
    await http(actor).get(`/api/routines/${fixture.routine.id}`).expect(404);
    await http(actor).get(`/api/routines/${fixture.routine.id}/runs`).expect(404);
    await http(actor).get(`/api/routines/${fixture.routine.id}/revisions`).expect(404);
    await db.update(routines).set({ parentIssueId: null }).where(eq(routines.id, fixture.routine.id));
    const [key] = await db.insert(agentApiKeys).values({ companyId: fixture.companyId, agentId: fixture.agentId, name: "Scoped source", keyHash: randomUUID(), scopeConfig: { kind: "task_bridge", projectId: fixture.projectId } }).returning();
    const source: AuthorizationActor = { type: "agent", source: "agent_key", agentId: fixture.agentId, companyId: fixture.companyId, keyId: key!.id, keyScope: { kind: "task_bridge", projectId: fixture.projectId } };
    await http(source).get(`/api/routines/${fixture.routine.id}`).expect(404);
    await http(source).get(`/api/routines/${fixture.routine.id}/runs`).expect(404);
  });
  it("filters pinned private revision snapshots before returning history and denies scoped low-trust actors", async () => {
    const fixture = await seed();
    const outsider = randomUUID();
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: outsider, membershipRole: "member", status: "active" });
    const [privateTask] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Historical private source", visibility: "private", createdByUserId: fixture.userId, responsibleUserId: fixture.userId }).returning();
    const historical = await fixture.svc.update(fixture.routine.id, { parentIssueId: privateTask!.id }, { userId: fixture.userId });
    const current = await fixture.svc.update(fixture.routine.id, { parentIssueId: null }, { userId: fixture.userId });
    const actor: AuthorizationActor = { type: "board", source: "none", userId: outsider, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "member", status: "active" }] };

    const revisions = await http(actor).get(`/api/routines/${fixture.routine.id}/revisions`).expect(200);
    expect(revisions.body.map((revision: { id: string }) => revision.id)).toContain(current!.latestRevisionId);
    expect(revisions.body.map((revision: { id: string }) => revision.id)).not.toContain(historical!.latestRevisionId);
    expect(JSON.stringify(revisions.body)).not.toContain("Historical private source");

    const [key] = await db.insert(agentApiKeys).values({ companyId: fixture.companyId, agentId: fixture.agentId, name: "Scoped history source", keyHash: randomUUID(), scopeConfig: { kind: "task_bridge", projectId: fixture.projectId } }).returning();
    const scopedActor: AuthorizationActor = { type: "agent", source: "agent_key", agentId: fixture.agentId, companyId: fixture.companyId, keyId: key!.id, keyScope: { kind: "task_bridge", projectId: fixture.projectId } };
    await http(scopedActor).get(`/api/routines/${fixture.routine.id}/revisions`).expect(404);

    const foreign = await seed();
    const foreignActor: AuthorizationActor = { type: "board", source: "none", userId: foreign.userId, companyIds: [foreign.companyId], memberships: [{ companyId: foreign.companyId, membershipRole: "owner", status: "active" }] };
    const denied = await http(foreignActor).get(`/api/routines/${fixture.routine.id}/revisions`).expect(404);
    const missing = await http(foreignActor).get(`/api/routines/${randomUUID()}/revisions`).expect(404);
    expect(denied.body).toEqual(missing.body);
    expect(JSON.stringify(denied.body)).not.toContain(current!.latestRevisionId);
    expect(JSON.stringify(denied.body)).not.toContain(privateTask!.id);
  });

  it.each((["case_visibility", "case_trust", "workflow_trust"] as const).flatMap(boundary => [false, true].map(scheduled => ({ boundary, scheduled }))))("rechecks $boundary after preflight before native commit (scheduled=$scheduled)", async ({ boundary, scheduled }) => {
    const fixture = await seed();
    const board: AuthorizationActor = { type: "board", source: "none", userId: fixture.userId, companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId, membershipRole: "owner", status: "active" }] };
    const [task] = await db.insert(issues).values({ companyId: fixture.companyId, projectId: fixture.projectId, title: "Existing case task", status: "todo", assigneeAgentId: fixture.agentId, responsibleUserId: fixture.userId }).returning();
    const [source] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Retained source" }).returning();
    const [record] = await db.insert(cases).values({ companyId: fixture.companyId, projectId: fixture.projectId, workIssueId: task!.id, caseNumber: 1, identifier: `${fixture.companyId}-C1`, caseType: "work", title: "Authority race" }).returning();
    await db.insert(caseAccessSources).values({ companyId: fixture.companyId, caseId: record!.id, sourceKind: "issue", sourceId: source!.id });
    const [document] = await db.insert(documents).values({ companyId: fixture.companyId, title: "Approved instructions", latestBody: "Pinned business procedure" }).returning();
    const [revision] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId: document!.id, revisionNumber: 1, body: document!.latestBody }).returning();
    const bound = await fixture.svc.update(fixture.routine.id, { caseId: record!.id, approvedWorkflowDocumentId: document!.id, approvedWorkflowRevisionId: revision!.id }, { userId: fixture.userId, authorizationActor: board });
    const now = new Date();
    await db.update(routineTriggers).set({ nextRunAt: new Date("2030-01-01T00:00:00Z") }).where(eq(routineTriggers.id, fixture.trigger.id));
    if (scheduled) await db.insert(routineOccurrences).values({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id,
      scheduledAt: now, revisionId: bound!.latestRevisionId, revisionNumber: bound!.latestRevisionNumber,
      caseId: record!.id, caseHandoffVersion: record!.handoffVersion, approvedWorkflowDocumentId: document!.id, approvedWorkflowRevisionId: revision!.id,
      occurrenceKey: routineOccurrenceIdentity({ companyId: fixture.companyId, routineId: fixture.routine.id, triggerId: fixture.trigger.id, scheduledAt: now }) });
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select id from ${companies} where ${companies.id} = ${fixture.companyId} for no key update`);
      acquired();
      await unlock;
    });
    await held;
    const dispatch = scheduled ? fixture.svc.tickScheduledTriggers(now).then(() => null) : http(board).post(`/api/routines/${fixture.routine.id}/run`).send({}).then(response => response);
    try {
      await expect.poll(async () => (await db.execute(sql`select exists (select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%companies%for no key update%') as waiting`))[0]?.waiting).toBe(true);
      if (boundary === "case_visibility") await db.update(issues).set({ visibility: "private", createdByUserId: randomUUID(), responsibleUserId: null }).where(eq(issues.id, source!.id));
      else if (boundary === "case_trust") await db.update(issues).set({ sourceTrust: buildLowTrustSourceTrust({ issueId: source!.id }) }).where(eq(issues.id, source!.id));
      else await db.update(documents).set({ sourceTrust: buildLowTrustSourceTrust({ issueId: source!.id }) }).where(eq(documents.id, document!.id));
    } finally {
      release();
      await holder;
    }
    const response = await dispatch;
    if (scheduled) {
      const [occurrence] = await db.select().from(routineOccurrences).where(eq(routineOccurrences.triggerId, fixture.trigger.id));
      expect(occurrence).toMatchObject({ executionState: "unknown", taskId: null, runId: null });
      expect(occurrence!.decisionReason).toMatch(boundary === "case_visibility" ? /Case.*unavailable/ : boundary === "case_trust" ? /Low-trust/ : /quarantined/);
    } else expect(response!.status).toBe(boundary === "case_visibility" ? 404 : 403);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, fixture.routine.id))).toHaveLength(0);
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, task!.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.originId, fixture.routine.id))).toHaveLength(0);
    expect(fixture.wakeCount()).toBe(0);
  });
});
