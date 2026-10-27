import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, budgetPolicies, budgetReservations, companies, companyMemberships, costEvents, createDb, decisionQueueItems, decisionQueues, heartbeatRuns, issueAccessGrants, issues } from "@paperclipai/db";
import { routines, routineOccurrences } from "@paperclipai/db/schema/routines";
import type { Db } from "@paperclipai/db";
import { governanceOperationExceptions, governanceOperationExceptionEvents, governanceOperationExceptionEscalations } from "@paperclipai/db/schema/governance_operations";
import { governanceOperationsService, governanceExceptionDeadlineQuery } from "../services/governance-operations.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerScheduledWork } from "../services/scheduled-work.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { governanceOperationsRouter } from "../routes/governance-operations.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const postgres = support.supported ? describe : describe.skip;
postgres("governance operations authoritative PostgreSQL lifecycle", () => {
  let temp: EmbeddedPostgresTestDatabase;
  let db: Db;
  const now = new Date("2026-10-26T12:00:00Z");
  beforeAll(async () => { vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce"); temp = await startEmbeddedPostgresTestDatabase("governance-operations-"); db = createDb(temp.connectionString); }, 20_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies, "user" CASCADE`); });
  afterAll(async () => { try { await db?.$client.end(); await temp?.cleanup(); } finally { vi.unstubAllEnvs(); } });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", governanceOperationsRouter(db));
    instance.use(errorHandler);
    return instance;
  }

  async function fixture() {
    const companyId = randomUUID(), owner = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(authUsers).values({ id: owner, name: "Exception owner", email: `${owner}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "Operations", issuePrefix: `T${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, membershipRole: "admin", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Private exception source", status: "blocked", assigneeAgentId: agentId, responsibleUserId: owner });
    const [routine] = await db.insert(routines).values({ companyId, title: "Recurring work", parentIssueId: issueId, responsibleUserId: owner }).returning();
    const [occurrence] = await db.insert(routineOccurrences).values({ companyId, routineId: routine!.id, triggerId: randomUUID(), scheduledAt: now, revisionNumber: 1, occurrenceKey: randomUUID(), executionState: "failed", taskId: issueId }).returning();
    const actor = { type: "board" as const, userId: owner, companyIds: [companyId], source: "session" as const };
    return { companyId, owner, agentId, issueId, occurrence: occurrence!, actor, service: governanceOperationsService(db) };
  }
  async function admitted() {
    const f = await fixture();
    const exception = await f.service.admitException(f.companyId, f.occurrence.id, { reason: "Failed recurring work", ownerUserId: f.owner, deadlineAt: new Date(now.getTime() + 60_000).toISOString() }, f.actor, now);
    return { ...f, exception };
  }

  async function waitForBlocker(waiter: number, blocker: number) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT ${blocker}::int = ANY(pg_blocking_pids(${waiter}::int)) AS waiting`);
      if (row?.waiting) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error(`Expected PostgreSQL backend ${waiter} to wait for ${blocker}`);
  }

  it("arms, removes, shifts and settles the SLA deadline through the existing scheduled monitor queue", async () => {
    const f = await fixture(), liveNow = new Date(), deadline = new Date(liveNow.getTime() + 600_000);
    const exception = await f.service.admitException(f.companyId, f.occurrence.id, { reason: "Native deadline scheduling", ownerUserId: f.owner, deadlineAt: deadline.toISOString() }, f.actor, liveNow);
    type Task = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    let monitor: Task | undefined;
    registerScheduledWork({ register(queue, task) {
      if (queue === DELIVERY_QUEUES.issueMonitors) monitor = task;
      return { ready: Promise.resolve(), wake: () => {} };
    } }, db, { retryMs: 60_000, tickTimers: async () => {}, tickRoutines: async () => {}, governanceOperations: { tickExceptions: () => f.service.tickExceptions(), deadlineQuery: governanceExceptionDeadlineQuery } });
    const run = () => monitor!.run(new AbortController().signal);
    await run(); expect(monitor!.nextRunAt!()).toBe(deadline.getTime());
    await f.service.pauseException(f.companyId, exception.id, { expectedRevision: 1, reason: "Pause native obligation" }, f.actor, liveNow);
    await run(); expect(monitor!.nextRunAt!()).toBeNull();
    const resumedAt = new Date(liveNow.getTime() + 1000);
    await f.service.resumeException(f.companyId, exception.id, { expectedRevision: 2 }, f.actor, resumedAt);
    await run(); expect(monitor!.nextRunAt!()).toBe(deadline.getTime() + 1000);
    await expect(f.service.pauseException(f.companyId, exception.id, { expectedRevision: 3, reason: "Out-of-order clock" }, f.actor, liveNow)).rejects.toMatchObject({ status: 422 });
    await f.service.resolveException(f.companyId, exception.id, { expectedRevision: 3, reason: "Resolved" }, f.actor, resumedAt);
    await run(); expect(monitor!.nextRunAt!()).toBeNull();
  });

  it("retains a concrete deadline retry while company pause blocks internal delivery", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000);
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    expect((await f.service.tickExceptions(due)).delivered).toBe(0);
    const [blocked] = await db.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, f.exception.id));
    expect(blocked!.escalationBlockReason).toBe("Current company authority is unavailable");
    expect(blocked!.escalationRetryAt).toEqual(new Date(due.getTime() + 60_000));
    const [deadline] = await db.execute<{ next_at: Date | string | null }>(governanceExceptionDeadlineQuery(due));
    expect(new Date(deadline!.next_at!).getTime()).toBe(due.getTime() + 60_000);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    expect((await f.service.tickExceptions(new Date(due.getTime() + 60_000))).delivered).toBe(1);
  });

  it.each(["resumed", "still_paused"] as const)("keeps accumulated paused time out of active age and freezes it after %s resolution", async mode => {
    const f = await admitted();
    await f.service.pauseException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Evidence wait" }, f.actor, new Date(now.getTime() + 20_000));
    if (mode === "resumed") await f.service.resumeException(f.companyId, f.exception.id, { expectedRevision: 2 }, f.actor, new Date(now.getTime() + 120_000));
    await f.service.resolveException(f.companyId, f.exception.id, { expectedRevision: mode === "resumed" ? 3 : 2, reason: "No further exception work" }, f.actor, new Date(now.getTime() + 130_000));
    const model = await f.service.read(f.companyId, f.actor, new Date(now.getTime() + 500_000));
    expect(model.occurrences[0]!.exception!.activeAgeSeconds).toBe(mode === "resumed" ? 30 : 20);
  });

  it("lets a current authorized operator resolve, but not resume work for, a departed exception owner", async () => {
    const f = await admitted(), operator = randomUUID();
    await db.insert(authUsers).values({ id: operator, name: "Current operator", email: `${operator}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: operator, membershipRole: "admin", status: "active" });
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, f.owner));
    const actor = { ...f.actor, userId: operator };
    await expect(f.service.pauseException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Cannot delegate to departed owner" }, actor, now)).rejects.toMatchObject({ status: 422 });
    const resolved = await f.service.resolveException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Current operator closes the obligation" }, actor, now);
    expect(resolved.state).toBe("resolved");
    expect((await db.select().from(governanceOperationExceptionEvents).where(and(eq(governanceOperationExceptionEvents.exceptionId, resolved.id), eq(governanceOperationExceptionEvents.kind, "resolved"))))[0]!.actorUserId).toBe(operator);
  });

  it("records receipt and admission atomically and rejects duplicate admission and stale revisions", async () => {
    const f = await admitted();
    const events = await db.select().from(governanceOperationExceptionEvents).where(eq(governanceOperationExceptionEvents.exceptionId, f.exception.id));
    expect(events.map(e => e.kind).sort()).toEqual(["admitted", "received"]);
    await expect(f.service.admitException(f.companyId, f.occurrence.id, { reason: "duplicate", ownerUserId: f.owner, deadlineAt: new Date(now.getTime() + 60_000).toISOString() }, f.actor, now)).rejects.toMatchObject({ status: 409 });
    await f.service.pauseException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Awaiting board evidence" }, f.actor, new Date(now.getTime() + 10_000));
    await expect(f.service.resolveException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Stale resolution" }, f.actor, now)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, f.exception.id)))[0]!.revision).toBe(2);
  });

  it("freezes elapsed clock while paused and shifts deadline by exactly paused duration", async () => {
    const f = await admitted();
    await f.service.pauseException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Evidence wait" }, f.actor, new Date(now.getTime() + 20_000));
    expect((await f.service.tickExceptions(new Date(now.getTime() + 120_000))).delivered).toBe(0);
    const resumed = await f.service.resumeException(f.companyId, f.exception.id, { expectedRevision: 2 }, f.actor, new Date(now.getTime() + 120_000));
    expect(resumed.deadlineAt.toISOString()).toBe(new Date(now.getTime() + 160_000).toISOString());
    expect((await f.service.tickExceptions(new Date(now.getTime() + 159_999))).delivered).toBe(0);
    expect((await f.service.tickExceptions(new Date(now.getTime() + 160_000))).delivered).toBe(1);
  });

  it("does not allow an overdue pause to erase a due escalation", async () => {
    const f = await admitted();
    await expect(f.service.pauseException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Too late" }, f.actor, new Date(now.getTime() + 60_000))).rejects.toMatchObject({ status: 409 });
  });

  it("two controllers and repeated callbacks reuse one native internal task and receipt", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000);
    const other = governanceOperationsService(db);
    const results = await Promise.all([f.service.tickExceptions(due), other.tickExceptions(due)]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect((await other.tickExceptions(due)).delivered).toBe(0);
    const receipts = await db.select().from(governanceOperationExceptionEscalations).where(eq(governanceOperationExceptionEscalations.exceptionId, f.exception.id));
    expect(receipts).toHaveLength(1);
    const [task] = await db.select().from(issues).where(eq(issues.id, receipts[0]!.taskIssueId));
    expect(task).toMatchObject({ assigneeUserId: f.owner, parentId: f.issueId, originKind: "governance_operation_escalation" });
    expect((await db.select().from(governanceOperationExceptionEvents).where(and(eq(governanceOperationExceptionEvents.exceptionId, f.exception.id), eq(governanceOperationExceptionEvents.kind, "escalated"))))).toHaveLength(1);
  });

  it("commits native creation and due SLA delivery without a company/privacy circular wait", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000), idempotencyKey = randomUUID();
    const transaction = db.transaction.bind(db);
    const guardPid = Promise.withResolvers<number>(), creatorPid = Promise.withResolvers<number>();
    const escalationPid = Promise.withResolvers<number>(), releaseGuard = Promise.withResolvers<void>();
    const guard = transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`issue-create:idempotency:${f.companyId}:${idempotencyKey}`}, 0))`);
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      guardPid.resolve(row!.pid);
      await releaseGuard.promise;
    });
    const pending: Promise<unknown>[] = [guard];
    const spy = vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async tx => {
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      escalationPid.resolve(row!.pid);
      return callback(tx);
    }, config));
    try {
      const guardBackend = await guardPid.promise;
      const creation = transaction(async tx => {
        const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        creatorPid.resolve(row!.pid);
        return issueService(db).create(f.companyId, { title: "Concurrent intake", status: "todo", responsibleUserId: f.owner, idempotencyKey }, tx);
      });
      void creation.catch(() => {}); pending.push(creation);
      const creatorBackend = await creatorPid.promise;
      await waitForBlocker(creatorBackend, guardBackend);
      const escalation = f.service.tickExceptions(due);
      void escalation.catch(() => {}); pending.push(escalation);
      await waitForBlocker(await escalationPid.promise, creatorBackend);
      releaseGuard.resolve();
      const [created, delivered] = await Promise.all([creation, escalation]);
      expect(delivered.delivered).toBe(1);
      expect(created.issueNumber).toBe(1);
      const receipts = await db.select().from(governanceOperationExceptionEscalations).where(eq(governanceOperationExceptionEscalations.exceptionId, f.exception.id));
      expect(receipts).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, receipts[0]!.taskIssueId)))[0]).toMatchObject({ issueNumber: 2, visibility: "private", assigneeUserId: f.owner, parentId: f.issueId });
      expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]!.issueCounter).toBe(2);
      expect((await f.service.tickExceptions(due)).delivered).toBe(0);
      expect(await db.select().from(governanceOperationExceptionEvents).where(and(eq(governanceOperationExceptionEvents.exceptionId, f.exception.id), eq(governanceOperationExceptionEvents.kind, "escalated")))).toHaveLength(1);
    } finally { releaseGuard.resolve(); spy.mockRestore(); await Promise.allSettled(pending); }
  });

  it("lets a native privacy mutation finish before escalation locks its source endpoint", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000);
    const transaction = db.transaction.bind(db);
    const sourcePid = Promise.withResolvers<number>(), escalationPid = Promise.withResolvers<number>();
    const allowSourceMutation = Promise.withResolvers<void>();
    const sourceMutation = transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.companyId}`}, 0))`);
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      sourcePid.resolve(row!.pid);
      await allowSourceMutation.promise;
      return issueService(db).update(f.issueId, { visibility: "private", actorUserId: f.owner }, tx);
    });
    void sourceMutation.catch(() => {});
    const pending: Promise<unknown>[] = [sourceMutation];
    const spy = vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async tx => {
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      escalationPid.resolve(row!.pid);
      return callback(tx);
    }, config));
    try {
      const sourceBackend = await sourcePid.promise;
      const escalation = f.service.tickExceptions(due);
      void escalation.catch(() => {}); pending.push(escalation);
      await waitForBlocker(await escalationPid.promise, sourceBackend);
      allowSourceMutation.resolve();
      const [updated, delivered] = await Promise.all([sourceMutation, escalation]);
      expect(updated).toMatchObject({ id: f.issueId, visibility: "private" });
      expect(delivered.delivered).toBe(1);
      const receipts = await db.select().from(governanceOperationExceptionEscalations).where(eq(governanceOperationExceptionEscalations.exceptionId, f.exception.id));
      expect(receipts).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, receipts[0]!.taskIssueId)))[0]).toMatchObject({ visibility: "private", privacyParentIssueId: f.issueId, privacyRootIssueId: f.issueId, assigneeUserId: f.owner });
      expect((await db.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, f.exception.id)))[0]).toMatchObject({ escalationGeneration: 1, revision: 2 });
      expect((await f.service.tickExceptions(due)).delivered).toBe(0);
    } finally { allowSourceMutation.resolve(); spy.mockRestore(); await Promise.allSettled(pending); }
  });

  it("rolls back task creation and receipt together on a crash, then delivers once on replay", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000);
    await db.transaction(async tx => {
      await tx.execute(sql`CREATE FUNCTION fail_operations_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated crash'; END $$`);
      await tx.execute(sql`CREATE TRIGGER fail_operations_receipt BEFORE INSERT ON governance_operation_exception_escalations FOR EACH ROW EXECUTE FUNCTION fail_operations_receipt()`);
    });
    try { await expect(f.service.tickExceptions(due)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "P0001", message: "simulated crash" }) }); }
    finally { await db.execute(sql`DROP TRIGGER fail_operations_receipt ON governance_operation_exception_escalations`); await db.execute(sql`DROP FUNCTION fail_operations_receipt()`); }
    expect(await db.select().from(governanceOperationExceptionEscalations).where(eq(governanceOperationExceptionEscalations.exceptionId, f.exception.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.originId, `${f.exception.id}:1`))).toHaveLength(0);
    expect((await f.service.tickExceptions(due)).delivered).toBe(1);
  });

  it("validates current owner membership and denies service-level agent and private-source mutations", async () => {
    const f = await fixture();
    const input = { reason: "failure", ownerUserId: f.owner, deadlineAt: new Date(now.getTime() + 60_000).toISOString() };
    await expect(f.service.admitException(f.companyId, f.occurrence.id, input, { type: "agent", companyId: f.companyId, agentId: f.agentId }, now)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, f.owner));
    await expect(f.service.admitException(f.companyId, f.occurrence.id, input, f.actor, now)).rejects.toMatchObject({ status: 403 });
  });

  it("defers escalation under revoked ownership and exposes the blocked reason until current authority returns", async () => {
    const f = await admitted(), due = new Date(now.getTime() + 60_000);
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, f.owner));
    expect((await f.service.tickExceptions(due)).delivered).toBe(0);
    const [blocked] = await db.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, f.exception.id));
    expect(blocked!.escalationBlockReason).toContain("membership");
    expect(blocked!.escalationRetryAt).toEqual(new Date(due.getTime() + 60_000));
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, f.owner));
    expect((await f.service.tickExceptions(new Date(due.getTime() + 60_000))).delivered).toBe(1);
  });

  it("rejects an exception transition while its consumed source grant is being revoked, then denies the revoked source", async () => {
    const f = await fixture();
    await db.update(issues).set({ visibility: "private", responsibleUserId: null }).where(eq(issues.id, f.issueId));
    await db.insert(issueAccessGrants).values({ issueId: f.issueId, subjectType: "user", subjectId: f.owner, source: "explicit" });
    const exception = await f.service.admitException(f.companyId, f.occurrence.id, { reason: "Source grant-bound exception", ownerUserId: f.owner, deadlineAt: new Date(now.getTime() + 60_000).toISOString() }, f.actor, now);
    const locked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const revocation = db.transaction(async tx => {
      await tx.update(issueAccessGrants).set({ revokedAt: now }).where(eq(issueAccessGrants.issueId, f.issueId));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try { await expect(f.service.resolveException(f.companyId, exception.id, { expectedRevision: 1, reason: "Competing revoke" }, f.actor, now)).rejects.toMatchObject({ status: 409 }); }
    finally { release.resolve(); await revocation; }
    await expect(f.service.resolveException(f.companyId, exception.id, { expectedRevision: 1, reason: "Revoked source" }, f.actor, now)).rejects.toMatchObject({ status: 404 });
    expect((await db.select().from(governanceOperationExceptions).where(eq(governanceOperationExceptions.id, exception.id)))[0]!.revision).toBe(1);
  });

  it("omits inaccessible source objects and their counts, run identity, exceptions and costs", async () => {
    const f = await admitted();
    const viewer = randomUUID();
    await db.insert(authUsers).values({ id: viewer, name: "Viewer", email: `${viewer}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: viewer, membershipRole: "viewer", status: "active" });
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, scopeKind: "issue", status: "unknown", contextSnapshot: { issueId: f.issueId } });
    const [queue] = await db.insert(decisionQueues).values({ companyId: f.companyId, key: "source-review", title: "Private source review", createdByType: "user", createdByUserId: f.owner }).returning();
    await db.insert(decisionQueueItems).values({ companyId: f.companyId, queueId: queue!.id, sourceKind: "review", sourceId: f.issueId, addedByType: "user", addedByUserId: f.owner });
    const model = await f.service.read(f.companyId, { type: "board", userId: viewer, source: "session", companyIds: [f.companyId] }, now);
    expect(model.issues).toHaveLength(0); expect(model.occurrences).toHaveLength(0); expect(model.runs).toHaveLength(0);
    expect(model.budgets).toHaveLength(0); expect(model.capacity.visibleActiveRuns).toBe(0);
    expect(model.decisionQueues).toHaveLength(0);
    expect(JSON.stringify(model)).not.toContain(f.issueId);
    await db.insert(issueAccessGrants).values({ issueId: f.issueId, subjectType: "user", subjectId: viewer, source: "explicit" });
    expect((await f.service.read(f.companyId, { type: "board", userId: viewer, source: "session", companyIds: [f.companyId] }, now)).occurrences).toHaveLength(1);
    expect((await f.service.read(f.companyId, { type: "board", userId: viewer, source: "session", companyIds: [f.companyId] }, now)).decisionQueues[0]!.items[0]!.sourceKind).toBe("review");
  });

  it("routes validate payloads, enforce real human membership, hide private sources and reject stale CAS", async () => {
    const f = await fixture(), root = `/api/companies/${f.companyId}/governance-operations`;
    const http = request(app(f.actor));
    await http.post(`${root}/occurrences/${f.occurrence.id}/exceptions`).send({ reason: "failure", ownerUserId: f.owner, deadlineAt: "invalid" }).expect(400);
    const admitted = await http.post(`${root}/occurrences/${f.occurrence.id}/exceptions`).send({ reason: "failure", ownerUserId: f.owner, deadlineAt: new Date(Date.now() + 3600_000).toISOString() }).expect(201);
    await http.post(`${root}/exceptions/${admitted.body.id}/pause`).send({ expectedRevision: 1, reason: "Evidence wait" }).expect(200);
    await http.post(`${root}/exceptions/${admitted.body.id}/resume`).send({ expectedRevision: 1 }).expect(409);
    await request(app({ type: "agent", agentId: f.agentId, companyId: f.companyId, source: "agent_key" })).post(`${root}/exceptions/${admitted.body.id}/resolve`).send({ expectedRevision: 2, reason: "Agent cannot change human exception clock" }).expect(403);
    await request(app({ type: "board", userId: randomUUID(), source: "session", companyIds: [] })).get(root).expect(403);
    await request(app({ type: "agent", agentId: f.agentId, companyId: f.companyId, source: "agent_key", keyId: randomUUID(), keyScope: { kind: "task_bridge", parentIssueId: f.issueId } })).get(root).expect(404);
    const model = await http.get(root).expect(200);
    expect(model.body.occurrences[0].exception.revision).toBe(2);
    expect(model.body.canManageExceptions).toBe(true);
  });

  it("reuses native exposure without double counting held/live costs or treating unknown workers as free", async () => {
    const f = await fixture(), liveRun = randomUUID(), settledRun = randomUUID();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, metric: "billed_cents", windowKind: "lifetime", amount: 1000 });
    await db.insert(heartbeatRuns).values([
      { id: liveRun, companyId: f.companyId, agentId: f.agentId, scopeKind: "issue", issueId: f.issueId, status: "unknown", costAccountingPending: true, usageJson: { costUsd: 0.5 }, contextSnapshot: { issueId: f.issueId } },
      { id: settledRun, companyId: f.companyId, agentId: f.agentId, scopeKind: "issue", issueId: f.issueId, status: "succeeded", costAccountedAt: now, contextSnapshot: { issueId: f.issueId } },
    ]);
    await db.insert(budgetReservations).values({ companyId: f.companyId, agentId: f.agentId, runId: liveRun, amountCents: "60", state: "held" });
    await db.insert(costEvents).values([
      { companyId: f.companyId, agentId: f.agentId, heartbeatRunId: settledRun, issueId: f.issueId, provider: "receipt-provider", model: "receipt-model", costCents: 25, occurredAt: now },
      { companyId: f.companyId, agentId: f.agentId, heartbeatRunId: liveRun, issueId: f.issueId, provider: "receipt-provider", model: "receipt-model", costCents: 0, costStatus: "unpriced", occurredAt: now },
    ]);
    const model = await f.service.read(f.companyId, { ...f.actor, source: "local_implicit", isInstanceAdmin: true }, now);
    const budget = model.budgets[0]!;
    expect(budget.unpricedEventCount).toBe(1);
    expect(Number(budget.ledgerCents)).toBe(25);
    expect(Number(budget.liveObservedCents)).toBe(50);
    expect(Number(budget.effectiveHeldCents)).toBe(60);
    const live = model.runs.find(run => run.id === liveRun)!;
    const settled = model.runs.find(run => run.id === settledRun)!;
    expect(live).toMatchObject({ operationalState: "unknown", unpriced: true, settledCents: null });
    expect(Number(live.liveObservedCents)).toBe(50);
    expect(settled).toMatchObject({ operationalState: "settled", effectiveProvider: "receipt-provider", providerIdentitySource: "receipt" });
    expect(Number(settled.settledCents)).toBe(25);
    expect(model.capacity.visibleActiveRuns).toBe(1);
  });

  it("resolution stops escalation and survives callback replay without altering native occurrence acceptance", async () => {
    const f = await admitted();
    await f.service.resolveException(f.companyId, f.exception.id, { expectedRevision: 1, reason: "Human accepted disposition" }, f.actor, now);
    expect((await f.service.tickExceptions(new Date(now.getTime() + 120_000))).delivered).toBe(0);
    expect((await db.select().from(routineOccurrences).where(eq(routineOccurrences.id, f.occurrence.id)))[0]!.executionState).toBe("failed");
  });
});
