import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkillTestRuns,
  companySkillVersions,
  companySkills,
  costEvents,
  createDb,
  folders,
  heartbeatRunEvents,
  heartbeatRuns,
  issueOneTimeSchedules,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueOneTimeScheduleService } from "../services/issue-one-time-schedules.ts";
import { issueRoutes } from "../routes/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { StorageService } from "../storage/types.js";

const unusedStorageService = {
  provider: "local",
  putFile: async () => { throw new Error("Schedule API test unexpectedly used object storage"); },
  getObject: async () => { throw new Error("Schedule API test unexpectedly used object storage"); },
  headObject: async () => { throw new Error("Schedule API test unexpectedly used object storage"); },
  deleteObject: async () => { throw new Error("Schedule API test unexpectedly used object storage"); },
} satisfies StorageService;
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NOW = new Date("2026-10-23T00:00:00.000Z");
const DUE_AT = new Date("2026-10-26T13:00:00.000Z");
const REQUEST_TIMESTAMP = "2026-10-26T09:00:00-04:00";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres one-time schedule tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue one-time schedules", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-one-time-schedules-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    // Skill test runs restrict issue/agent/version deletion. Native skill inventory
    // also inserts versions before setting currentVersionId, then creates a root
    // bundled folder with one category level below it.
    await db.delete(companySkillTestRuns);
    await db.delete(issueOneTimeSchedules);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    await db.delete(agentRuntimeState);
    await db.delete(companyMemberships);
    await db.delete(agents);
    // Version deletion sets companySkills.currentVersionId to null; skill-owned
    // rows then cascade with the skill. Folder parentId is RESTRICT, so remove
    // the materialized category children before their bundled root containers.
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(folders).where(isNotNull(folders.parentId));
    await db.delete(folders);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(input: {
    companyStatus?: "active" | "paused";
    agentStatus?: "active" | "paused";
    agentPauseReason?: "operator" | "budget" | null;
    issueStatus?: "backlog" | "todo" | "in_progress" | "done" | "blocked";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Schedule fixture",
      issuePrefix,
      status: input.companyStatus ?? "active",
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Schedule agent",
      role: "engineer",
      status: input.agentStatus ?? "active",
      pauseReason: input.agentPauseReason ?? null,
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Existing scheduled issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId, issuePrefix };
  }

  async function createSchedule(input: { companyId: string; issueId: string }) {
    return issueOneTimeScheduleService(db).create({
      ...input,
      timestamp: REQUEST_TIMESTAMP,
      timeZone: "America/New_York",
      now: NOW,
    });
  }

  async function nativeScheduleWakes(scheduleId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.reason, "issue_one_time_schedule_due"),
          eq(agentWakeupRequests.idempotencyKey, `issue-one-time-schedule:${scheduleId}`),
          eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
        ),
      );
  }

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, unusedStorageService));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, userId = "board-user"): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_jwt" };
  }

  it("persists the entered zone without waking now, then recovers and dispatches one native run after a scheduler restart", async () => {
    const seeded = await seedIssue({ issueStatus: "backlog" });
    const service = issueOneTimeScheduleService(db);
    const schedule = await createSchedule(seeded);

    expect(schedule).toMatchObject({
      issueId: seeded.issueId,
      agentId: seeded.agentId,
      dueAt: DUE_AT,
      timeZone: "America/New_York",
      status: "scheduled",
      wakeupRequestId: null,
      runId: null,
    });
    expect(await nativeScheduleWakes(schedule.id)).toHaveLength(0);
    await expect(createSchedule(seeded)).rejects.toThrow("already has a pending one-time run schedule");

    await Promise.all([
      service.tickDue(DUE_AT),
      issueOneTimeScheduleService(db).tickDue(DUE_AT),
    ]);
    const intents = await nativeScheduleWakes(schedule.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
    });

    const restarted = issueOneTimeScheduleService(db);
    expect(await restarted.get(seeded.companyId, seeded.issueId)).toMatchObject({
      id: schedule.id,
      status: "queued",
      wakeupRequestId: intents[0]!.id,
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(DUE_AT);
    await heartbeat.tickTimers(DUE_AT);
    await heartbeat.drainActiveRunExecutions();

    const dispatches = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seeded.companyId),
          eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intents[0]!.id}`),
        ),
      );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.runId).toBeTruthy();
    const runId = dispatches[0]!.runId!;
    expect(dispatches[0]?.runId).toBe(runId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      agentId: seeded.agentId,
      startedAt: expect.any(Date),
      exitCode: 1,
      signal: null,
      errorCode: "adapter_failed",
      error: "Process exited with code 1",
    });
    expect(await restarted.get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "failed",
      wakeupRequestId: intents[0]!.id,
      runId,
      runStatus: "failed",
      error: "Process exited with code 1",
    });
  });

  it.each([
    { runStatus: "queued", dispatchStatus: "queued", scheduleStatus: "queued", error: null },
    { runStatus: "running", dispatchStatus: "claimed", scheduleStatus: "running", error: null },
    {
      runStatus: "failed",
      dispatchStatus: "failed",
      scheduleStatus: "failed",
      error: "Process exited with code 1",
    },
  ] as const)("projects a persisted $runStatus fixture through the real schedule reader after quiescence", async (projection) => {
    // These database rows are an explicit reader fixture, not a live executor.
    // Drain the real native owner first so no writer can race this projection.
    await heartbeatService(db).drainActiveRunExecutions();
    const seeded = await seedIssue();
    const service = issueOneTimeScheduleService(db);
    const schedule = await createSchedule(seeded);
    await service.tickDue(DUE_AT);

    const intents = await nativeScheduleWakes(schedule.id);
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "queued",
      wakeupRequestId: intent.id,
      runId: null,
      runStatus: null,
      error: null,
    });

    const dispatchId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: dispatchId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: intent.source,
      triggerDetail: intent.triggerDetail,
      reason: intent.reason,
      payload: intent.payload,
      status: projection.dispatchStatus,
      requestedByActorType: "system",
      requestedByActorId: `native-status-wake-dispatch:${intent.id}`,
      runId,
      claimedAt: projection.dispatchStatus === "claimed" ? DUE_AT : null,
      finishedAt: projection.dispatchStatus === "failed" ? DUE_AT : null,
      error: projection.error,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "on_demand",
      status: projection.runStatus,
      startedAt: projection.runStatus === "queued" ? null : DUE_AT,
      finishedAt: projection.runStatus === "failed" ? DUE_AT : null,
      error: projection.error,
      errorCode: projection.runStatus === "failed" ? "adapter_failed" : null,
      exitCode: projection.runStatus === "failed" ? 1 : null,
      runtimeMode: "native",
      wakeupRequestId: dispatchId,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        source: "native_status_decision",
        statusDecisionSource: "native_status_decision",
        nativeStatusWakeIntentId: intent.id,
      },
    });
    await db.update(agentWakeupRequests)
      .set({ status: "coalesced", runId, finishedAt: DUE_AT })
      .where(eq(agentWakeupRequests.id, intent.id));

    expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({
      id: schedule.id,
      status: projection.scheduleStatus,
      wakeupRequestId: intent.id,
      runId,
      runStatus: projection.runStatus,
      error: projection.error,
    });
  });

  it("serializes cancellation against the due tick so only cancellation or one native intent wins", async () => {
    const seeded = await seedIssue();
    const service = issueOneTimeScheduleService(db);
    const schedule = await createSchedule(seeded);

    const outcomes = await Promise.allSettled([
      service.tickDue(DUE_AT),
      service.cancel({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        scheduleId: schedule.id,
        now: DUE_AT,
      }),
    ]);
    expect(outcomes).toHaveLength(2);
    const [persisted] = await db
      .select()
      .from(issueOneTimeSchedules)
      .where(eq(issueOneTimeSchedules.id, schedule.id));
    const intents = await nativeScheduleWakes(schedule.id);
    expect(intents.length).toBe(persisted?.wakeupRequestId ? 1 : 0);
    expect(Boolean(persisted?.cancelledAt)).toBe(!persisted?.wakeupRequestId);
    if (persisted?.wakeupRequestId) {
      expect(outcomes[1]?.status).toBe("rejected");
      const cancellationOutcome = outcomes[1];
      if (cancellationOutcome?.status !== "rejected") {
        throw new Error("Due tick unexpectedly won the cancellation race");
      }
      const cancellationReason: unknown = cancellationOutcome.reason;
      expect(cancellationReason).toBeInstanceOf(Error);
      if (cancellationReason instanceof Error) {
        expect(cancellationReason.message).toContain("already been durably queued");
      }
    } else {
      expect(outcomes[0]?.status).toBe("fulfilled");
      expect(persisted?.cancellationReason).toBe("Cancelled by user");
    }
  });

  it("rejects a due intent if the issue becomes blocked before native admission", async () => {
    const seeded = await seedIssue();
    const service = issueOneTimeScheduleService(db);
    const schedule = await createSchedule(seeded);
    const tick = await service.tickDue(DUE_AT);
    expect(tick.claimed).toBe(1);
    const [intent] = await nativeScheduleWakes(schedule.id);
    expect(intent).toBeDefined();

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, seeded.issueId));
    await heartbeatService(db).tickTimers(DUE_AT);

    const [dispatch] = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seeded.companyId),
          eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intent!.id}`),
        ),
      );
    expect(dispatch).toMatchObject({ status: "skipped", runId: null });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Issue is no longer eligible for a scheduled run",
    });
  });
  it("invalidates the assignee snapshot before a reassigned issue can dispatch", async () => {
    const seeded = await seedIssue();
    const schedule = await createSchedule(seeded);
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId: seeded.companyId,
      name: "Replacement agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.update(issues).set({ assigneeAgentId: replacementAgentId }).where(eq(issues.id, seeded.issueId));

    const result = await issueOneTimeScheduleService(db).tickDue(DUE_AT);
    expect(result.claimed).toBe(0);
    expect(await nativeScheduleWakes(schedule.id)).toHaveLength(0);
    expect(await issueOneTimeScheduleService(db).get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Issue assignee changed after scheduling",
    });
  });

  it("invalidates a terminal issue and removes the schedule when its issue is deleted", async () => {
    const terminal = await seedIssue();
    const terminalSchedule = await createSchedule(terminal);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, terminal.issueId));
    await issueOneTimeScheduleService(db).tickDue(DUE_AT);
    expect(await issueOneTimeScheduleService(db).get(terminal.companyId, terminal.issueId)).toMatchObject({
      id: terminalSchedule.id,
      status: "cancelled",
    });
    expect(await nativeScheduleWakes(terminalSchedule.id)).toHaveLength(0);

    const deleted = await seedIssue();
    const deletedSchedule = await createSchedule(deleted);
    await db.delete(issues).where(eq(issues.id, deleted.issueId));
    expect(await issueOneTimeScheduleService(db).get(deleted.companyId, deleted.issueId)).toBeNull();
    await issueOneTimeScheduleService(db).tickDue(DUE_AT);
    expect(await nativeScheduleWakes(deletedSchedule.id)).toHaveLength(0);
  });

  it("invalidates a due schedule while its company is inactive", async () => {
    const seeded = await seedIssue();
    const schedule = await createSchedule(seeded);
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, seeded.companyId));

    const result = await issueOneTimeScheduleService(db).tickDue(DUE_AT);
    expect(result).toMatchObject({ checked: 1, claimed: 0, invalidated: 1 });
    expect(await nativeScheduleWakes(schedule.id)).toHaveLength(0);
    expect(await issueOneTimeScheduleService(db).get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Company was not active when the scheduled run became due",
    });
  });

  it("publishes committed schedule changes through native activity when paused admission creates no run", async () => {
    const seeded = await seedIssue({ agentStatus: "paused", agentPauseReason: "operator" });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(seeded.companyId, (event) => {
      if (event.type === "activity.logged" && event.payload.action === "issue.one_time_schedule_updated") {
        events.push(event.payload);
      }
    });
    try {
      const schedule = await createSchedule(seeded);
      expect(events).toHaveLength(1);
      const service = issueOneTimeScheduleService(db);
      await service.tickDue(DUE_AT);
      expect(events).toHaveLength(2);
      expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({ status: "queued" });
      await heartbeatService(db).tickTimers(DUE_AT);
      expect(events).toHaveLength(3);
      expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({ status: "failed" });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      expect(events).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
        entityType: "issue", entityId: seeded.issueId, details: expect.objectContaining({ scheduleId: schedule.id }),
      })));
      const persisted = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "issue.one_time_schedule_updated"),
      ));
      expect(persisted).toHaveLength(3);
      const originalIntent = await nativeScheduleWakes(schedule.id);
      expect(originalIntent).toHaveLength(1);
      const deniedDispatches = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, seeded.companyId),
        eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${originalIntent[0]!.id}`),
      ));
      expect(deniedDispatches).toHaveLength(1);
      expect(deniedDispatches[0]).toMatchObject({ status: "skipped", runId: null });
      expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({ status: "failed" });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      await heartbeatService(db).tickTimers(DUE_AT);
      expect(events).toHaveLength(4);
      expect(events).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
        entityType: "issue", entityId: seeded.issueId, details: expect.objectContaining({ scheduleId: schedule.id }),
      })));
      const intents = await nativeScheduleWakes(schedule.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]!.id).toBe(originalIntent[0]!.id);
      expect(intents[0]).toMatchObject({ status: "skipped", runId: null });
      const dispatches = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, seeded.companyId),
        eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intents[0]!.id}`),
      ));
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({ status: "skipped", runId: null });
      expect(await service.get(seeded.companyId, seeded.issueId)).toMatchObject({ status: "failed" });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      const settledActivities = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "issue.one_time_schedule_updated"),
      ));
      expect(settledActivities).toHaveLength(4);
      expect(settledActivities.map((activity) => activity.entityId)).toEqual(Array(4).fill(seeded.issueId));
      await heartbeatService(db).tickTimers(DUE_AT);
      expect(events).toHaveLength(4);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      const quietActivities = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "issue.one_time_schedule_updated"),
      ));
      expect(quietActivities).toHaveLength(4);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ["operator pause", "operator"],
    ["budget hard-stop", "budget"],
  ] as const)("routes due work through native admission when the agent has a %s", async (_label, pauseReason) => {
    const seeded = await seedIssue({ agentStatus: "paused", agentPauseReason: pauseReason });
    const schedule = await createSchedule(seeded);

    await heartbeatService(db).tickTimers(DUE_AT);
    const intents = await nativeScheduleWakes(schedule.id);
    expect(intents).toHaveLength(1);
    const dispatches = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seeded.companyId),
          eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intents[0]!.id}`),
        ),
      );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.status).toBe("skipped");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await issueOneTimeScheduleService(db).get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "failed",
    });
  });

  it("leaves an over-budget issue without a run and exposes the native skipped receipt", async () => {
    const seeded = await seedIssue();
    const schedule = await createSchedule(seeded);
    await db.insert(budgetPolicies).values({
      companyId: seeded.companyId,
      scopeType: "agent",
      scopeId: seeded.agentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      provider: "fixture",
      model: "fixture",
      costCents: 150,
      occurredAt: NOW,
    });

    await heartbeatService(db).tickTimers(DUE_AT);
    const intents = await nativeScheduleWakes(schedule.id);
    expect(intents).toHaveLength(1);
    const dispatches = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seeded.companyId),
          eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intents[0]!.id}`),
        ),
      );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.status).toBe("skipped");
    expect(dispatches[0]?.error).toContain("budget hard-stop");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await issueOneTimeScheduleService(db).get(seeded.companyId, seeded.issueId)).toMatchObject({
      status: "failed",
    });
  });

  it("exposes board-only schedule creation, validates time input, and cancels through the issue API", async () => {
    const seeded = await seedIssue();
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    const app = createApp(boardActor(seeded.companyId));
    const nonmemberRead = await request(createApp(boardActor(seeded.companyId, "other-board-user")))
      .get(`/api/issues/${seeded.issueId}/one-time-schedule`);
    expect(nonmemberRead.status, nonmemberRead.text).toBe(403);
    const invalid = await request(app)
      .post(`/api/issues/${seeded.issueId}/one-time-schedule`)
      .send({ timestamp: "2999-12-31T23:00:00Z", timeZone: "Mars/Olympus" });
    expect(invalid.status, invalid.text).toBe(400);
    expect(invalid.body.error).toContain("Invalid IANA timezone");

    const created = await request(app)
      .post(`/api/issues/${seeded.issueId}/one-time-schedule`)
      .send({ timestamp: "2999-12-31T23:00:00Z", timeZone: "UTC" });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({
      issueId: seeded.issueId,
      agentId: seeded.agentId,
      dueAt: "2999-12-31T23:00:00.000Z",
      timeZone: "UTC",
      status: "scheduled",
      wakeupRequestId: null,
    });
    expect(await request(app).get(`/api/issues/${seeded.issueId}/one-time-schedule`)).toMatchObject({
      status: 200,
      body: { id: created.body.id, status: "scheduled" },
    });

    const cancelled = await request(app).delete(
      `/api/issues/${seeded.issueId}/one-time-schedule/${created.body.id}`,
    );
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancellationReason: "Cancelled by user" });
  });

  it("denies a different agent schedule mutation without creating a schedule or wake", async () => {
    const seeded = await seedIssue();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: seeded.companyId,
      name: "Different agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    const response = await request(createApp(agentActor(seeded.companyId, otherAgentId)))
      .post(`/api/issues/${seeded.issueId}/one-time-schedule`)
      .send({ timestamp: "2999-12-31T23:00:00Z", timeZone: "UTC" });

    expect(response.status, response.text).toBe(403);
    expect(await db.select().from(issueOneTimeSchedules)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
