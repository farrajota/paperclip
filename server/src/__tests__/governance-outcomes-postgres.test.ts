import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, createDb, goals, heartbeatRuns, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { goalOutcomeCheckins, goalOutcomeObservations, goalOutcomePeriods, goalOutcomeTargets } from "@paperclipai/db/schema/goal_outcomes";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { governanceOutcomeService } from "../services/governance-outcomes.js";
import type { OutcomeActorContext } from "../services/governance-outcomes.js";
import type { CreateOutcomeTarget, OutcomeObservationInput } from "@paperclipai/shared/governance-outcomes";
import { governanceOutcomeRoutes } from "../routes/governance-outcomes.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping embedded Postgres outcomes tests: ${support.reason ?? "unsupported environment"}`);

const writeTime = new Date("2026-10-20T01:00:00.000Z");

describePostgres("goal outcome persistence contract", () => {
  let db!: Db;
  let database: EmbeddedPostgresTestDatabase | null = null;
  let companyId = "";
  let goalId = "";
  let ownerId = "";
  let otherAgentId = "";
  let ownerRunId = "";
  let ownerKeyId = "";

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-goal-outcomes-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(goalOutcomeCheckins);
    await db.delete(goalOutcomeObservations);
    await db.delete(goalOutcomeTargets);
    await db.delete(goalOutcomePeriods);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await database?.cleanup(); });

  async function seed(options: { lowTrustOwner?: boolean; lowTrustRunOnly?: boolean } = {}) {
    companyId = randomUUID(); goalId = randomUUID(); ownerId = randomUUID(); otherAgentId = randomUUID();
    ownerRunId = randomUUID(); ownerKeyId = randomUUID();
    const responsibleUserId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Outcomes test", issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 5)}`, defaultResponsibleUserId: responsibleUserId, requireBoardApprovalForNewAgents: false });
    const ownerPermissions = options.lowTrustOwner ? {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, issueIds: [randomUUID()] } },
    } : {};
    await db.insert(agents).values([
      { id: ownerId, companyId, name: "Outcome owner", role: "analyst", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: ownerPermissions },
      { id: otherAgentId, companyId, name: "Other analyst", role: "analyst", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: ownerId, status: "active", membershipRole: "member" },
      { companyId, principalType: "agent", principalId: otherAgentId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(heartbeatRuns).values({ id: ownerRunId, companyId, agentId: ownerId, contextSnapshot: options.lowTrustOwner || options.lowTrustRunOnly ? {
      executionPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, issueIds: [randomUUID()] } } },
    } : {} });
    await db.insert(goals).values({ id: goalId, companyId, title: "Retention", level: "company", status: "active" });
  }

  function boardContext(): OutcomeActorContext {
    const actorId = randomUUID();
    return {
      authorizationActor: { type: "board", userId: actorId, source: "local_implicit" },
      principal: { actorType: "user", actorId, sessionId: null, agentId: null, runId: null, agentApiKeyId: null, actorSource: "local_implicit" },
    };
  }

  function agentContext(agentId = ownerId, runId: string | null = ownerRunId, keyId: string | null = ownerKeyId): OutcomeActorContext {
    return {
      authorizationActor: { type: "agent", agentId, companyId, source: "agent_key", runId, keyId },
      principal: { actorType: "agent", actorId: agentId, agentId, runId, agentApiKeyId: keyId, actorSource: "agent_key" },
    };
  }

  function targetInput(expectedRevision: number, aggregation: "latest" | "sum" = "latest", overrides: Partial<CreateOutcomeTarget> = {}): CreateOutcomeTarget {
    return {
      expectedRevision, period: { label: "October", timezone: "UTC", intervalStart: "2026-10-01T00:00:00.000Z", intervalEnd: "2026-11-01T00:00:00.000Z", lifecycle: "active" },
      metricKey: "retained-users", kind: "count", unit: "users", direction: "increase", aggregation,
      population: "active accounts", source: "manual", queryVersion: "v1", freshnessHours: 72, maturityHours: 24,
      baselineValue: 10, targetValue: 20, rangeMin: null, rangeMax: null, ownerAgentId: ownerId, guardrails: [], trajectory: [],
      ...overrides,
    };
  }

  function measurement(targetId: string, overrides: Partial<OutcomeObservationInput> = {}): OutcomeObservationInput {
    return {
      targetId, source: "manual", sourceRevision: "v1", sourceKey: "snapshot-1", value: 15, unit: "users", population: "active accounts",
      windowStart: "2026-10-19T00:00:00.000Z", windowEnd: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-19T12:00:00.000Z", availableAt: "2026-10-20T00:00:00.000Z", guardrailValues: {}, ...overrides,
    };
  }

  async function createTarget(service = governanceOutcomeService(db), input = targetInput(0)) {
    return service.createTarget(companyId, goalId, input, boardContext());
  }

  function outcomeApp(context: OutcomeActorContext) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { actor: context.authorizationActor }); next(); });
    app.use("/api", governanceOutcomeRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function foreignNativeReferences() {
    const foreignCompanyId = randomUUID();
    const foreignGoalId = randomUUID();
    const foreignOwnerId = randomUUID();
    const foreignIssueId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign company", issuePrefix: `F${foreignCompanyId.replace(/-/g, "").slice(0, 5)}`, defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(goals).values({ id: foreignGoalId, companyId: foreignCompanyId, title: "Foreign goal", level: "company", status: "active" });
    await db.insert(agents).values({ id: foreignOwnerId, companyId: foreignCompanyId, name: "Foreign owner", role: "analyst", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: foreignIssueId, companyId: foreignCompanyId, goalId: foreignGoalId, title: "Foreign corrective work" });
    return { foreignGoalId, foreignOwnerId, foreignIssueId };
  }

  it("persists immutable CAS revisions and rejects immutable period lifecycle changes", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    await expect(db.update(goalOutcomeTargets).set({ targetValue: 21 }).where(eq(goalOutcomeTargets.id, target.id))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55000", message: "goal outcome history is append-only" }) });
    const [period] = await db.select().from(goalOutcomePeriods).where(eq(goalOutcomePeriods.id, target.periodId));
    await expect(db.update(goalOutcomePeriods).set({ lifecycle: "closed" }).where(eq(goalOutcomePeriods.id, period.id))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55000", message: "goal outcome history is append-only" }) });
    expect(target.revision).toBe(1);
    await expect(service.createTarget(companyId, goalId, targetInput(0), boardContext())).rejects.toMatchObject({ status: 409 });
    await expect(service.createTarget(companyId, goalId, targetInput(1, "latest", { period: { ...targetInput(1).period, lifecycle: "closed" } }), boardContext())).rejects.toMatchObject({ status: 409 });
    const revisions = await db.select().from(goalOutcomeTargets).where(eq(goalOutcomeTargets.goalId, goalId));
    expect(revisions).toHaveLength(1);
  });

  it("serializes competing target CAS requests so exactly one revision wins", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const outcomes = await Promise.allSettled([
      service.createTarget(companyId, goalId, targetInput(0), boardContext()),
      service.createTarget(companyId, goalId, targetInput(0), boardContext()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected" && result.reason?.status === 409)).toHaveLength(1);
    const rows = await db.select().from(goalOutcomeTargets).where(eq(goalOutcomeTargets.goalId, goalId));
    expect(rows.map((row) => row.revision)).toEqual([1]);
  });

  it("limits sum-period overlap to the same metric's effective contract", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    await createTarget(service, targetInput(0, "sum", { metricKey: "revenue" }));
    await createTarget(service, targetInput(0, "sum", { metricKey: "orders" }));
    await service.createTarget(companyId, goalId, targetInput(1, "sum", { metricKey: "revenue" }), boardContext());
    const overlapping = targetInput(2, "sum", { metricKey: "revenue", period: {
      label: "Overlapping period", timezone: "UTC", intervalStart: "2026-10-15T00:00:00.000Z", intervalEnd: "2026-11-15T00:00:00.000Z", lifecycle: "active",
    } });
    await expect(service.createTarget(companyId, goalId, overlapping, boardContext())).rejects.toMatchObject({ status: 409 });
    const unrelated = await db.select().from(goalOutcomeTargets).where(eq(goalOutcomeTargets.metricKey, "orders"));
    expect(unrelated).toHaveLength(1);
  });

  it("uses the effective target revision when applying sum-period overlap checks", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    await createTarget(service, targetInput(0, "sum", { metricKey: "revenue" }));
    await service.createTarget(companyId, goalId, targetInput(1, "latest", { metricKey: "revenue" }), boardContext());
    const overlapping = targetInput(2, "sum", { metricKey: "revenue", period: {
      label: "Overlapping period", timezone: "UTC", intervalStart: "2026-10-15T00:00:00.000Z", intervalEnd: "2026-11-15T00:00:00.000Z", lifecycle: "active",
    } });
    await expect(service.createTarget(companyId, goalId, overlapping, boardContext())).resolves.toMatchObject({ revision: 3, aggregation: "sum" });
  });

  it("deduplicates identical corrections, conflicts on changed correction identity, and preserves history", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const firstInput = measurement(target.id);
    const inserted = await service.addObservation(companyId, goalId, firstInput, agentContext(), undefined, writeTime);
    expect(inserted.reused).toBe(false);
    const replay = await service.addObservation(companyId, goalId, firstInput, agentContext(), undefined, writeTime);
    expect(replay).toMatchObject({ reused: true, observation: { id: inserted.observation.id } });
    await expect(service.addObservation(companyId, goalId, measurement(target.id, { value: 16 }), agentContext(), undefined, writeTime)).rejects.toMatchObject({ status: 409 });
    const correctionInput = measurement(target.id, { sourceKey: "snapshot-2", value: 20 });
    const correction = { supersedesId: inserted.observation.id, correctionReason: "Source report was corrected" };
    const corrected = await service.addObservation(companyId, goalId, correctionInput, agentContext(), correction, writeTime);
    const replayedCorrection = await service.addObservation(companyId, goalId, correctionInput, agentContext(), correction, writeTime);
    expect(replayedCorrection).toMatchObject({ reused: true, observation: { id: corrected.observation.id } });
    await expect(service.addObservation(companyId, goalId, correctionInput, agentContext(), { ...correction, correctionReason: "Different reason" }, writeTime)).rejects.toMatchObject({ status: 409 });
    await expect(service.addObservation(companyId, goalId, measurement(target.id, { ...correctionInput, value: 19 }), agentContext(), correction, writeTime)).rejects.toMatchObject({ status: 409 });
    await expect(service.addObservation(companyId, goalId, correctionInput, agentContext(), { ...correction, supersedesId: randomUUID() }, writeTime)).rejects.toMatchObject({ status: 409 });
    await expect(service.addObservation(companyId, goalId, measurement(target.id, { sourceKey: "snapshot-3", value: 18 }), agentContext(), correction, writeTime)).rejects.toMatchObject({ status: 409 });
    const ledger = await service.read(companyId, goalId, agentContext(), new Date("2026-10-21T01:00:00.000Z"));
    expect(ledger.observations).toHaveLength(2);
    expect(ledger.outcomes[0]?.health).toMatchObject({ status: "achieved", value: 20 });
    expect(ledger.observations.find((row) => row.id === corrected.observation.id)?.supersedesId).toBe(inserted.observation.id);
  });

  it("serializes concurrent duplicate ingestion and correction-branch races", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const input = measurement(target.id);
    const duplicateAttempts = await Promise.all([
      service.addObservation(companyId, goalId, input, agentContext(), undefined, writeTime),
      service.addObservation(companyId, goalId, input, agentContext(), undefined, writeTime),
    ]);
    expect(duplicateAttempts.map((result) => result.reused).sort()).toEqual([false, true]);
    const parent = duplicateAttempts[0]!.observation;
    const correctionAttempts = await Promise.allSettled([
      service.addObservation(companyId, goalId, measurement(target.id, { sourceKey: "correction-a", value: 17 }), agentContext(), { supersedesId: parent.id, correctionReason: "Corrected report A" }, writeTime),
      service.addObservation(companyId, goalId, measurement(target.id, { sourceKey: "correction-b", value: 18 }), agentContext(), { supersedesId: parent.id, correctionReason: "Corrected report B" }, writeTime),
    ]);
    expect(correctionAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(correctionAttempts.filter((result) => result.status === "rejected" && result.reason?.status === 409)).toHaveLength(1);
    const rows = await db.select().from(goalOutcomeObservations).where(eq(goalOutcomeObservations.targetId, target.id));
    expect(rows).toHaveLength(2);
  });

  it("enforces approved owner, native source/run authority and immutable provenance", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    await expect(service.addObservation(companyId, goalId, measurement(target.id), agentContext(otherAgentId, null, null), undefined, writeTime)).rejects.toMatchObject({ status: 422 });
    const inserted = await service.addObservation(companyId, goalId, measurement(target.id), agentContext(), undefined, writeTime);
    expect(inserted.observation).toMatchObject({ submittedBy: ownerId, submitterType: "agent", submitterSource: "agent_key", submitterKeyId: ownerKeyId, runId: ownerRunId });
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, inserted.observation.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "agent", actorId: ownerId, agentId: ownerId, runId: ownerRunId });
  });

  it("does not let an assigned owner bypass low-trust company-scope denial", async () => {
    await seed({ lowTrustOwner: true });
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    await expect(service.addObservation(companyId, goalId, measurement(target.id), agentContext(), undefined, writeTime)).rejects.toMatchObject({ status: 403 });
    await expect(service.read(companyId, goalId, agentContext(), new Date("2026-10-20T12:00:00.000Z"))).rejects.toMatchObject({ status: 404 });
    const rows = await db.select().from(goalOutcomeObservations).where(eq(goalOutcomeObservations.targetId, target.id));
    expect(rows).toHaveLength(0);
  });
  it("applies API-key task scope before metric-owner authority", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const scoped = agentContext();
    scoped.authorizationActor = { ...scoped.authorizationActor, keyScope: { kind: "task_bridge", parentIssueId: randomUUID() } };
    await expect(service.addObservation(companyId, goalId, measurement(target.id), scoped, undefined, writeTime)).rejects.toMatchObject({ status: 403 });
    const rows = await db.select().from(goalOutcomeObservations).where(eq(goalOutcomeObservations.targetId, target.id));
    expect(rows).toHaveLength(0);
  });

  it("applies run-only low-trust restrictions at the HTTP boundary even when the agent itself is unrestricted", async () => {
    await seed({ lowTrustRunOnly: true });
    const target = await createTarget();
    const app = outcomeApp(agentContext());
    const denied = await request(app).post(`/api/goals/${goalId}/outcomes/observations`).send(measurement(target.id));
    expect(denied.status).toBe(403);
    const hidden = await request(app).get(`/api/goals/${goalId}/outcomes`);
    expect(hidden.status).toBe(404);
    expect(await db.select().from(goalOutcomeObservations)).toHaveLength(0);
    const unrestricted = await request(outcomeApp(agentContext(ownerId, null))).post(`/api/goals/${goalId}/outcomes/observations`).send(measurement(target.id));
    expect(unrestricted.status).toBe(201);
    expect(unrestricted.body.observation).toMatchObject({ submittedBy: ownerId, submitterSource: "agent_key", submitterKeyId: ownerKeyId, runId: null });
  });

  it("enforces scoped-key HTTP authorization rather than echoing principal arguments", async () => {
    await seed();
    const target = await createTarget();
    const scoped = agentContext();
    scoped.authorizationActor = { ...scoped.authorizationActor, keyScope: { kind: "task_bridge", parentIssueId: randomUUID() } };
    const denied = await request(outcomeApp(scoped)).post(`/api/goals/${goalId}/outcomes/observations`).send(measurement(target.id));
    expect(denied.status).toBe(403);
    expect(await db.select().from(goalOutcomeObservations)).toHaveLength(0);
    const allowed = await request(outcomeApp(agentContext())).post(`/api/goals/${goalId}/outcomes/observations`).send(measurement(target.id));
    expect(allowed.status).toBe(201);
    expect(allowed.body.observation).toMatchObject({ submittedBy: ownerId, submitterSource: "agent_key", submitterKeyId: ownerKeyId, runId: ownerRunId });
  });

  it("keeps future and immature typed samples unknown at real persistence boundaries", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const matureTarget = await createTarget(service, targetInput(0, "latest", { metricKey: "maturity-boundary" }));
    const futureObservation = measurement(target.id, {
      sourceKey: "future-observation", value: 25, windowStart: "2026-10-19T00:00:00.000Z", windowEnd: "2026-10-21T00:00:00.000Z",
      observedAt: "2026-10-20T13:00:00.000Z", availableAt: "2026-10-20T13:00:00.000Z",
    });
    await service.addObservation(companyId, goalId, futureObservation, agentContext(), undefined, writeTime);
    const availabilityNotReached = measurement(target.id, { sourceKey: "future-availability", value: 25, availableAt: "2026-10-21T00:00:00.000Z" });
    await service.addObservation(companyId, goalId, availabilityNotReached, agentContext(), undefined, writeTime);
    const beforeMaturity = measurement(matureTarget.id, {
      sourceKey: "immature-window", value: 20, windowStart: "2026-10-20T00:00:00.000Z", windowEnd: "2026-10-20T12:00:00.000Z",
      observedAt: "2026-10-20T11:59:00.000Z", availableAt: "2026-10-20T11:59:00.000Z",
    });
    await service.addObservation(companyId, goalId, beforeMaturity, agentContext(), undefined, writeTime);
    const early = await service.read(companyId, goalId, agentContext(), new Date("2026-10-21T11:59:00.000Z"));
    expect(early.outcomes.find((outcome) => outcome.target.metricKey === "maturity-boundary")?.health).toMatchObject({ status: "unknown" });
    expect(early.outcomes.find((outcome) => outcome.target.metricKey === target.metricKey)?.health).toMatchObject({ status: "unknown" });
    const mature = await service.read(companyId, goalId, agentContext(), new Date("2026-10-21T12:00:00.000Z"));
    expect(mature.outcomes.find((outcome) => outcome.target.metricKey === "maturity-boundary")?.health).toMatchObject({ status: "achieved", value: 20 });
  });

  it("rejects private corrective references without an existence oracle and redacts revoked visibility", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const visibleIssueId = randomUUID();
    const privateIssueId = randomUUID();
    await db.insert(issues).values([
      { id: visibleIssueId, companyId, goalId, title: "Visible corrective work", visibility: "open", assigneeAgentId: ownerId },
      { id: privateIssueId, companyId, goalId, title: "Private corrective work", visibility: "private", createdByUserId: randomUUID() },
    ]);
    const checkinInput = { targetId: target.id, health: "at_risk" as const, evidence: "Measured decline", forecastValue: 12, uncertainty: "Moderate", nextReviewAt: "2026-10-30T00:00:00.000Z" };
    const saved = await service.addCheckin(companyId, goalId, { ...checkinInput, correctiveIssueId: visibleIssueId }, agentContext());
    const denied = await Promise.all([
      service.addCheckin(companyId, goalId, { ...checkinInput, correctiveIssueId: privateIssueId }, agentContext()).catch((error: { status?: number; message?: string }) => error),
      service.addCheckin(companyId, goalId, { ...checkinInput, correctiveIssueId: randomUUID() }, agentContext()).catch((error: { status?: number; message?: string }) => error),
    ]);
    expect(denied[0]).toMatchObject({ status: 422, message: "Corrective issue reference is not available" });
    expect(denied[1]).toMatchObject({ status: 422, message: "Corrective issue reference is not available" });
    await db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, visibleIssueId));
    const ledger = await service.read(companyId, goalId, agentContext(), new Date("2026-10-20T12:00:00.000Z"));
    expect(ledger.checkins.find((row) => row.id === saved.id)?.correctiveIssueId).toBeNull();
  });

  it("rejects a real cross-company target-period reference at the database constraint", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const sourceTarget = await createTarget(service);
    const otherCompanyId = randomUUID();
    const otherGoalId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: `X${otherCompanyId.replace(/-/g, "").slice(0, 5)}`, defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(goals).values({ id: otherGoalId, companyId: otherCompanyId, title: "Other goal", level: "company", status: "active" });
    await expect(db.insert(goalOutcomeTargets).values({
      companyId: otherCompanyId, goalId: otherGoalId, periodId: sourceTarget.periodId, metricKey: "foreign-metric", revision: 1,
      kind: "count", unit: "users", direction: "increase", aggregation: "latest", population: "active accounts", source: "manual",
      queryVersion: "v1", freshnessHours: 72, maturityHours: 24, baselineValue: 10, targetValue: 20, rangeMin: null, rangeMax: null,
      ownerAgentId: null, guardrails: [], trajectory: [], approvedBy: randomUUID(),
    })).rejects.toThrow();
  });

  it("rejects a period rooted in company A that references a native goal from company B", async () => {
    await seed();
    const { foreignGoalId } = await foreignNativeReferences();
    await expect(db.insert(goalOutcomePeriods).values({ companyId, goalId: foreignGoalId, label: "Invalid native root", timezone: "UTC", intervalStart: new Date("2026-10-01T00:00:00Z"), intervalEnd: new Date("2026-11-01T00:00:00Z") })).rejects.toThrow();
    expect(await db.select().from(goalOutcomePeriods)).toHaveLength(0);
  });

  it("rejects a foreign native owner even when the target's period/company/goal chain is valid", async () => {
    await seed();
    const target = await createTarget();
    const { foreignOwnerId } = await foreignNativeReferences();
    await expect(db.insert(goalOutcomeTargets).values({ ...target, id: randomUUID(), revision: 2, ownerAgentId: foreignOwnerId })).rejects.toThrow();
    expect(await db.select().from(goalOutcomeTargets)).toHaveLength(1);
  });

  it("rejects a foreign native corrective issue even when the check-in target/company/goal chain is valid", async () => {
    await seed();
    const target = await createTarget();
    const { foreignIssueId } = await foreignNativeReferences();
    await expect(db.insert(goalOutcomeCheckins).values({ companyId, goalId, targetId: target.id, health: "unknown", evidence: "Measured uncertainty", uncertainty: "High", correctiveIssueId: foreignIssueId, nextReviewAt: new Date("2026-10-30T00:00:00Z"), createdBy: randomUUID() })).rejects.toThrow();
    expect(await db.select().from(goalOutcomeCheckins)).toHaveLength(0);
  });

  it("retains immutable owner and corrective references by restricting native deletion", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    const correctiveIssueId = randomUUID();
    await db.insert(issues).values({ id: correctiveIssueId, companyId, goalId, title: "Corrective work", visibility: "open" });
    const checkin = await service.addCheckin(companyId, goalId, { targetId: target.id, health: "unknown", evidence: "Waiting for mature evidence", uncertainty: "High", correctiveIssueId, nextReviewAt: "2026-10-30T00:00:00Z" }, boardContext());
    await expect(db.delete(agents).where(eq(agents.id, ownerId))).rejects.toThrow();
    await expect(db.delete(issues).where(eq(issues.id, correctiveIssueId))).rejects.toThrow();
    const [retainedTarget] = await db.select().from(goalOutcomeTargets).where(eq(goalOutcomeTargets.id, target.id));
    const [retainedCheckin] = await db.select().from(goalOutcomeCheckins).where(eq(goalOutcomeCheckins.id, checkin.id));
    expect(retainedTarget?.ownerAgentId).toBe(ownerId);
    expect(retainedCheckin?.correctiveIssueId).toBe(correctiveIssueId);
  });

  it("rolls back a measurement when its native audit write fails", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    await db.execute(sql`CREATE FUNCTION reject_outcome_audit_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'goal_outcome.observation.created' THEN
          RAISE EXCEPTION 'intentional outcome audit failure';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await db.execute(sql`CREATE TRIGGER reject_outcome_audit_for_test BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION reject_outcome_audit_for_test()`);
    try {
      await expect(service.addObservation(companyId, goalId, measurement(target.id, { sourceKey: "audit-failure" }), agentContext(), undefined, writeTime)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "P0001", message: "intentional outcome audit failure" }) });
      const rows = await db.select().from(goalOutcomeObservations).where(and(eq(goalOutcomeObservations.targetId, target.id), eq(goalOutcomeObservations.sourceKey, "audit-failure")));
      expect(rows).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_outcome_audit_for_test ON activity_log`);
      await db.execute(sql`DROP FUNCTION reject_outcome_audit_for_test()`);
    }
  });

  it("rejects observations and check-ins that cross company or unit scope", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service);
    await expect(service.addObservation(companyId, goalId, measurement(target.id, { unit: "seats" }), agentContext(), undefined, writeTime)).rejects.toMatchObject({ status: 422 });
    await expect(service.addCheckin(companyId, goalId, { targetId: target.id, health: "unknown", evidence: "evidence", forecastValue: null, uncertainty: "uncertain", correctiveIssueId: randomUUID(), nextReviewAt: "2026-10-30T00:00:00.000Z" }, agentContext())).rejects.toMatchObject({ status: 422 });
  });

  it("rejects overlapping samples inside a sum target while permitting correction replay", async () => {
    await seed();
    const service = governanceOutcomeService(db);
    const target = await createTarget(service, targetInput(0, "sum"));
    const first = await service.addObservation(companyId, goalId, measurement(target.id), agentContext(), undefined, writeTime);
    const overlap = measurement(target.id, { sourceKey: "snapshot-2", value: 5, windowStart: "2026-10-19T12:00:00.000Z", windowEnd: "2026-10-20T12:00:00.000Z", observedAt: "2026-10-20T11:00:00.000Z", availableAt: "2026-10-20T12:00:00.000Z" });
    await expect(service.addObservation(companyId, goalId, overlap, agentContext(), undefined, writeTime)).rejects.toMatchObject({ status: 409 });
    const correctionInput = measurement(target.id, { sourceKey: "correction-1", value: 11 });
    const correction = { supersedesId: first.observation.id, correctionReason: "Corrected amount" };
    const corrected = await service.addObservation(companyId, goalId, correctionInput, agentContext(), correction, writeTime);
    await expect(service.addObservation(companyId, goalId, overlap, agentContext(), undefined, writeTime)).rejects.toMatchObject({ status: 409 });
    expect((await service.addObservation(companyId, goalId, correctionInput, agentContext(), correction, writeTime)).observation.id).toBe(corrected.observation.id);
  });
});
