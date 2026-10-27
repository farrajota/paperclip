import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, instanceUserRoles, issueAccessGrants, issues, projects, type Db } from "@paperclipai/db";
import { issuePlanning } from "@paperclipai/db/schema/issue_planning";
import { routineOccurrences, routineRuns, routines, routineTriggers } from "@paperclipai/db/schema/routines";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { governancePlanningRouter } from "../routes/governance-planning.js";
import { getIssuePlanningGate } from "../services/governance-planning.js";
import { nextCronTickInTimeZone } from "../services/routines.js";
import { authorizationService, issueReadSqlCondition, projectReadSqlCondition } from "../services/authorization.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("governance planning PostgreSQL behavior", () => {
  let db!: Db;
  let cleanupEmbeddedPostgres: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-governance-planning-");
    cleanupEmbeddedPostgres = temporary.cleanup;
    db = createDb(temporary.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issuePlanning);
    await db.delete(routineOccurrences);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issueAccessGrants);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(agents);
    await db.delete(companies);
    vi.useRealTimers();
  });

  afterAll(async () => {
    await db?.$client.end();
    await cleanupEmbeddedPostgres?.();
  });

  const boardActor: Express.Request["actor"] = {
    type: "board", userId: "planning-board", source: "local_implicit", isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"] = boardActor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    server.use(governancePlanningRouter(db));
    server.use(errorHandler);
    return server;
  }

  async function createCompany(name = "Planning test") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `PLN${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function createIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Planning task", ...values }).returning();
    return issue!;
  }

  async function createPlan(issueId: string, companyId: string, values: Partial<typeof issuePlanning.$inferInsert>) {
    const [planning] = await db.insert(issuePlanning).values({ issueId, companyId, ...values }).returning();
    return planning!;
  }

  async function addRoutine(companyId: string, values: Partial<typeof routines.$inferInsert> = {}) {
    const [routine] = await db.insert(routines).values({ companyId, title: "Scheduled routine", ...values }).returning();
    return routine!;
  }

  async function addSchedule(companyId: string, routineId: string, values: Partial<typeof routineTriggers.$inferInsert> = {}) {
    const [trigger] = await db.insert(routineTriggers).values({ companyId, routineId, kind: "schedule", ...values }).returning();
    return trigger!;
  }

  it("preserves earliest-start restrictions for matching and mismatched executors", async () => {
    const company = await createCompany();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Gate agent" }).returning();
    const issue = await createIssue(company.id, { assigneeAgentId: agent!.id });
    await createPlan(issue.id, company.id, {
      earliestStart: "2026-11-02T10:00:00.000Z", dateMode: "timed", timezone: "UTC", revision: 4,
    });

    await expect(getIssuePlanningGate(db, company.id, issue.id, new Date("2026-11-02T09:59:59.999Z"), agent!.id))
      .resolves.toEqual({ eligible: false, reason: "earliest_start", earliestStart: "2026-11-02T10:00:00.000Z", revision: 4 });
    await expect(getIssuePlanningGate(db, company.id, issue.id, new Date("2026-11-02T09:59:59.999Z"), randomUUID()))
      .resolves.toEqual({ eligible: false, reason: "unknown", earliestStart: "2026-11-02T10:00:00.000Z", revision: 4 });
    await expect(getIssuePlanningGate(db, company.id, issue.id, new Date("2026-11-02T10:00:00.000Z")))
      .resolves.toMatchObject({ eligible: true, reason: "ready", revision: 4 });
    await expect(getIssuePlanningGate(db, company.id, randomUUID(), new Date("2026-11-02T10:00:00.000Z")))
      .resolves.toEqual({ eligible: true, reason: "ready", earliestStart: null, revision: null });
  });

  it("persists versioned edits with compare-and-swap and a transactional audit event", async () => {
    const company = await createCompany();
    const issue = await createIssue(company.id);
    const first = await request(app()).put(`/issues/${issue.id}/planning`).send({
      expectedRevision: 0, timezone: "America/New_York", dateMode: "timed",
      earliestStart: "2026-11-02T09:00:00-05:00", plannedStart: "2026-11-02T10:00:00-05:00",
      plannedFinish: "2026-11-02T12:00:00-05:00", hardDeadline: "2026-11-03T17:00:00-05:00",
      forecastStart: null, forecastFinish: null, actualStart: null, actualFinish: null,
    });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    expect(first.body.plannedStart).toBe("2026-11-02T10:00:00-05:00");

    const update = (plannedStart: string) => request(app()).put(`/issues/${issue.id}/planning`).send({
      expectedRevision: 1, timezone: "America/New_York", dateMode: "timed",
      earliestStart: null, plannedStart, plannedFinish: null, hardDeadline: null,
      forecastStart: null, forecastFinish: null, actualStart: null, actualFinish: null,
    });
    const raced = await Promise.all([update("2026-11-03T10:00:00-05:00"), update("2026-11-04T10:00:00-05:00")]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);

    const [stored] = await db.select().from(issuePlanning).where(eq(issuePlanning.issueId, issue.id));
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, company.id), eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.planning_updated"),
    ));
    expect(stored?.revision).toBe(2);
    expect(audits).toHaveLength(2);
  });

  it("validates retained dates under the locked revision before accepting partial updates", async () => {
    const company = await createCompany();
    const issue = await createIssue(company.id);
    await createPlan(issue.id, company.id, {
      plannedStart: "2026-11-02", plannedFinish: "2026-11-03", dateMode: "all_day", timezone: "UTC", revision: 1,
    });
    const server = app();
    const mode = await request(server).put(`/issues/${issue.id}/planning`).send({
      expectedRevision: 1, timezone: "UTC", dateMode: "timed", hardDeadline: "2026-11-04T12:00:00Z",
    });
    expect(mode.status).toBe(400);
    const order = await request(server).put(`/issues/${issue.id}/planning`).send({
      expectedRevision: 1, timezone: "UTC", dateMode: "all_day", plannedStart: "2026-11-04",
    });
    expect(order.status).toBe(400);
    const [unchanged] = await db.select().from(issuePlanning).where(eq(issuePlanning.issueId, issue.id));
    expect(unchanged).toMatchObject({ revision: 1, dateMode: "all_day", plannedStart: "2026-11-02", plannedFinish: "2026-11-03" });
    expect(await db.select().from(activityLog)).toHaveLength(0);
    const valid = await request(server).put(`/issues/${issue.id}/planning`).send({
      expectedRevision: 1, timezone: "UTC", dateMode: "all_day", hardDeadline: "2026-11-05",
    });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ revision: 2, plannedStart: "2026-11-02", plannedFinish: "2026-11-03", hardDeadline: "2026-11-05" });
  });

  it("projects overlapping plans, native actual times, recorded run states, occurrences, and consistent filters", async () => {
    const company = await createCompany();
    const [projectA, projectB] = await db.insert(projects).values([
      { companyId: company.id, name: "Project A" }, { companyId: company.id, name: "Project B" },
    ]).returning();
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company.id, name: "Agent A" }, { companyId: company.id, name: "Agent B" },
    ]).returning();
    const issueA = await createIssue(company.id, { title: "Visible planned task", projectId: projectA!.id, assigneeAgentId: agentA!.id });
    const issueB = await createIssue(company.id, { title: "Other project task", projectId: projectB!.id, assigneeAgentId: agentA!.id });
    await createPlan(issueA.id, company.id, {
      earliestStart: "2026-11-02T00:00:00Z", plannedStart: "2026-11-01T23:00:00-02:00",
      plannedFinish: "2026-11-02T01:00:00-02:00", hardDeadline: "2026-11-02T18:00:00Z",
      forecastStart: "2026-11-02T09:00:00Z", forecastFinish: "2026-11-02T10:00:00Z",
      actualStart: null, actualFinish: null, dateMode: "timed", timezone: "America/New_York", revision: 1,
    });
    await createPlan(issueB.id, company.id, {
      plannedStart: "2026-11-02T11:00:00Z", dateMode: "timed", timezone: "UTC", revision: 1,
    });
    await db.update(issues).set({ startedAt: new Date("2026-11-02T03:00:00Z"), completedAt: new Date("2026-11-02T04:00:00Z") })
      .where(eq(issues.id, issueA.id));

    const routineA = await addRoutine(company.id, { title: "Project A routine", projectId: projectA!.id, assigneeAgentId: agentA!.id });
    const triggerA = await addSchedule(company.id, routineA.id, {
      cronExpression: "0 9 * * *", timezone: "America/New_York", nextRunAt: new Date("2026-11-02T14:00:00Z"),
    });
    const routineB = await addRoutine(company.id, { title: "Project B routine", projectId: projectB!.id, assigneeAgentId: agentA!.id });
    await addSchedule(company.id, routineB.id, {
      cronExpression: "0 9 * * *", timezone: "America/New_York", nextRunAt: new Date("2026-11-02T14:00:00Z"),
    });
    await db.insert(routineRuns).values({
      companyId: company.id, routineId: routineA.id, triggerId: triggerA.id, source: "schedule", status: "paused",
      triggeredAt: new Date("2026-11-02T15:00:00Z"), linkedIssueId: issueA.id,
    });
    const [overlappingRun] = await db.insert(routineRuns).values({
      companyId: company.id, routineId: routineA.id, triggerId: triggerA.id, source: "schedule", status: "completed",
      triggeredAt: new Date("2026-11-01T23:00:00Z"), completedAt: new Date("2026-11-02T01:00:00Z"), linkedIssueId: issueA.id,
    }).returning();
    await db.insert(routineOccurrences).values({
      companyId: company.id, routineId: routineA.id, triggerId: triggerA.id,
      scheduledAt: new Date("2026-11-02T16:00:00Z"), revisionNumber: 1, occurrenceKey: "planning-occurrence",
      disposition: "obligation", executionState: "unknown",
    });

    const url = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC&projectId=${projectA!.id}&assigneeAgentId=${agentA!.id}`;
    const response = await request(app()).get(url);
    expect(response.status).toBe(200);
    const events = response.body.events as Array<{ id: string; title: string; source: string; eventKind: string; start: string; end: string | null; actual: boolean; status: string; href: string }>;
    expect(events.map((event) => event.title)).not.toContain("Other project task");
    expect(events.map((event) => event.title)).not.toContain("Project B routine");
    const planned = events.find((event) => event.id === `${issueA.id}:planned` && event.eventKind === "planned");
    expect(planned).toMatchObject({ actual: false, href: `/issues/${issueA.id}` });
    expect(planned?.start).toBe("2026-11-01T23:00:00-02:00");
    expect(Date.parse(planned!.end!) - Date.parse(planned!.start)).toBe(2 * 60 * 60 * 1000);
    const nativeActual = events.find((event) => event.id === `${issueA.id}:native_actual` && event.eventKind === "native_actual");
    expect(nativeActual).toMatchObject({
      actual: true,
      start: "2026-11-02T03:00:00.000Z",
      end: "2026-11-02T04:00:00.000Z",
      href: `/issues/${issueA.id}`,
    });
    expect(events.some((event) => event.id === overlappingRun!.id && event.source === "run")).toBe(true);
    expect(events.map((event) => Date.parse(event.start))).toEqual(events.map((event) => Date.parse(event.start)).sort((left, right) => left - right));
    expect(events.some((event) => event.source === "run" && event.status === "paused" && event.actual)).toBe(true);
    expect(events.some((event) => event.source === "routine" && event.status === "unknown" && event.actual)).toBe(true);

    const otherAgentUrl = url.replace(`assigneeAgentId=${agentA!.id}`, `assigneeAgentId=${agentB!.id}`);
    const otherAgent = await request(app()).get(otherAgentUrl);
    expect(otherAgent.status).toBe(200);
    expect(otherAgent.body.events).toEqual([]);
    const onlyActual = await request(app()).get(`${url}&actualOnly=true`);
    expect(onlyActual.status).toBe(200);
    expect(onlyActual.body.events.every((event: { actual: boolean }) => event.actual)).toBe(true);
    expect(onlyActual.body.events.some((event: { status: string }) => event.status === "paused")).toBe(true);
  });

  it("keeps authorized private issue principals visible and masks inaccessible and cross-company IDs", async () => {
    const company = await createCompany();
    const otherCompany = await createCompany("Other planning company");
    const readerId = "planning-private-reader";
    const outsiderId = "planning-private-outsider";
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: readerId, membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: outsiderId, membershipRole: "owner" },
    ]);
    const privateIssue = await createIssue(company.id, { title: "Authorized private task", visibility: "private", assigneeUserId: readerId });
    const privateUnplannedTask = await createIssue(company.id, { title: "Private selectable task", visibility: "private", assigneeUserId: readerId });
    const hiddenUnplannedTask = await createIssue(company.id, { title: "Hidden private task", visibility: "private", assigneeUserId: outsiderId });
    const crossCompanyIssue = await createIssue(otherCompany.id, { title: "Other tenant task" });
    await createPlan(privateIssue.id, company.id, { plannedStart: "2026-11-02T10:00:00Z", timezone: "UTC", revision: 1 });

    const memberApp = (userId: string) => app({
      type: "board", userId, source: "session", companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
    });
    const allowed = await request(memberApp(readerId)).get(`/issues/${privateIssue.id}/planning`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.revision).toBe(1);
    const denied = await request(memberApp(outsiderId)).get(`/issues/${privateIssue.id}/planning`);
    const missing = await request(memberApp(outsiderId)).get(`/issues/${randomUUID()}/planning`);
    const crossTenant = await request(memberApp(readerId)).get(`/issues/${crossCompanyIssue.id}/planning`);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(crossTenant.status).toBe(404);

    const calendar = await request(memberApp(readerId)).get(
      `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC`,
    );
    expect(calendar.status).toBe(200);
    expect(calendar.body.events.some((event: { id: string }) => event.id.startsWith(`${privateIssue.id}:`))).toBe(true);
    const picker = await request(memberApp(readerId)).get(`/companies/${company.id}/governance-calendar/tasks?query=private`);
    expect(picker.status).toBe(200);
    expect(picker.body.tasks.map((task: { id: string }) => task.id)).toContain(privateUnplannedTask.id);
    expect(picker.body.tasks.map((task: { id: string }) => task.id)).not.toContain(hiddenUnplannedTask.id);
    expect(picker.body.truncated).toBe(false);
  });

  it("normalizes a selected-zone DST day and includes overlapping intervals at its boundary", async () => {
    const company = await createCompany();
    const overlapping = await createIssue(company.id, { title: "Cross-midnight plan" });
    const outside = await createIssue(company.id, { title: "At next local midnight" });
    await createPlan(overlapping.id, company.id, {
      plannedStart: "2026-11-02T03:30:00Z", plannedFinish: "2026-11-02T04:30:00Z",
      dateMode: "timed", timezone: "America/New_York", revision: 1,
    });
    await createPlan(outside.id, company.id, {
      plannedStart: "2026-11-02T05:00:00Z", dateMode: "timed", timezone: "UTC", revision: 1,
    });

    const response = await request(app()).get(
      `/companies/${company.id}/governance-calendar?from=2026-11-01&to=2026-11-02&timezone=America%2FNew_York`,
    );
    expect(response.status).toBe(200);
    expect(response.body.from).toBe("2026-11-01T04:00:00.000Z");
    expect(response.body.to).toBe("2026-11-02T05:00:00.000Z");
    expect(Date.parse(response.body.to) - Date.parse(response.body.from)).toBe(25 * 60 * 60 * 1_000);
    expect(response.body.events.some((event: { id: string }) => event.id === `${overlapping.id}:planned`)).toBe(true);
    expect(response.body.events.some((event: { id: string }) => event.id === `${outside.id}:planned`)).toBe(false);
  });

  it("validates bounded calendar ranges and limits and leaves schedules unchanged on GET", async () => {
    const company = await createCompany();
    const routine = await addRoutine(company.id);
    const trigger = await addSchedule(company.id, routine.id, {
      cronExpression: "0 9 * * *", timezone: "UTC", nextRunAt: new Date("2026-11-02T09:00:00Z"),
    });
    const server = app();
    const base = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC`;
    const valid = await request(server).get(base);
    expect(valid.status).toBe(200);
    expect(valid.body.events.length).toBeGreaterThan(0);
    expect((await request(server).get(`${base}&limit=1.5`)).status).toBe(400);
    const wideRange = base.replace("from=2026-11-02", "from=2026-01-01").replace("to=2026-11-03", "to=2026-04-01");
    expect((await request(server).get(wideRange)).status).toBe(400);
    const [after] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
    const auditRows = await db.select().from(activityLog);
    expect(after?.nextRunAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(auditRows).toHaveLength(0);
  });

  it.each(["private", "mcp_admin", "issue_policy", "project_policy"] as const)("applies full native %s authorization before every source and task-selector bound", async (restriction) => {
    const company = await createCompany();
    const userId = "planning-bounds-reader";
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Planning policy reader" }).returning();
    if (restriction === "mcp_admin") await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    const actor: Express.Request["actor"] = restriction.endsWith("policy")
      ? { type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_key" }
      : { type: "board", userId, source: restriction === "mcp_admin" ? "mcp_oauth" : "session", companyIds: [company.id], memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }] };
    const server = app(actor);
    const visible = await createIssue(company.id, { title: "Visible plan" });
    const unplanned = await createIssue(company.id, { title: "Visible unplanned" });
    await createPlan(visible.id, company.id, { plannedStart: "2026-11-02T15:00:00Z", timezone: "UTC", revision: 1 });
    const routine = await addRoutine(company.id, { title: "Visible routine" });
    const trigger = await addSchedule(company.id, routine.id, { cronExpression: "0 18 * * *", timezone: "UTC", nextRunAt: new Date("2026-11-02T18:00:00Z") });
    await db.insert(routineRuns).values({ companyId: company.id, routineId: routine.id, triggerId: trigger.id, source: "schedule", triggeredAt: new Date("2026-11-02T19:00:00Z") });
    await db.insert(routineOccurrences).values({ companyId: company.id, routineId: routine.id, triggerId: trigger.id, scheduledAt: new Date("2026-11-02T20:00:00Z"), revisionNumber: 1, occurrenceKey: "visible-bounded" });
    const url = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC`;
    const baseline = await request(server).get(url);
    expect(baseline.status).toBe(200);
    const policy = { authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: company.id, issueIds: [visible.id] } } };
    const [hiddenProject] = await db.insert(projects).values({
      companyId: company.id, name: "Hidden project",
      ...(restriction === "project_policy" ? { executionWorkspacePolicy: policy } : {}),
    }).returning();
    const hiddenIssueFields: Partial<typeof issues.$inferInsert> = restriction === "issue_policy"
      ? { executionPolicy: policy }
      : restriction === "project_policy" ? { projectId: hiddenProject!.id } : { visibility: "private" };
    const hiddenParent = await createIssue(company.id, { title: "Hidden parent", ...hiddenIssueFields, updatedAt: new Date("2020-01-01T00:00:00Z") });
    const hiddenRoutine = await addRoutine(company.id, {
      title: "Hidden routine",
      ...(restriction === "project_policy" ? { projectId: hiddenProject!.id } : { parentIssueId: hiddenParent.id }),
    });
    const nativeAccess = authorizationService(db);
    expect((await nativeAccess.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: company.id } })).allowed).toBe(true);
    const hiddenDecision = await nativeAccess.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: company.id, issueId: hiddenParent.id, projectId: hiddenParent.projectId } });
    expect(hiddenDecision.allowed).toBe(false);
    if (restriction.endsWith("policy")) expect(hiddenDecision.reason).toBe("deny_low_trust_boundary");
    if (restriction !== "private") {
      const candidates = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, hiddenParent.id), await issueReadSqlCondition(db, actor)));
      expect(candidates).toHaveLength(1);
    }
    if (restriction === "project_policy") {
      expect((await nativeAccess.decide({ actor, action: "project:read", resource: { type: "project", companyId: company.id, projectId: hiddenProject!.id } })).allowed).toBe(false);
      expect(await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, hiddenProject!.id), await projectReadSqlCondition(db, actor)))).toHaveLength(1);
    }
    const hiddenIds: string[] = [];
    for (let offset = 0; offset < 5_001; offset += 200) {
      const rows = Array.from({ length: Math.min(200, 5_001 - offset) }, (_, index) => ({ id: randomUUID(), triggerId: randomUUID(), key: offset + index }));
      hiddenIds.push(...rows.map((row) => row.id));
      await db.insert(issues).values(rows.map((row) => ({ id: row.id, companyId: company.id, title: "Hidden task", ...hiddenIssueFields, updatedAt: new Date("2020-01-01T00:00:00Z") })));
      await db.insert(issuePlanning).values(rows.map((row) => ({ issueId: row.id, companyId: company.id, plannedStart: "2026-11-02T01:00:00Z", revision: 1 })));
      await db.insert(routineTriggers).values(rows.map((row) => ({ id: row.triggerId, companyId: company.id, routineId: hiddenRoutine.id, kind: "schedule", cronExpression: "* * * * *", timezone: "UTC", nextRunAt: new Date("2026-11-02T01:00:00Z") })));
      await db.insert(routineRuns).values(rows.map((row) => ({ companyId: company.id, routineId: hiddenRoutine.id, triggerId: row.triggerId, source: "schedule", triggeredAt: new Date("2026-11-02T01:00:00Z") })));
      await db.insert(routineOccurrences).values(rows.map((row) => ({ companyId: company.id, routineId: hiddenRoutine.id, triggerId: row.triggerId, scheduledAt: new Date("2026-11-02T01:00:00Z"), revisionNumber: 1, occurrenceKey: `hidden-${row.key}` })));
    }
    const withHidden = await request(server).get(url);
    expect(withHidden.status).toBe(200);
    expect(withHidden.body).toEqual(baseline.body);
    for (let offset = 0; offset < hiddenIds.length; offset += 200) {
      await db.delete(issuePlanning).where(inArray(issuePlanning.issueId, hiddenIds.slice(offset, offset + 200)));
    }
    const picker = await request(server).get(`/companies/${company.id}/governance-calendar/tasks?limit=1&query=unplanned`);
    expect(picker.status).toBe(200);
    expect(picker.body).toMatchObject({ tasks: [{ id: unplanned.id }], truncated: false, incomplete: false });
    const allTasks = await request(server).get(`/companies/${company.id}/governance-calendar/tasks`);
    expect(allTasks.body.tasks.map((task: { id: string }) => task.id)).toEqual([unplanned.id]);
    expect(allTasks.body.truncated).toBe(false);
    const boundedPicker = await request(server).get(`/companies/${company.id}/governance-calendar/tasks?limit=1`);
    expect(boundedPicker.status).toBe(200);
    expect(boundedPicker.body).toMatchObject({ tasks: [{ id: unplanned.id }], truncated: false, incomplete: false });
    expect(allTasks.body.incomplete).toBe(false);
    const second = await createIssue(company.id, { title: "Second visible unplanned", updatedAt: new Date(unplanned.updatedAt.getTime() + 60_000) });
    const truncatedPicker = await request(server).get(`/companies/${company.id}/governance-calendar/tasks?limit=1`);
    expect(truncatedPicker.status).toBe(200);
    expect(truncatedPicker.body).toMatchObject({ tasks: [{ id: unplanned.id }], truncated: true, incomplete: false });
    const completePicker = await request(server).get(`/companies/${company.id}/governance-calendar/tasks?limit=2`);
    expect(completePicker.status).toBe(200);
    expect(completePicker.body).toMatchObject({ tasks: [{ id: unplanned.id }, { id: second.id }], truncated: false, incomplete: false });
  }, 120_000);

  it("honors explicit and implicit private issue grants without exposing their private project", async () => {
    const company = await createCompany();
    const userId = "planning-project-grantee";
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator" });
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Hidden project", visibility: "private", pausedAt: new Date() }).returning();
    const explicit = await createIssue(company.id, { title: "Explicit task", projectId: project!.id, visibility: "private" });
    const implicit = await createIssue(company.id, { title: "Implicit task", projectId: project!.id, visibility: "private", assigneeUserId: userId });
    await db.insert(issueAccessGrants).values({ issueId: explicit.id, subjectType: "user", subjectId: userId, source: "explicit" });
    await createPlan(explicit.id, company.id, { plannedStart: "2026-11-02T10:00:00Z", timezone: "UTC", revision: 1 });
    const server = app({ type: "board", userId, source: "session", companyIds: [company.id], memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }] });
    expect((await request(server).get(`/issues/${explicit.id}/planning`)).status).toBe(200);
    const calendar = await request(server).get(`/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC`);
    expect(calendar.status).toBe(200);
    expect(calendar.body.events.map((event: { id: string }) => event.id)).toContain(`${explicit.id}:planned`);
    expect(JSON.stringify(calendar.body)).not.toContain("Hidden project");
    expect(calendar.body.warnings).toEqual([]);
    const picker = await request(server).get(`/companies/${company.id}/governance-calendar/tasks`);
    expect(picker.body.tasks.map((task: { id: string }) => task.id)).toContain(implicit.id);
  });

  it("keeps read-only board viewers and reading agents out of supported mutation controls", async () => {
    const company = await createCompany();
    const issue = await createIssue(company.id);
    const userId = "planning-viewer";
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "viewer" });
    const viewer = app({ type: "board", userId, source: "session", companyIds: [company.id], memberships: [{ companyId: company.id, membershipRole: "viewer", status: "active" }] });
    const base = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC`;
    const read = await request(viewer).get(base);
    expect(read.status).toBe(200);
    expect(read.body.canEditPlanning).toBe(false);
    expect((await request(viewer).put(`/issues/${issue.id}/planning`).send({ expectedRevision: 0, timezone: "UTC" })).status).toBe(403);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Planning reader" }).returning();
    const reader = app({ type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_key" });
    const agentRead = await request(reader).get(base);
    expect(agentRead.status).toBe(200);
    expect(agentRead.body.canEditPlanning).toBe(false);
    expect((await request(reader).put(`/issues/${issue.id}/planning`).send({ expectedRevision: 0, timezone: "UTC" })).status).toBe(403);
  });

  it("denies cross-company agents, task-bridge keys and agents acting for unavailable users", async () => {
    const company = await createCompany();
    const other = await createCompany("Foreign agent company");
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Scoped agent" }).returning();
    const [foreign] = await db.insert(agents).values({ companyId: other.id, name: "Foreign agent" }).returning();
    const issue = await createIssue(company.id);
    const base = `/companies/${company.id}/governance-calendar`;
    const deniedActors: Express.Request["actor"][] = [
      { type: "agent", agentId: foreign!.id, companyId: other.id, source: "agent_key" },
      { type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_key", keyId: randomUUID(), keyScope: { kind: "task_bridge", parentIssueId: issue.id } },
      { type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_key", keyId: randomUUID(), keyScope: { kind: "skill_test", issueId: randomUUID() } },
      { type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_jwt", authorizingUserId: "missing-authorizer" },
    ];
    for (const actor of deniedActors) {
      const server = app(actor);
      expect([403, 404]).toContain((await request(server).get(`${base}?from=2026-11-02&to=2026-11-03&timezone=UTC`)).status);
      expect([403, 404]).toContain((await request(server).get(`${base}/tasks`)).status);
      expect([403, 404]).toContain((await request(server).get(`/issues/${issue.id}/planning`)).status);
    }
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("bounds actual native minute-search work for impossible and sparse non-UTC schedules", async () => {
    const before = new Date("2026-11-03T00:00:00Z");
    const sharedBudget = { remainingMinutes: 7 };
    expect(nextCronTickInTimeZone("0 9 31 2 *", "America/New_York", new Date("2026-11-02T00:00:00Z"), { before, budget: sharedBudget })).toBeNull();
    expect(sharedBudget.remainingMinutes).toBe(0);
    expect(nextCronTickInTimeZone("0 9 1 1 *", "America/New_York", new Date("2026-11-02T00:00:00Z"), { before, budget: sharedBudget })).toBeNull();
    expect(sharedBudget.remainingMinutes).toBe(0);
    const endBudget = { remainingMinutes: 100 };
    expect(nextCronTickInTimeZone("* * * * *", "America/New_York", new Date(before.getTime() - 60_000), { before, budget: endBudget })).toBeNull();
    expect(endBudget.remainingMinutes).toBe(100);
    const parityBudget = { remainingMinutes: 120 };
    const after = new Date("2026-11-01T05:30:00Z");
    expect(nextCronTickInTimeZone("30 1 * * *", "America/New_York", after, { before, budget: parityBudget }))
      .toEqual(nextCronTickInTimeZone("30 1 * * *", "America/New_York", after));
    expect(parityBudget.remainingMinutes).toBe(60);

    const company = await createCompany();
    const routine = await addRoutine(company.id);
    await addSchedule(company.id, routine.id, { cronExpression: "0 9 31 2 *", timezone: "America/New_York", nextRunAt: new Date("2020-01-01T00:00:00Z") });
    const url = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC&source=routine`;
    const response = await request(app()).get(url);
    expect(response.status).toBe(200);
    expect(response.body.events).toEqual([]);
    expect(response.body.incomplete).toBe(false);
    await db.insert(routineTriggers).values(Array.from({ length: 70 }, (_, index) => ({
      companyId: company.id, routineId: routine.id, kind: "schedule", timezone: "America/New_York",
      cronExpression: index % 2 ? "0 9 31 2 *" : "0 9 1 1 *", nextRunAt: new Date("2020-01-01T00:00:00Z"),
    })));
    const exhausted = await request(app()).get(url);
    expect(exhausted.status).toBe(200);
    expect(exhausted.body.events).toEqual([]);
    expect(exhausted.body.incomplete).toBe(true);
    expect(exhausted.body.warnings.some((warning: string) => warning.includes("minute-search budget"))).toBe(true);
  });

  it("distinguishes exact full-search exhaustion, empty intervals and one uninspected minute", async () => {
    const company = await createCompany();
    const routine = await addRoutine(company.id);
    await db.insert(routineTriggers).values(Array.from({ length: 69 }, () => ({
      companyId: company.id, routineId: routine.id, kind: "schedule", timezone: "UTC",
      cronExpression: "0 9 31 2 *", nextRunAt: new Date("2026-11-02T00:00:00Z"),
    })));
    await addSchedule(company.id, routine.id, { cronExpression: "0 9 31 2 *", timezone: "UTC", nextRunAt: new Date("2026-11-02T13:20:00Z") });
    // After 69 * 1440 + 640 inspected minutes, this trigger has no candidate before the end.
    await addSchedule(company.id, routine.id, { cronExpression: "* * * * *", timezone: "UTC", nextRunAt: new Date("2026-11-03T00:00:00Z") });
    const url = `/companies/${company.id}/governance-calendar?from=2026-11-02&to=2026-11-03&timezone=UTC&source=routine`;
    const complete = await request(app()).get(url);
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ events: [], incomplete: false, truncated: false, warnings: [] });
    await addSchedule(company.id, routine.id, { cronExpression: "* * * * *", timezone: "UTC", nextRunAt: new Date("2026-11-02T23:59:00Z") });
    const incomplete = await request(app()).get(url);
    expect(incomplete.status).toBe(200);
    expect(incomplete.body).toMatchObject({ events: [], incomplete: true, truncated: false });
    expect(incomplete.body.warnings).toEqual(["Routine schedule projection exhausted its shared minute-search budget; this range may be incomplete."]);
  });

  it("uses native cron AND, gap, and fold semantics for timezone-aware recurrence", () => {
    expect(nextCronTickInTimeZone("30 1 * * *", "America/New_York", new Date("2026-11-01T04:59:00Z"))?.toISOString())
      .toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronTickInTimeZone("30 1 * * *", "America/New_York", new Date("2026-11-01T05:30:00Z"))?.toISOString())
      .toBe("2026-11-01T06:30:00.000Z");
    expect(nextCronTickInTimeZone("30 2 * * *", "America/New_York", new Date("2026-03-08T05:00:00Z"))?.toISOString())
      .toBe("2026-03-09T06:30:00.000Z");
    expect(nextCronTickInTimeZone("0 9 1 * 1", "UTC", new Date("2026-12-01T10:00:00Z"))?.toISOString())
      .toBe("2027-02-01T09:00:00.000Z");
  });
});
