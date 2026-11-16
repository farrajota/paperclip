import { agentWakeupRequests, agents, companies, createDb, issueOneTimeSchedules, issues, routines, routineTriggers } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "../services/delivery-work-notifications.js";
import { registerScheduledWork } from "../services/scheduled-work.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("scheduled deadline database queries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-scheduled-deadlines");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("selects eligible deadlines and retains overdue routine capture continuations", async () => {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000);
    const [company, pausedCompany] = await db.insert(companies).values([
      { name: "Active schedules", issuePrefix: "SCH" },
      { name: "Paused schedules", issuePrefix: "PAU", status: "paused" },
    ]).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Scheduled agent" }).returning();
    const [active, paused, otherCompany] = await db.insert(routines).values([
      { companyId: company!.id, title: "Active routine" },
      { companyId: company!.id, title: "Paused routine", status: "paused" },
      { companyId: pausedCompany!.id, title: "Paused company routine" },
    ]).returning();
    const trigger = { companyId: company!.id, routineId: active!.id, kind: "schedule" };
    await db.insert(routineTriggers).values([
      { ...trigger, nextRunAt: at(10) },
      { ...trigger, enabled: false, nextRunAt: at(1) },
      { ...trigger, archived: true, nextRunAt: at(2) },
      { ...trigger, setupPending: true, nextRunAt: at(1) },
      { ...trigger, routineId: paused!.id, nextRunAt: at(3) },
      { ...trigger, companyId: pausedCompany!.id, nextRunAt: at(4) },
      { ...trigger, companyId: pausedCompany!.id, routineId: otherCompany!.id, nextRunAt: at(5) },
    ]);
    const monitor = { companyId: company!.id, title: "Monitor", status: "in_progress", assigneeAgentId: agent!.id };
    await db.insert(issues).values([
      { ...monitor, monitorNextCheckAt: at(15) },
      { ...monitor, status: "done", monitorNextCheckAt: at(1) },
      { ...monitor, assigneeUserId: "fixture-user", monitorNextCheckAt: at(2) },
      { ...monitor, assigneeAgentId: null, monitorNextCheckAt: at(3) },
      { ...monitor, companyId: pausedCompany!.id, monitorNextCheckAt: at(4) },
      { ...monitor, monitorNextCheckAt: at(-1) },
    ]);
    type Task = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    const tasks = new Map<DeliveryQueue, Task>();
    registerScheduledWork({ register: (queue, task) => {
      tasks.set(queue, task);
      return { ready: Promise.resolve(), wake: () => {} };
    } }, db, { retryMs: 60_000, tickTimers: async () => {}, tickRoutines: async () => {} });
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    expect(tasks.get(DELIVERY_QUEUES.routineSchedules)!.nextRunAt!()).toBe(at(10).getTime());
    expect(tasks.get(DELIVERY_QUEUES.issueMonitors)!.nextRunAt!()).toBe(at(15).getTime());
    await db.insert(routineTriggers).values({ ...trigger, nextRunAt: at(-1) });
    const beforeContinuation = Date.now();
    await tasks.get(DELIVERY_QUEUES.routineSchedules)!.run(new AbortController().signal);
    const continuation = tasks.get(DELIVERY_QUEUES.routineSchedules)!.nextRunAt!();
    expect(continuation).toBeGreaterThanOrEqual(beforeContinuation);
    expect(continuation).toBeLessThanOrEqual(Date.now());
    await db.execute(sql`truncate table companies restart identity cascade`);
    for (const task of tasks.values()) await task.run(new AbortController().signal);
    for (const task of tasks.values()) expect(task.nextRunAt!()).toBeNull();
  });

  it("wakes the timer worker at the next pending one-time schedule", async () => {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000);
    const [company, pausedCompany] = await db.insert(companies).values([
      { name: "Active one-time schedules", issuePrefix: "OTS" },
      { name: "Paused one-time schedules", issuePrefix: "OTP", status: "paused" },
    ]).returning();
    const [agent, pausedAgent] = await db.insert(agents).values([
      { companyId: company!.id, name: "Scheduled agent" },
      { companyId: pausedCompany!.id, name: "Paused company agent" },
    ]).returning();
    const target = { companyId: company!.id, title: "Scheduled", status: "todo", assigneeAgentId: agent!.id };
    const [monitored, pending, cancelled, claimed, overdue, pausedIssue] = await db.insert(issues).values([
      { ...target, status: "in_progress", monitorNextCheckAt: at(15) },
      target, target, target, target,
      { ...target, companyId: pausedCompany!.id, assigneeAgentId: pausedAgent!.id },
    ]).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: company!.id, agentId: agent!.id, source: "automation", status: "queued",
    }).returning();
    const schedule = { companyId: company!.id, assigneeAgentId: agent!.id, timeZone: "UTC" };
    await db.insert(issueOneTimeSchedules).values([
      { ...schedule, issueId: pending!.id, dueAt: at(5) },
      { ...schedule, issueId: cancelled!.id, dueAt: at(1), cancelledAt: new Date(now), cancellationReason: "Cancelled by user" },
      { ...schedule, issueId: claimed!.id, dueAt: at(2), wakeupRequestId: wake!.id },
      // Overdue work is drained by the tick itself; a past deadline would spin
      // the worker while scheduling is suppressed.
      { ...schedule, issueId: overdue!.id, dueAt: at(-1) },
      { ...schedule, companyId: pausedCompany!.id, assigneeAgentId: pausedAgent!.id, issueId: pausedIssue!.id, dueAt: at(3) },
    ]);
    expect(monitored).toBeDefined();
    type Task = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    const tasks = new Map<DeliveryQueue, Task>();
    registerScheduledWork({ register: (queue, task) => {
      tasks.set(queue, task);
      return { ready: Promise.resolve(), wake: () => {} };
    } }, db, { retryMs: 60_000, tickTimers: async () => {}, tickRoutines: async () => {} });
    const timers = tasks.get(DELIVERY_QUEUES.issueMonitors)!;
    await timers.run(new AbortController().signal);
    expect(timers.nextRunAt!()).toBe(at(5).getTime());

    await db.update(issueOneTimeSchedules).set({ cancelledAt: new Date(now), cancellationReason: "Cancelled by user" })
      .where(sql`${issueOneTimeSchedules.issueId} = ${pending!.id}`);
    await timers.run(new AbortController().signal);
    expect(timers.nextRunAt!()).toBe(at(15).getTime());
    await db.execute(sql`truncate table companies restart identity cascade`);
  });
});
