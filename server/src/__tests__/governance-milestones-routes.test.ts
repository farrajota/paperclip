import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, authUsers, caseAccessSources, caseDocuments, cases, companies, companyMemberships, createDb, documentRevisions, documents, heartbeatRuns, instanceUserRoles, issueAccessGrants, issueWorkProducts, issues, type Db } from "@paperclipai/db";
import { governanceMilestoneDecisions, governanceMilestoneEvents, governanceMilestoneFollowups, governanceMilestoneRevisions, governanceMilestones } from "@paperclipai/db/schema/governance_milestones";
import type { MilestoneContractInput } from "@paperclipai/shared/governance-milestones";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { governanceMilestoneRoutes } from "../routes/governance-milestones.js";
import { governanceMilestoneService } from "../services/governance-milestones.js";
import { buildLowTrustSourceTrust } from "../services/source-trust.js";
import { workProductService } from "../services/work-products.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

describePostgres("governance milestone routes", () => {
  let db!: Db;
  let cleanup: (() => Promise<void>) | null = null;
  const boardActor: Express.Request["actor"] = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };

  beforeAll(async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-governance-milestones-");
    cleanup = temporary.cleanup;
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS fail_milestone_followup_receipt_test ON governance_milestone_followups"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS fail_milestone_followup_receipt_test()"));
    await db.delete(agentApiKeys);
    await db.delete(activityLog);
    await db.delete(governanceMilestoneFollowups);
    await db.delete(governanceMilestoneEvents);
    await db.delete(governanceMilestoneDecisions);
    await db.delete(governanceMilestoneRevisions);
    await db.delete(governanceMilestones);
    await db.delete(cases);
    await db.delete(issues);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  });

  afterAll(async () => { await cleanup?.(); });

  function app(actor: Express.Request["actor"] = boardActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", governanceMilestoneRoutes(db));
    instance.use("/api", issueRoutes(db, {} as never));
    instance.get("/api/unrelated", (_req, res) => res.json({ ok: true }));
    instance.use(errorHandler);
    return instance;
  }

  async function fixture() {
    const suffix = randomUUID().slice(0, 8);
    const [company] = await db.insert(companies).values({ name: "Milestone Co", issuePrefix: `MS${suffix}` }).returning();
    const [task] = await db.insert(issues).values({ companyId: company!.id, title: "Primary task", status: "done", identifier: `MS-${suffix}`, issueNumber: 1 }).returning();
    const [caseRow] = await db.insert(cases).values({ companyId: company!.id, workIssueId: task!.id, caseNumber: 1, identifier: `${company!.issuePrefix}-C1`, caseType: "project", title: "Launch case" }).returning();
    const [playbook] = await db.insert(documents).values({ companyId: company!.id, title: "Approved playbook", latestBody: "# Launch playbook" }).returning();
    const [playbookRevision] = await db.insert(documentRevisions).values({ companyId: company!.id, documentId: playbook!.id, revisionNumber: 1, body: "# Launch playbook", createdByUserId: "board-user" }).returning();
    await db.update(documents).set({ latestRevisionId: playbookRevision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, playbook!.id));
    await db.insert(caseDocuments).values({ companyId: company!.id, caseId: caseRow!.id, documentId: playbook!.id, key: "playbook" });
    return { company: company!, task: task!, caseRow: caseRow!, playbook: playbook!, playbookRevision: playbookRevision! };
  }

  async function createAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId, name, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    return agent!;
  }

  function contract(input: {
    task: typeof issues.$inferSelect;
    playbook: typeof documents.$inferSelect;
    playbookRevision: typeof documentRevisions.$inferSelect;
    deliverables?: MilestoneContractInput["requiredDeliverables"];
    reviewerPolicy?: MilestoneContractInput["reviewerPolicy"];
    executorPolicy?: MilestoneContractInput["executorPolicy"];
    followups?: MilestoneContractInput["followups"];
  }): MilestoneContractInput {
    return {
      title: "Launch readiness",
      playbookBinding: { documentId: input.playbook.id, documentRevisionId: input.playbookRevision.id },
      requiredDeliverables: input.deliverables ?? [{
        key: "primary", label: "Primary task completed", evidenceKind: "issue_completion",
        reference: { kind: "task", taskId: input.task.id }, maxAgeHours: 168,
      }],
      executorPolicy: input.executorPolicy ?? { kind: "any_internal_agent" },
      reviewerPolicy: input.reviewerPolicy ?? { kind: "board_user" },
      followups: input.followups ?? [],
    };
  }

  interface MilestoneHttpResponse { body: unknown }
  interface MilestoneHttpRequest extends PromiseLike<MilestoneHttpResponse> {
    send(body: unknown): MilestoneHttpRequest;
    expect(status: number, body?: Record<string, unknown>): PromiseLike<MilestoneHttpResponse>;
  }
  interface MilestoneHttp {
    get(path: string): MilestoneHttpRequest;
    post(path: string): MilestoneHttpRequest;
  }

  const milestoneIdentitySchema = z.object({ id: z.string().uuid() });
  const revisionIdentitySchema = milestoneIdentitySchema.extend({ revision: z.number().int() });
  const readinessSchema = z.object({
    eligible: z.boolean(), accepted: z.boolean(), state: z.string(), reason: z.string(),
    evidenceVersion: z.number().int(), evidenceSnapshotHash: z.string(),
  });
  const historySchema = z.object({ readiness: readinessSchema });
  const followupReceiptsSchema = z.array(z.object({ actionKey: z.string(), issueId: z.string().uuid() }));
  const decisionResponseSchema = z.object({
    event: z.object({ id: z.string().uuid(), kind: z.string(), acknowledgedAt: z.string().nullable() }),
    followups: followupReceiptsSchema,
    decision: z.object({ reviewerAgentId: z.string().uuid().nullable() }).optional(),
  });

  async function createMilestone(http: MilestoneHttp, caseId: string) {
    const result = await http.post(`/api/cases/${caseId}/milestones`).send({}).expect(201);
    return milestoneIdentitySchema.parse(result.body);
  }

  async function createDraft(http: MilestoneHttp, milestoneId: string, value: MilestoneContractInput) {
    const result = await http.post(`/api/milestones/${milestoneId}/revisions`).send(value).expect(201);
    return revisionIdentitySchema.parse(result.body);
  }

  async function promote(http: MilestoneHttp, milestoneId: string, revisionId: string, expectedActiveRevisionId: string | null) {
    const result = await http.post(`/api/milestones/${milestoneId}/revisions/${revisionId}/promote`).send({ expectedActiveRevisionId }).expect(200);
    return revisionIdentitySchema.parse(result.body);
  }

  async function createActive(http: MilestoneHttp, caseId: string, value: MilestoneContractInput) {
    const milestone = await createMilestone(http, caseId);
    const revision = await createDraft(http, milestone.id, value);
    await promote(http, milestone.id, revision.id, null);
    return { milestone, revision };
  }

  async function readiness(http: MilestoneHttp, caseId: string) {
    const result = await http.get(`/api/cases/${caseId}/milestones`).expect(200);
    return historySchema.parse(result.body).readiness;
  }

  function addEvidence(http: MilestoneHttp, milestoneId: string, revision: { revision: number }, evidenceVersion: number, deliverableKey: string, evidenceKind: string, artifactId: string): MilestoneHttpRequest {
    return http.post(`/api/milestones/${milestoneId}/evidence`).send({
      deliverableKey, evidenceKind, artifactId, expectedRevision: revision.revision, expectedEvidenceVersion: evidenceVersion,
    });
  }

  function decisionInput(revision: { revision: number }, current: z.infer<typeof readinessSchema>, outcome: "accept" | "reject" | "revoke" = "accept") {
    return {
      outcome, reason: "Reviewed current stored evidence", expectedRevision: revision.revision,
      expectedEvidenceVersion: current.evidenceVersion, expectedEvidenceSnapshotHash: current.evidenceSnapshotHash,
    };
  }

  async function waitForBlockedMutation(blockerPid: number, minimum = 1) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await db.execute(sql`
        with recursive blocked_backends(pid) as (
          select activity.pid
          from pg_stat_activity activity
          where activity.datname = current_database()
            and ${blockerPid} = any(pg_blocking_pids(activity.pid))
          union
          select activity.pid
          from pg_stat_activity activity
          join blocked_backends blocker on blocker.pid = any(pg_blocking_pids(activity.pid))
          where activity.datname = current_database()
        )
        select pid from blocked_backends
      `);
      if (result.length >= minimum) return;
    }
    throw new Error("Acceptance did not reach the controlled PostgreSQL lock boundary");
  }

  it("preserves attested cloud privilege without importing stale database elevation", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const userId = `cloud-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Cloud member", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "member", status: "active" });
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, task.id));
    await db.insert(caseAccessSources).values({ companyId: company.id, caseId: caseRow.id, sourceKind: "issue", sourceId: task.id });
    const http = request(app());
    const milestone = await createMilestone(http, caseRow.id);
    const cloudActor: Express.Request["actor"] = { type: "board", userId, source: "cloud_tenant", companyIds: [company.id], isInstanceAdmin: false };
    const value = contract({ task, playbook, playbookRevision });
    await request(app(cloudActor)).post(`/api/milestones/${milestone.id}/revisions`).send(value).expect(404);
    expect(await db.select().from(governanceMilestoneRevisions)).toHaveLength(0);
    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, userId));
    const elevated = request(app({ ...cloudActor, isInstanceAdmin: true }));
    const revision = await createDraft(elevated, milestone.id, value);
    await promote(elevated, milestone.id, revision.id, null);
    await addEvidence(elevated, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(elevated, caseRow.id);
    await elevated.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200);
    expect(await readiness(elevated, caseRow.id)).toMatchObject({ accepted: true });
    // A saved review is not a new trusted-header attestation, even if a stale DB role reappears.
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: false, state: "accepted_stale", reason: "reviewer_not_allowed" });
    await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "user", subjectId: userId, source: "explicit" });
    expect(await readiness(request(app(cloudActor)), caseRow.id)).toMatchObject({ accepted: true });
  });

  it("denies unchanged skill-test task-create scope atomically and permits an unrestricted independent key", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Independent key reviewer");
    const userId = `key-owner-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Key owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const scope = { kind: "skill_test" as const, issueId: task.id };
    const [key] = await db.insert(agentApiKeys).values({ companyId: company.id, agentId: reviewer.id, name: "Scoped reviewer", keyHash: randomUUID(), responsibleUserId: userId, scopeConfig: scope }).returning();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id }, followups: [{ actionKey: "handoff", title: "Authorized child" }] }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const actor: Express.Request["actor"] = { type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_key", keyId: key!.id, keyScope: scope, onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }] };
    const scoped = request(app(actor));
    const reviewed = await readiness(scoped, caseRow.id);
    expect(reviewed.eligible).toBe(true);
    await scoped.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(403);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
    expect((await db.select().from(governanceMilestoneRevisions))[0]!.state).toBe("active");
    await db.update(agentApiKeys).set({ scopeConfig: { kind: "standard" } }).where(eq(agentApiKeys.id, key!.id));
    const unrestricted = request(app({ ...actor, keyScope: { kind: "standard" } }));
    const accepted = decisionResponseSchema.parse((await unrestricted.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200)).body);
    expect(accepted.followups).toHaveLength(1);
    // Replaying a completed event is harmless; newly acknowledging it still requires task-create authority.
    await db.update(governanceMilestoneEvents).set({ acknowledgedAt: null }).where(eq(governanceMilestoneEvents.id, accepted.event.id));
    const [scopedKey] = await db.insert(agentApiKeys).values({ companyId: company.id, agentId: reviewer.id, name: "Read-only replay", keyHash: randomUUID(), responsibleUserId: userId, scopeConfig: scope }).returning();
    await request(app({ ...actor, keyId: scopedKey!.id })).post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(403);
    expect((await db.select().from(governanceMilestoneEvents))[0]!.acknowledgedAt).toBeNull();
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
    await unrestricted.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200);
  });

  it.each(["cancelled", "cancelled ordinary", "cancellation requested", "lost ownership", "finished native"] as const)("disables current review for a %s run without invalidating historical approval merely on Stop", async (condition) => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Running reviewer");
    const [reviewTask] = await db.insert(issues).values({ companyId: company.id, title: "Review", status: "in_progress", assigneeAgentId: reviewer.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: reviewer.id, scopeKind: "issue", issueId: reviewTask!.id, nativeIssueId: reviewTask!.id, status: "running", runtimeMode: condition === "cancelled ordinary" ? "legacy" : "native" }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, reviewTask!.id));
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewHttp = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, runId: run!.id, source: "agent_jwt" }));
    const permissions = z.object({ permissions: z.object({ canReview: z.boolean(), canAccept: z.boolean() }) });
    const sourcesBeforeRead = await db.select().from(caseAccessSources);
    expect(permissions.parse((await reviewHttp.get(`/api/cases/${caseRow.id}/milestones`).expect(200)).body).permissions).toEqual({ canReview: true, canAccept: true });
    expect(await db.select().from(caseAccessSources)).toEqual(sourcesBeforeRead);
    if (condition === "lost ownership") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, reviewTask!.id));
    else await db.update(heartbeatRuns).set(condition === "cancelled" || condition === "cancelled ordinary" ? { status: "cancelled" } : condition === "cancellation requested" ? { resultJson: { executionCancellation: { state: "requested" } } } : { status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    expect(permissions.parse((await reviewHttp.get(`/api/cases/${caseRow.id}/milestones`).expect(200)).body).permissions).toEqual({ canReview: false, canAccept: false });
    const reviewed = await readiness(http, caseRow.id);
    await reviewHttp.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(403);
    await db.update(heartbeatRuns).set({ status: "running", resultJson: null }).where(eq(heartbeatRuns.id, run!.id));
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, reviewTask!.id));
    await reviewHttp.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run!.id));
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: true });
  });

  it("hides self-review controls for the pinned executor fallback on an unassigned task", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Pinned executor and reviewer");
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, executorPolicy: { kind: "assigned_agent", agentId: reviewer.id }, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewHttp = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_jwt" }));
    expect(z.object({ permissions: z.object({ canReview: z.boolean(), canAccept: z.boolean() }) }).parse((await reviewHttp.get(`/api/cases/${caseRow.id}/milestones`).expect(200)).body).permissions).toEqual({ canReview: false, canAccept: false });
    await reviewHttp.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, await readiness(http, caseRow.id))).expect(403);
  });

  it("never authorizes execution without an approved active revision", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const executor = await createAgent(company.id, "Executor");
    const http = request(app());
    const milestone = await createMilestone(http, caseRow.id);
    const revision = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision }));
    const service = governanceMilestoneService(db);
    for (const actor of [undefined, { agentId: randomUUID() }, { agentId: executor.id, taskId: randomUUID() }, { agentId: executor.id, taskId: task.id }]) {
      expect(await service.getMilestoneReadiness(company.id, milestone.id, actor)).toMatchObject({ executionAllowed: false, reason: "no_active_contract" });
    }
    await promote(http, milestone.id, revision.id, null);
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, await readiness(http, caseRow.id))).expect(200);
    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, await readiness(http, caseRow.id), "revoke")).expect(200);
    for (const actor of [undefined, { agentId: randomUUID() }, { agentId: executor.id, taskId: task.id }]) {
      expect(await service.getMilestoneReadiness(company.id, milestone.id, actor)).toMatchObject({ executionAllowed: false, reason: "no_active_contract" });
    }
  });

  it.each(["acceptance", "replay"] as const)("takes native privacy before source endpoints during %s and preserves native receipt identity", async (operation) => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app({ ...boardActor, userId: "independent-board" }));
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision,
      deliverables: [{ key: "document", label: "Stored document", evidenceKind: "document_revision", reference: { kind: "document", documentId: playbook.id }, maxAgeHours: null }],
      followups: [{ actionKey: "handoff", title: "Native child" }],
    }));
    await addEvidence(http, milestone.id, revision, 0, "document", "document_revision", playbookRevision.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    const accepted = operation === "replay" ? decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200)).body) : null;
    // Exercise replay's missing-receipt path while leaving the native idempotent task intact.
    if (accepted) await db.delete(governanceMilestoneFollowups).where(eq(governanceMilestoneFollowups.acceptedRevisionId, revision.id));
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${company.id}`}, 0))`);
      response = operation === "acceptance"
        ? http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result)
        : http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted!.event.id }).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      const updated = await issueService(db).update(task.id, { visibility: "private", actorUserId: "independent-board" }, tx);
      expect(updated).toMatchObject({ id: task.id, visibility: "private" });
    });
    const result = await response!;
    expect(result.status).toBe(200);
    const receipts = operation === "acceptance" ? decisionResponseSchema.parse(result.body).followups : followupReceiptsSchema.parse(result.body);
    expect(receipts).toHaveLength(1);
    if (accepted) expect(receipts).toEqual(accepted.followups);
    expect((await db.select().from(issues).where(eq(issues.id, receipts[0]!.issueId)))[0]).toMatchObject({ visibility: "private", privacyParentIssueId: task.id, issueNumber: 2 });
    expect((await db.select().from(companies).where(eq(companies.id, company.id)))[0]!.issueCounter).toBe(2);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(1);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(1);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
    expect(followupReceiptsSchema.parse((await http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted?.event.id ?? decisionResponseSchema.parse(result.body).event.id }).expect(200)).body)).toEqual(receipts);
  });

  it.each(["acceptance", "replay"] as const)("takes the company numbering fence before Case/task locks during %s", async (operation) => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({
      task, playbook, playbookRevision, followups: [{ actionKey: "handoff", title: "Native follow-up" }],
    }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    const accepted = operation === "replay" ? decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200)).body) : null;
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, company.id)).for("no key update");
      response = operation === "acceptance"
        ? http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result)
        : http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted!.event.id }).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      // Native creation/dispatch already owns the company fence. A waiting
      // milestone must not hold the lower-order Case or task locks it needs next.
      await tx.execute(sql`select id from cases where id = ${caseRow.id} for update nowait`);
      await tx.execute(sql`select id from issues where id = ${task.id} for update nowait`);
    });
    const result = await response!;
    expect(result.status).toBe(200);
    const receipts = operation === "acceptance" ? decisionResponseSchema.parse(result.body).followups : followupReceiptsSchema.parse(result.body);
    expect(receipts).toHaveLength(1);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
    if (accepted) expect(receipts).toEqual(accepted.followups);
  });

  it("rechecks a native Stop committed while acceptance waits on the reviewer's execution task", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Verifier run");
    const [reviewTask] = await db.insert(issues).values({ companyId: company.id, title: "Review task", status: "in_progress", assigneeAgentId: reviewer.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: reviewer.id, scopeKind: "issue", issueId: reviewTask!.id, nativeIssueId: reviewTask!.id, status: "running", runtimeMode: "native", contextSnapshot: { issueId: reviewTask!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, reviewTask!.id));
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(issues).where(eq(issues.id, reviewTask!.id)).for("update");
      response = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, runId: run!.id, source: "agent_jwt" })).post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      await tx.update(heartbeatRuns).set({ status: "cancelled", resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, run!.id));
    });
    expect((await response!).status).toBe(403);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
  });

  it("rejects executor reassignment committed while independent acceptance waits on the primary task", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const executor = await createAgent(company.id, "Executor");
    const reviewer = await createAgent(company.id, "Reviewer");
    await db.update(issues).set({ assigneeAgentId: executor.id }).where(eq(issues.id, task.id));
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(issues).where(eq(issues.id, task.id)).for("update");
      response = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_jwt" })).post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      await tx.update(issues).set({ assigneeAgentId: reviewer.id }).where(eq(issues.id, task.id));
    });
    expect((await response!).status).toBe(409);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]!.assigneeAgentId).toBe(reviewer.id);
  });

  it("rechecks retained private-resource access after waiting for artifact locks", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Reviewer");
    await db.insert(caseAccessSources).values({ companyId: company.id, caseId: caseRow.id, sourceKind: "issue", sourceId: task.id });
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(issues).where(eq(issues.id, task.id)).for("update");
      response = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_jwt" })).post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      await tx.update(issues).set({ visibility: "private" }).where(eq(issues.id, task.id));
    });
    expect((await response!).status).toBe(404);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
  });

  it("holds historical acceptance when the reviewer's retained private grant is revoked", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Reviewer");
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, task.id));
    await db.insert(caseAccessSources).values({ companyId: company.id, caseId: caseRow.id, sourceKind: "issue", sourceId: task.id });
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: task.id, subjectType: "agent", subjectId: reviewer.id, source: "explicit" }).returning();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    await request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_jwt" })).post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(200);
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: true });
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant!.id));
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: false, state: "accepted_stale", reason: "reviewer_not_allowed" });
  });

  it.each(["revocation", "scope narrowing"] as const)("fences authenticated agent key %s while acceptance waits on that key", async (change) => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const reviewer = await createAgent(company.id, "Reviewer");
    const userId = `responsible-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Responsible reviewer", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [key] = await db.insert(agentApiKeys).values({ companyId: company.id, agentId: reviewer.id, name: "Review key", keyHash: `fixture-${randomUUID()}`, responsibleUserId: userId }).returning();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id } }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(agentApiKeys).where(eq(agentApiKeys.id, key!.id)).for("update");
      response = request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_key", keyId: key!.id, keyScope: { kind: "standard" }, onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }] })).post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      await tx.update(agentApiKeys).set(change === "revocation" ? { revokedAt: new Date() } : { scopeConfig: { kind: "skill_test", issueId: task.id } }).where(eq(agentApiKeys.id, key!.id));
    });
    expect((await response!).status).toBe(403);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
  });


  it("keeps producer execution available before post-work evidence exists", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const executor = await createAgent(company.id, "Producer");
    await db.update(issues).set({ assigneeAgentId: executor.id, status: "in_progress" }).where(eq(issues.id, task.id));
    const http = request(app());
    const milestone = await createMilestone(http, caseRow.id);
    const revision = await createDraft(http, milestone.id, contract({
      task, playbook, playbookRevision, executorPolicy: { kind: "assigned_agent", agentId: executor.id },
    }));
    await promote(http, milestone.id, revision.id, null);

    const readiness = await governanceMilestoneService(db).getMilestoneReadiness(company.id, milestone.id, { agentId: executor.id, taskId: task.id });
    expect(readiness).toMatchObject({ eligible: false, executionAllowed: true, state: "blocked", reason: "incomplete_task" });
  });

  it("rechecks current completion, accepts atomically, and deduplicates concurrent replay", async () => {
    const { task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Prepare launch announcement" }] }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);

    await db.update(issues).set({ status: "backlog", statusVersion: task.statusVersion + 1 }).where(eq(issues.id, task.id));
    const incomplete = await readiness(http, caseRow.id);
    expect(incomplete).toMatchObject({ eligible: false, state: "blocked", reason: "incomplete_task" });
    await db.update(issues).set({ status: "done", statusVersion: task.statusVersion + 2 }).where(eq(issues.id, task.id));
    await addEvidence(http, milestone.id, revision, 1, "primary", "issue_completion", task.id).expect(201);

    const ready = await readiness(http, caseRow.id);
    expect(ready).toMatchObject({ eligible: true, accepted: false, state: "eligible_for_review", reason: "ready", evidenceVersion: 2 });
    const accepted = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, ready)).expect(200)).body);
    expect(accepted.event).toMatchObject({ kind: "milestone_accept" });
    expect(accepted.event.acknowledgedAt).toBeTruthy();
    expect(accepted.followups).toHaveLength(1);
    const current = await readiness(http, caseRow.id);
    expect(current).toMatchObject({ eligible: false, accepted: true, state: "accepted_current" });

    const replays = await Promise.all(Array.from({ length: 4 }, () =>
      http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200)));
    for (const replay of replays) expect(followupReceiptsSchema.parse(replay.body)).toEqual(accepted.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);

    await db.update(issues).set({ status: "backlog", statusVersion: task.statusVersion + 3 }).where(eq(issues.id, task.id));
    const held = await readiness(http, caseRow.id);
    expect(held).toMatchObject({ eligible: false, accepted: false, state: "accepted_stale", reason: "incomplete_task" });
    const heldReplay = await http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200);
    expect(followupReceiptsSchema.parse(heldReplay.body)).toEqual(accepted.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
  });

  it("validates the exact current case-linked document and preserves the reviewed evidence version", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const [document] = await db.insert(documents).values({ companyId: company.id, title: "Readiness brief", latestBody: "First version" }).returning();
    const [revision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: document!.id, revisionNumber: 1, body: "First version", createdByUserId: "producer-user" }).returning();
    await db.update(documents).set({ latestRevisionId: revision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, document!.id));
    await db.insert(caseDocuments).values({ companyId: company.id, caseId: caseRow.id, documentId: document!.id, key: "brief" });
    const http = request(app());
    const deliverable: MilestoneContractInput["requiredDeliverables"][number] = { key: "brief", label: "Current brief", evidenceKind: "document_revision", reference: { kind: "document", documentId: document!.id }, maxAgeHours: 168 };
    const { milestone, revision: contractRevision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, deliverables: [deliverable] }));
    await addEvidence(http, milestone.id, contractRevision, 0, "brief", "document_revision", revision!.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    expect(reviewed).toMatchObject({ eligible: true, state: "eligible_for_review" });
    await addEvidence(http, milestone.id, contractRevision, 0, "brief", "document_revision", revision!.id).expect(409);

    const [newRevision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: document!.id, revisionNumber: 2, body: "Changed version", createdByUserId: "producer-user" }).returning();
    let response: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(documents).where(eq(documents.id, document!.id)).for("update");
      response = http.post(`/api/milestones/${milestone.id}/revisions/${contractRevision.id}/decisions`).send(decisionInput(contractRevision, reviewed)).then((result) => result);
      await waitForBlockedMutation(blockerPid);
      await tx.update(documents).set({ latestRevisionId: newRevision!.id, latestRevisionNumber: 2, latestBody: "Changed version" }).where(eq(documents.id, document!.id));
    });
    expect((await response!).status).toBe(409);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
    expect(await readiness(http, caseRow.id)).toMatchObject({ eligible: false, reason: "stale_evidence" });
    await addEvidence(http, milestone.id, contractRevision, 1, "brief", "document_revision", revision!.id).expect(422);
  });

  it("compares both the observed active revision and the pinned playbook before promotion", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const milestone = await createMilestone(http, caseRow.id);
    const first = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision }));
    const second = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision }));
    await promote(http, milestone.id, first.id, null);
    await http.post(`/api/milestones/${milestone.id}/revisions/${second.id}/promote`).send({ expectedActiveRevisionId: null }).expect(409);

    const [newPlaybookRevision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: playbook.id, revisionNumber: 2, body: "# Updated playbook" }).returning();
    await db.update(documents).set({ latestRevisionId: newPlaybookRevision!.id, latestRevisionNumber: 2, latestBody: "# Updated playbook" }).where(eq(documents.id, playbook.id));
    await http.post(`/api/milestones/${milestone.id}/revisions/${second.id}/promote`).send({ expectedActiveRevisionId: first.id }).expect(409);
  });

  it("serializes contract promotion against reviewed acceptance without accepting superseded criteria", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const { milestone, revision: first } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision }));
    await addEvidence(http, milestone.id, first, 0, "primary", "issue_completion", task.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    const second = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision }));
    let acceptance: Promise<request.Response> | undefined;
    let promotion: Promise<request.Response> | undefined;
    await db.transaction(async (tx) => {
      const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`milestone:${company.id}:${milestone.id}`}))`);
      acceptance = http.post(`/api/milestones/${milestone.id}/revisions/${first.id}/decisions`).send(decisionInput(first, reviewed)).then((result) => result);
      promotion = http.post(`/api/milestones/${milestone.id}/revisions/${second.id}/promote`).send({ expectedActiveRevisionId: first.id }).then((result) => result);
      await waitForBlockedMutation(blockerPid, 2);
    });
    expect((await promotion!).status).toBe(200);
    const acceptedStatus = (await acceptance!).status;
    expect([200, 409]).toContain(acceptedStatus);
    const stored = await db.select().from(governanceMilestoneRevisions);
    expect(stored.find((revision) => revision.id === first.id)?.state).toBe("superseded");
    expect(stored.find((revision) => revision.id === second.id)?.state).toBe("active");
    expect((await db.select().from(governanceMilestoneDecisions)).filter((decision) => decision.outcome === "accept")).toHaveLength(acceptedStatus === 200 ? 1 : 0);
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: false, eligible: false, reason: "missing_evidence" });
  });

  it("does not accept freely writable approved work-product fields as a native receipt", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: company.id, issueId: task.id, type: "artifact", provider: "paperclip", title: "Claimed approval",
      status: "approved", reviewState: "approved", metadata: { promotion: { sourceArtifactKind: "work_product", sourceArtifactId: randomUUID() } },
    }).returning();
    const http = request(app());
    const deliverable: MilestoneContractInput["requiredDeliverables"][number] = { key: "work", label: "Accepted work product", evidenceKind: "work_product", reference: { kind: "work_product", workProductId: product!.id, issueId: task.id, productType: "artifact", provider: "paperclip" }, maxAgeHours: 168 };
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, deliverables: [deliverable] }));
    await addEvidence(http, milestone.id, revision, 0, "work", "work_product", product!.id).expect(422);
  });

  it("accepts work-product evidence only when its native promoted receipt and producer are current", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const producer = await createAgent(company.id, "Product producer");
    const reviewer = await createAgent(company.id, "Independent verifier");
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: producer.id, scopeKind: "issue", issueId: task.id, nativeIssueId: task.id,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId: task.id },
    }).returning();
    const source = await workProductService(db).createForIssue(task.id, company.id, {
      type: "pull_request", provider: "paperclip", title: "Produced change", url: "https://example.invalid/change/1",
      status: "ready_for_review", reviewState: "needs_board_review",
      sourceTrust: buildLowTrustSourceTrust({ issueId: task.id, runId: run!.id, agentId: producer.id }), createdByRunId: run!.id,
    });
    expect(source).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    const promotion = await request(app()).post(`/api/issues/${task.id}/low-trust/promotions`).send({
      sourceArtifactKind: "work_product", sourceArtifactId: source!.id, title: "Promoted artifact", summary: "Independently promoted source",
    }).expect(201);
    const promoted = milestoneIdentitySchema.parse(promotion.body);
    const otherSource = await workProductService(db).createForIssue(task.id, company.id, {
      type: "pull_request", provider: "paperclip", title: "Different product in the same class", status: "ready_for_review",
      sourceTrust: buildLowTrustSourceTrust({ issueId: task.id, runId: run!.id, agentId: producer.id }), createdByRunId: run!.id,
    });
    const otherPromotion = milestoneIdentitySchema.parse((await request(app()).post(`/api/issues/${task.id}/low-trust/promotions`).send({
      sourceArtifactKind: "work_product", sourceArtifactId: otherSource!.id, title: "Different promoted artifact", summary: "Not the required product",
    }).expect(201)).body);
    await db.update(issues).set({ assigneeAgentId: producer.id }).where(eq(issues.id, task.id));

    const http = request(app());
    const deliverable: MilestoneContractInput["requiredDeliverables"][number] = { key: "work", label: "Accepted work product", evidenceKind: "work_product", reference: { kind: "work_product", workProductId: source!.id, issueId: task.id, productType: "pull_request", provider: "paperclip" }, maxAgeHours: 168 };
    const { milestone, revision } = await createActive(http, caseRow.id, contract({
      task, playbook, playbookRevision, deliverables: [deliverable], reviewerPolicy: { kind: "independent_internal_agent", agentId: reviewer.id },
    }));
    await addEvidence(http, milestone.id, revision, 0, "work", "work_product", otherPromotion.id).expect(422);
    await addEvidence(http, milestone.id, revision, 0, "work", "work_product", promoted.id).expect(201);
    const currentReadiness = await readiness(http, caseRow.id);
    expect(currentReadiness).toMatchObject({ eligible: true, state: "eligible_for_review" });
    const acceptedResponse = await request(app({ type: "agent", agentId: reviewer.id, companyId: company.id, source: "agent_jwt" }))
      .post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, currentReadiness)).expect(200);
    const accepted = decisionResponseSchema.parse(acceptedResponse.body);
    expect(accepted.decision?.reviewerAgentId).toBe(reviewer.id);
    let patch: Promise<request.Response> | undefined;
    let replay: Promise<request.Response> | undefined;
    try {
      await db.transaction(async (tx) => {
        const [{ pid: blockerPid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
        await tx.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, source!.id)).for("update");
        patch = request(app()).patch(`/api/work-products/${source!.id}`).send({ title: "Changed after promotion", metadata: { contentHash: "changed" } }).then((result) => result);
        await waitForBlockedMutation(blockerPid);
        replay = http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).then((result) => result);
        await waitForBlockedMutation(blockerPid, 2);
      });
    } finally {
      await Promise.allSettled(
        [patch, replay].filter((pending): pending is Promise<request.Response> => pending !== undefined),
      );
    }
    expect((await patch!).status).toBe(200);
    expect((await replay!).status).toBe(200);
    expect(followupReceiptsSchema.parse((await replay!).body)).toEqual(accepted.followups);
    expect(await readiness(http, caseRow.id)).toMatchObject({ accepted: false, state: "accepted_stale", reason: "stale_evidence" });
    await addEvidence(http, milestone.id, revision, 1, "work", "work_product", promoted.id).expect(409);
  });

  it("checks exact verifier identity and actual producer independence, not the evidence submitter", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const executor = await createAgent(company.id, "Executor");
    const producer = await createAgent(company.id, "Document producer");
    const other = await createAgent(company.id, "Other verifier");
    await db.update(issues).set({ assigneeAgentId: executor.id }).where(eq(issues.id, task.id));
    const [document] = await db.insert(documents).values({ companyId: company.id, title: "Product evidence", latestBody: "Evidence" }).returning();
    const [revision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: document!.id, revisionNumber: 1, body: "Evidence", createdByAgentId: producer.id }).returning();
    await db.update(documents).set({ latestRevisionId: revision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, document!.id));
    await db.insert(caseDocuments).values({ companyId: company.id, caseId: caseRow.id, documentId: document!.id, key: "evidence" });
    const http = request(app());
    const deliverable: MilestoneContractInput["requiredDeliverables"][number] = { key: "evidence", label: "Evidence document", evidenceKind: "document_revision", reference: { kind: "document", documentId: document!.id }, maxAgeHours: 168 };
    const { milestone, revision: contractRevision } = await createActive(http, caseRow.id, contract({
      task, playbook, playbookRevision, deliverables: [deliverable], reviewerPolicy: { kind: "independent_internal_agent", agentId: producer.id },
    }));
    await addEvidence(http, milestone.id, contractRevision, 0, "evidence", "document_revision", revision!.id).expect(201);
    const currentReadiness = await readiness(http, caseRow.id);
    await request(app({ type: "agent", agentId: other.id, companyId: company.id, source: "agent_jwt" }))
      .post(`/api/milestones/${milestone.id}/revisions/${contractRevision.id}/decisions`).send(decisionInput(contractRevision, currentReadiness)).expect(403);
    await request(app({ type: "agent", agentId: producer.id, companyId: company.id, source: "agent_jwt" }))
      .post(`/api/milestones/${milestone.id}/revisions/${contractRevision.id}/decisions`).send(decisionInput(contractRevision, currentReadiness)).expect(403);
    expect((await db.select().from(governanceMilestoneDecisions)).length).toBe(0);
  });

  it("rejects quarantined evidence and preserves private case visibility", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const producer = await createAgent(company.id, "Low-trust producer");
    const [document] = await db.insert(documents).values({ companyId: company.id, title: "Quarantined brief", latestBody: "Unreviewed" }).returning();
    const [revision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: document!.id, revisionNumber: 1, body: "Unreviewed", createdByAgentId: producer.id }).returning();
    await db.update(documents).set({ latestRevisionId: revision!.id, latestRevisionNumber: 1, sourceTrust: buildLowTrustSourceTrust({ issueId: task.id, agentId: producer.id }) }).where(eq(documents.id, document!.id));
    await db.insert(caseDocuments).values({ companyId: company.id, caseId: caseRow.id, documentId: document!.id, key: "quarantined" });
    const http = request(app());
    const deliverable: MilestoneContractInput["requiredDeliverables"][number] = { key: "brief", label: "Current brief", evidenceKind: "document_revision", reference: { kind: "document", documentId: document!.id }, maxAgeHours: 168 };
    const { milestone, revision: contractRevision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, deliverables: [deliverable] }));
    await addEvidence(http, milestone.id, contractRevision, 0, "brief", "document_revision", revision!.id).expect(422);

    const outsider = await createAgent(company.id, "No private case access");
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, task.id));
    await db.insert(caseAccessSources).values({ companyId: company.id, caseId: caseRow.id, sourceKind: "issue", sourceId: task.id });
    await request(app({ type: "agent", agentId: outsider.id, companyId: company.id, source: "agent_jwt" }))
      .get(`/api/cases/${caseRow.id}/milestones`).expect(404);
  });

  it("fences mutations from a stopped native run inside the transaction", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const executor = await createAgent(company.id, "Stopped executor");
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: executor.id, scopeKind: "issue", issueId: task.id, nativeIssueId: task.id,
      status: "cancelled", runtimeMode: "native", contextSnapshot: { issueId: task.id },
    }).returning();
    await db.update(issues).set({ assigneeAgentId: executor.id, executionRunId: run!.id, status: "in_progress" }).where(eq(issues.id, task.id));
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision }));
    const stoppedActor: Express.Request["actor"] = { type: "agent", agentId: executor.id, companyId: company.id, runId: run!.id, source: "agent_jwt" };
    await addEvidence(request(app(stoppedActor)), milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(403);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
  });

  it("rolls back acceptance, event, and native task creation together after a database failure", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({
      task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Prepare launch announcement" }],
    }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const currentReadiness = await readiness(http, caseRow.id);
    await db.execute(sql.raw("CREATE FUNCTION fail_milestone_followup_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'follow-up receipt failure'; END $$"));
    await db.execute(sql.raw("CREATE TRIGGER fail_milestone_followup_receipt_test BEFORE INSERT ON governance_milestone_followups FOR EACH ROW EXECUTE FUNCTION fail_milestone_followup_receipt_test()"));

    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, currentReadiness)).expect(500);
    const [storedRevision] = await db.select().from(governanceMilestoneRevisions).where(eq(governanceMilestoneRevisions.id, revision.id));
    expect(storedRevision?.state).toBe("active");
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneEvents)).toHaveLength(0);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);

    await db.execute(sql.raw("DROP TRIGGER fail_milestone_followup_receipt_test ON governance_milestone_followups"));
    await db.execute(sql.raw("DROP FUNCTION fail_milestone_followup_receipt_test()"));
    const accepted = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, currentReadiness)).expect(200)).body);
    const replay = await Promise.all(Array.from({ length: 3 }, () => http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200)));
    for (const result of replay) expect(followupReceiptsSchema.parse(result.body)).toEqual(accepted.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
  });

  it("holds delivery after revocation and preserves the already-created receipt", async () => {
    const { task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({
      task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Prepare launch announcement" }],
    }));
    await addEvidence(http, milestone.id, revision, 0, "primary", "issue_completion", task.id).expect(201);
    const currentReadiness = await readiness(http, caseRow.id);
    const accepted = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, currentReadiness)).expect(200)).body);
    const acceptedReadiness = await readiness(http, caseRow.id);
    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, acceptedReadiness, "revoke")).expect(200);
    const replay = await http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200);
    expect(followupReceiptsSchema.parse(replay.body)).toEqual(accepted.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
    expect((await db.select().from(governanceMilestoneRevisions).where(eq(governanceMilestoneRevisions.id, revision.id)))[0]?.state).toBe("revoked");
  });

  it("preserves superseded acceptance history and holds new delivery while keeping prior effects", async () => {
    const { task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const milestone = await createMilestone(http, caseRow.id);
    const first = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Prepare launch announcement" }] }));
    await promote(http, milestone.id, first.id, null);
    await addEvidence(http, milestone.id, first, 0, "primary", "issue_completion", task.id).expect(201);
    const currentReadiness = await readiness(http, caseRow.id);
    const accepted = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${first.id}/decisions`).send(decisionInput(first, currentReadiness)).expect(200)).body);

    const second = await createDraft(http, milestone.id, contract({ task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Revised announcement" }] }));
    await promote(http, milestone.id, second.id, first.id);
    const replay = await http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200);
    expect(followupReceiptsSchema.parse(replay.body)).toEqual(accepted.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(1);
    expect((await db.select().from(governanceMilestoneRevisions).where(eq(governanceMilestoneRevisions.id, first.id)))[0]?.state).toBe("superseded");
  });

  it("creates a separate logical follow-up for each accepted contract revision and deduplicates each replay", async () => {
    const { task, caseRow, playbook, playbookRevision } = await fixture();
    const http = request(app());
    const value = contract({ task, playbook, playbookRevision, followups: [{ actionKey: "announce", title: "Announcement" }] });
    const { milestone, revision: first } = await createActive(http, caseRow.id, value);
    await addEvidence(http, milestone.id, first, 0, "primary", "issue_completion", task.id).expect(201);
    const firstReady = await readiness(http, caseRow.id);
    const acceptedFirst = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${first.id}/decisions`).send(decisionInput(first, firstReady)).expect(200)).body);
    const second = await createDraft(http, milestone.id, { ...value, title: "New accepted contract" });
    await promote(http, milestone.id, second.id, first.id);
    await addEvidence(http, milestone.id, second, 0, "primary", "issue_completion", task.id).expect(201);
    const secondReady = await readiness(http, caseRow.id);
    const acceptedSecond = decisionResponseSchema.parse((await http.post(`/api/milestones/${milestone.id}/revisions/${second.id}/decisions`).send(decisionInput(second, secondReady)).expect(200)).body);
    expect(acceptedFirst.followups[0]!.issueId).not.toBe(acceptedSecond.followups[0]!.issueId);
    const replays = await Promise.all([acceptedFirst, acceptedSecond, acceptedSecond].map((accepted) => http.post(`/api/milestones/${milestone.id}/followups`).send({ eventId: accepted.event.id }).expect(200)));
    expect(followupReceiptsSchema.parse(replays[0]!.body)).toEqual(acceptedFirst.followups);
    expect(followupReceiptsSchema.parse(replays[1]!.body)).toEqual(acceptedSecond.followups);
    expect(followupReceiptsSchema.parse(replays[2]!.body)).toEqual(acceptedSecond.followups);
    expect(await db.select().from(governanceMilestoneFollowups)).toHaveLength(2);
  });

  it("rejects a different well-formed document UUID at the native resource boundary and stale reviewed snapshots", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const [other] = await db.insert(documents).values({ companyId: company.id, title: "Other document", latestBody: "Other" }).returning();
    const [otherRevision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: other!.id, revisionNumber: 1, body: "Other", createdByUserId: "producer" }).returning();
    await db.update(documents).set({ latestRevisionId: otherRevision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, other!.id));
    await db.insert(caseDocuments).values({ companyId: company.id, caseId: caseRow.id, documentId: other!.id, key: "other" });
    const http = request(app());
    const association = await createMilestone(http, caseRow.id);
    await http.post(`/api/milestones/${association.id}/revisions`).send(contract({ task, playbook, playbookRevision, deliverables: [{
      key: "wrong-resource", label: "A task UUID is not a document", evidenceKind: "document_revision", reference: { kind: "document", documentId: task.id }, maxAgeHours: null,
    }] })).expect(422);
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, deliverables: [{ key: "brief", label: "Exact document", evidenceKind: "document_revision", reference: { kind: "document", documentId: other!.id }, maxAgeHours: null }] }));
    await addEvidence(http, milestone.id, revision, 0, "brief", "document_revision", playbookRevision.id).expect(422);
    await addEvidence(http, milestone.id, revision, 0, "brief", "document_revision", otherRevision!.id).expect(201);
    const reviewed = await readiness(http, caseRow.id);
    await addEvidence(http, milestone.id, revision, 1, "brief", "document_revision", otherRevision!.id).expect(201);
    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, reviewed)).expect(409);
    expect(await db.select().from(governanceMilestoneDecisions)).toHaveLength(0);
  });

  it("prevents board users reviewing their own artifact or user-assigned execution", async () => {
    const { company, task, caseRow, playbook, playbookRevision } = await fixture();
    const [document] = await db.insert(documents).values({ companyId: company.id, title: "Own evidence", latestBody: "Own" }).returning();
    const [documentRevision] = await db.insert(documentRevisions).values({ companyId: company.id, documentId: document!.id, revisionNumber: 1, body: "Own", createdByUserId: boardActor.userId }).returning();
    await db.update(documents).set({ latestRevisionId: documentRevision!.id, latestRevisionNumber: 1 }).where(eq(documents.id, document!.id));
    await db.insert(caseDocuments).values({ companyId: company.id, caseId: caseRow.id, documentId: document!.id, key: "own" });
    const http = request(app());
    const { milestone, revision } = await createActive(http, caseRow.id, contract({ task, playbook, playbookRevision, deliverables: [{ key: "own", label: "Own artifact", evidenceKind: "document_revision", reference: { kind: "document", documentId: document!.id }, maxAgeHours: null }] }));
    await addEvidence(http, milestone.id, revision, 0, "own", "document_revision", documentRevision!.id).expect(201);
    const own = await readiness(http, caseRow.id);
    const history = await http.get(`/api/cases/${caseRow.id}/milestones`).expect(200);
    expect(z.object({ permissions: z.object({ canReview: z.boolean(), canAccept: z.boolean() }) }).parse(history.body).permissions).toEqual({ canReview: false, canAccept: false });
    await http.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, own)).expect(403);
    const otherHttp = request(app({ ...boardActor, userId: "independent-board" }));
    await db.update(issues).set({ assigneeUserId: "independent-board" }).where(eq(issues.id, task.id));
    const assigned = await readiness(otherHttp, caseRow.id);
    await otherHttp.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, assigned)).expect(403);
    await db.update(issues).set({ assigneeUserId: null }).where(eq(issues.id, task.id));
    const independent = await readiness(otherHttp, caseRow.id);
    await otherHttp.post(`/api/milestones/${milestone.id}/revisions/${revision.id}/decisions`).send(decisionInput(revision, independent)).expect(200);
  });

  it("uses opaque same-company lookup and does not gate unrelated API routes", async () => {
    const { caseRow } = await fixture();
    const milestone = await createMilestone(request(app()), caseRow.id);
    const suffix = randomUUID().slice(0, 8);
    const [foreignCompany] = await db.insert(companies).values({ name: "Scoped company", issuePrefix: `SC${suffix}` }).returning();
    const scopedActor: Express.Request["actor"] = {
      type: "board", userId: "scoped-user", source: "session", companyIds: [foreignCompany!.id],
      memberships: [{ companyId: foreignCompany!.id, membershipRole: "admin", status: "active" }],
    };
    await request(app(scopedActor)).get(`/api/cases/${caseRow.id}/milestones`).expect(404);
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    await request(app()).get("/api/unrelated").expect(200, { ok: true });
    await request(app()).get(`/api/cases/${caseRow.id}/milestones`).expect(403);
  });
});

