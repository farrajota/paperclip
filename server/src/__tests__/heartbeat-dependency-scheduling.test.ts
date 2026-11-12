import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, mergeCoalescedContextSnapshot } from "../services/heartbeat.ts";
import { legacyDispositionFingerprint } from "../services/recovery/legacy-continuation.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

// Scoped to one run: a follow-up run of the same agent may reach the adapter
// before a test reads the count.
function adapterCallsForRun(runId: string) {
  return (mockAdapterExecute.mock.calls as unknown as Array<[{ runId?: string } | undefined]>)
    .filter(([input]) => input?.runId === runId).length;
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("dispatches and coalesces durable native status wake intents into one heartbeat run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume after native child completion",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    const nativeWakePayload = {
      issueId,
      taskId: issueId,
      _paperclipWakeContext: {
        issueId,
        taskId: issueId,
        source: "native_status_decision",
      },
    };
    const intents = await db.insert(agentWakeupRequests).values([
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_children_completed",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-parent:${issueId}`,
      },
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-dependency:${issueId}`,
      },
    ]).returning({ id: agentWakeupRequests.id });

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 2, dispatched: 1, recovered: 1 });

    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const dispatchedRequests = await db.select().from(agentWakeupRequests).where(
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`,
    );
    expect(dispatchedRequests).toHaveLength(1);
    const dispatchedRun = runs.find((run) => run.id === dispatchedRequests[0]!.runId);
    expect(dispatchedRun).toMatchObject({
      status: "succeeded",
      agentId,
      contextSnapshot: {
        source: "native_status_decision",
        statusDecisionSource: "native_status_decision",
      },
    });

    const persistedIntents = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, intents.map((intent) => intent.id)));
    expect(persistedIntents).toHaveLength(2);
    expect(persistedIntents).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
    ]));
    expect(dispatchedRequests[0]).toMatchObject({ runId: dispatchedRun!.id });
  });

  it.each(["onboarding", "ordinary", "cancelled"])("dispatches only a verified completed onboarding report: %s", async kind => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), childId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Parent", status: kind === "cancelled" ? "cancelled" : "done",
      originKind: kind === "ordinary" ? "manual" : "onboarding_first_task", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    await db.insert(issues).values({ id: childId, companyId, title: "Saved result", parentId: issueId, status: "done", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_children_completed",
      requestedByActorType: "system", requestedByActorId: "native-status-committer", idempotencyKey: `onboarding-completed:${issueId}`,
      payload: { issueId, _paperclipWakeContext: { issueId, completedChildIssueId: childId, onboardingCompletion: true } } });
    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result.dispatched).toBe(kind === "onboarding" ? 1 : 0);
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(kind === "onboarding" ? 1 : 0);
    if (kind === "onboarding") {
      expect({ status: runs[0].status, errorCode: runs[0].errorCode, error: runs[0].error })
        .toEqual({ status: "succeeded", errorCode: null, error: null });
      expect(runs[0].contextSnapshot).toMatchObject({
        onboardingCompletion: true, chatCompletionUpdates: [expect.objectContaining({ id: childId, status: "done" })],
      });
      expect(mockAdapterExecute).toHaveBeenCalledOnce();
    }
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe(kind === "cancelled" ? "cancelled" : "done");
  });

  it("coalesces the native intent when dispatch admission defers behind an active issue run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native wake behind active run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      executionRunId: activeRunId,
      executionLockedAt: new Date(),
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: activeRunId,
      evidence: { runId: activeRunId },
      nextAction: "Wait for the active execution to stop.",
    });
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-race:${issueId}`,
    }).returning();

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, deferred: 1 });

    const rows = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(rows.find((row) => row.id === intent!.id)).toMatchObject({
      status: "coalesced",
      runId: null,
    });
    expect(rows.filter((row) => row.status === "deferred_issue_execution")).toHaveLength(1);
    expect(rows.filter((row) => row.requestedByActorId?.startsWith("native-status-wake-dispatch:"))).toHaveLength(1);

    // Simulate the process crash window after the dispatch receipt was written
    // but before the committer intent was reconciled.
    await db.update(agentWakeupRequests).set({ status: "queued", updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    const recovered = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(recovered).toMatchObject({ scanned: 1, recovered: 1 });
    const recoveredIntent = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id))
      .then((result) => result[0]);
    expect(recoveredIntent).toMatchObject({ status: "coalesced" });
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId: blockedIssueId,
      authorType: "user", authorUserId: "responsible-user",
      body: "Explain the current dependency without starting blocked work.",
    });
    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, interactionWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  it("defers issue_blockers_resolved as a follow-up when the same issue is already running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "manual_test_active_run",
      },
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Completed prerequisite",
        status: "done",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    runningProcesses.set(activeRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerId}`;
    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });

    expect(wake).toBeNull();

    const wakeRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    expect(wakeRequests).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        idempotencyKey,
        runId: null,
      }),
    ]);

    runningProcesses.delete(activeRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activeRunId));
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  async function seedManagerParentWithCancelledChildBlocker() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "manager",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Managed parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: managerId,
        responsibleUserId: "responsible-user",
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Specialist child",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
      },
    ]);
    // The manager made its own child a blocker of the parent as well.
    await db.insert(issueRelations).values({
      companyId,
      issueId: childId,
      relatedIssueId: parentId,
      type: "blocks",
    });
    return { companyId, managerId, parentId, childId };
  }

  // Every run that carries this child's completion wake for the parent,
  // including one it was coalesced into.
  function childCompletionRunIds(parentId: string, childId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${parentId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'completedChildIssueId' = ${childId}`,
        ),
      )
      .then((rows) => rows.map((row) => row.id));
  }

  function childrenCompletedContext(parentId: string, childId: string) {
    return {
      issueId: parentId,
      taskId: parentId,
      wakeReason: "issue_children_completed",
      source: "issue.children_completed",
      completedChildIssueId: childId,
      childIssueIds: [childId],
    };
  }

  it("delivers issue_children_completed to the manager when a cancelled direct child also blocks the parent", async () => {
    const { managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();

    const wake = await heartbeat.wakeup(managerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: parentId, completedChildIssueId: childId, childIssueIds: [childId] },
      contextSnapshot: childrenCompletedContext(parentId, childId),
    });
    expect(wake).not.toBeNull();

    const dispatched = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    }, 10_000);
    expect(dispatched).toBe(true);
    expect(mockAdapterExecute).toHaveBeenCalled();

    const wakeRequests = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, managerId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${parentId}`,
        ),
      );
    expect(wakeRequests.map((row) => row.reason)).toEqual(["issue_children_completed"]);
    expect(wakeRequests[0]?.status).not.toBe("skipped");

    // The cancelled blocker is still unresolved for the parent itself: the
    // wake must not check the parent out or move it out of `blocked`.
    const parent = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, parentId))
      .then((rows) => rows[0] ?? null);
    expect(parent).toMatchObject({ status: "blocked", checkoutRunId: null });
  });

  it("keeps a cancelled non-child blocker gating the parent's issue_children_completed wake", async () => {
    const { companyId, managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();
    const outsiderId = randomUUID();
    await db.insert(issues).values({
      id: outsiderId,
      companyId,
      title: "Unrelated prerequisite",
      status: "cancelled",
      priority: "medium",
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: outsiderId,
      relatedIssueId: parentId,
      type: "blocks",
    });

    const wake = await heartbeat.wakeup(managerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: parentId, completedChildIssueId: childId, childIssueIds: [childId] },
      contextSnapshot: childrenCompletedContext(parentId, childId),
    });
    expect(wake).toBeNull();

    const wakeRequest = await db
      .select({
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, managerId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${parentId}`,
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeRequest).toMatchObject({
      reason: "issue_dependencies_blocked",
      status: "skipped",
      payload: expect.objectContaining({ unresolvedBlockerIssueIds: [outsiderId] }),
    });
    const parentRuns = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${parentId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(parentRuns).toBe(0);
  });

  it("keeps a cancelled direct child blocker gating the parent's other wakes", async () => {
    const { managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();

    const wake = await heartbeat.wakeup(managerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: parentId, resolvedBlockerIssueId: childId },
      contextSnapshot: {
        issueId: parentId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: childId,
      },
    });
    expect(wake).toBeNull();

    const wakeRequest = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, managerId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${parentId}`,
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(wakeRequest).toMatchObject({ reason: "issue_dependencies_blocked", status: "skipped" });
  });

  it("claims a queued issue_children_completed run when its only blocker is a cancelled direct child", async () => {
    const { companyId, managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: managerId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: parentId, completedChildIssueId: childId, childIssueIds: [childId] },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: childrenCompletedContext(parentId, childId),
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    const settled = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded" || run?.status === "cancelled";
    }, 10_000);
    expect(settled).toBe(true);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(run?.errorCode).not.toBe("issue_dependencies_blocked");
  });

  it("runs the manager once when the child-completion wake is coalesced into a scheduled disposition repair", async () => {
    const { companyId, managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();
    // The successful manager run that recovery is repairing, and the repair it
    // scheduled before the operator cancelled the child (demo 4B, 2026-11-12).
    const sourceRunId = randomUUID();
    const episode = { id: randomUUID(), attempt: 1, maxAttempts: 2 };
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "succeeded",
      runtimeMode: "legacy",
      finishedAt: new Date(),
      contextSnapshot: { issueId: parentId, legacyDispositionEpisode: episode },
    });
    const repairRunId = randomUUID();
    const repairWakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: repairWakeupRequestId,
      companyId,
      agentId: managerId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_disposition_repair",
      payload: { issueId: parentId },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: repairRunId,
      wakeupRequestId: repairWakeupRequestId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      runtimeMode: "legacy",
      retryOfRunId: sourceRunId,
      scheduledRetryAt: new Date(Date.now() - 1_000),
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "issue_disposition_repair",
      contextSnapshot: {
        ...childrenCompletedContext(parentId, childId),
        retryReason: "issue_disposition_repair",
        retryOfRunId: sourceRunId,
        dispositionRepairSourceRunId: sourceRunId,
        dispositionRepairAttempt: 2,
        dispositionRepairFingerprint: legacyDispositionFingerprint(companyId, parentId, managerId, episode.id),
        legacyDispositionEpisode: { ...episode, attempt: 2 },
      },
    });

    await db
      .update(agentWakeupRequests)
      .set({ runId: repairRunId })
      .where(eq(agentWakeupRequests.id, repairWakeupRequestId));

    const promoted = await heartbeat.promoteDueScheduledRetries(new Date());
    expect(promoted.runIds).toContain(repairRunId);
    await heartbeat.resumeQueuedRuns();

    const settled = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, repairRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded" || run?.status === "cancelled";
    }, 10_000);
    expect(settled).toBe(true);
    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, repairRunId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "succeeded" });
    expect(adapterCallsForRun(repairRunId)).toBe(1);
    expect(await childCompletionRunIds(parentId, childId)).toEqual([repairRunId]);
  });

  it("claims a queued child-completion run after a later wake was coalesced into it", async () => {
    const { companyId, managerId, parentId, childId } = await seedManagerParentWithCancelledChildBlocker();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: managerId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: parentId, completedChildIssueId: childId, childIssueIds: [childId] },
      status: "queued",
    });
    // Coalescing keeps only the latest wakeReason; the child-completion
    // fields of the earlier wake stay in the context.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: mergeCoalescedContextSnapshot(childrenCompletedContext(parentId, childId), {
        issueId: parentId,
        taskId: parentId,
        wakeReason: "issue_status_changed",
        source: "issue.status_changed",
      }),
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    const settled = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded" || run?.status === "cancelled";
    }, 10_000);
    expect(settled).toBe(true);
    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "succeeded" });
  });

  it("runs a reserved repair once when its parent's child became live, then delivers the child-completion wake", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const specialistId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Manager",
        role: "manager",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: specialistId,
        companyId,
        name: "Specialist",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Managed parent",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: managerId,
        responsibleUserId: "responsible-user",
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Specialist child",
        status: "todo",
        priority: "medium",
        assigneeAgentId: specialistId,
        responsibleUserId: "responsible-user",
      },
    ]);
    // The repair was reserved while the child was parked; the child has
    // since become live again through a queued wake of its own.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: specialistId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: childId },
      status: "queued",
      requestedByActorType: "system",
    });
    const sourceRunId = randomUUID();
    const episode = { id: randomUUID(), attempt: 1, maxAttempts: 2 };
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "succeeded",
      runtimeMode: "legacy",
      finishedAt: new Date(),
      contextSnapshot: { issueId: parentId, legacyDispositionEpisode: episode },
    });
    const repairRunId = randomUUID();
    const repairWakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: repairWakeupRequestId,
      companyId,
      agentId: managerId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_disposition_repair",
      payload: { issueId: parentId },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: repairRunId,
      wakeupRequestId: repairWakeupRequestId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      runtimeMode: "legacy",
      retryOfRunId: sourceRunId,
      scheduledRetryAt: new Date(Date.now() - 1_000),
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "issue_disposition_repair",
      contextSnapshot: {
        issueId: parentId,
        taskId: parentId,
        wakeReason: "issue_disposition_repair",
        retryReason: "issue_disposition_repair",
        retryOfRunId: sourceRunId,
        dispositionRepairSourceRunId: sourceRunId,
        dispositionRepairAttempt: 2,
        dispositionRepairFingerprint: legacyDispositionFingerprint(companyId, parentId, managerId, episode.id),
        legacyDispositionEpisode: { ...episode, attempt: 2 },
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: repairRunId })
      .where(eq(agentWakeupRequests.id, repairWakeupRequestId));

    await heartbeat.promoteDueScheduledRetries(new Date());
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, repairRunId))
        .then((rows) => rows[0] ?? null);
      return ["succeeded", "cancelled", "failed"].includes(run?.status ?? "");
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(repairRunId);
    const repair = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, repairRunId))
      .then((rows) => rows[0] ?? null);
    expect(repair).toMatchObject({ status: "succeeded" });

    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    const activeActions = await db
      .select({ kind: issueRecoveryActions.kind, cause: issueRecoveryActions.cause })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.sourceIssueId, parentId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      );
    expect(activeActions).toEqual([]);

    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${childId}`);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childId));
    const wake = await heartbeat.wakeup(managerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: parentId, completedChildIssueId: childId, childIssueIds: [childId] },
      contextSnapshot: childrenCompletedContext(parentId, childId),
    });
    expect(wake).not.toBeNull();
    const delivered = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    }, 10_000);
    expect(delivered).toBe(true);
    expect(adapterCallsForRun(wake!.id)).toBe(1);
    expect(await childCompletionRunIds(parentId, childId)).toEqual([wake!.id]);
  });
});
