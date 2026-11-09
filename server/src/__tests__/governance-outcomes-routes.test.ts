import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { governanceOutcomeRoutes } from "../routes/governance-outcomes.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), createTarget: vi.fn(), addObservation: vi.fn(), addCheckin: vi.fn(), goal: vi.fn(),
}));
vi.mock("../services/governance-outcomes.js", () => ({ governanceOutcomeService: () => mocks }));
vi.mock("../services/goals.js", () => ({ goalService: () => ({ getById: mocks.goal }) }));

const targetBody = {
  expectedRevision: 0,
  period: { label: "October 2026", timezone: "America/New_York", intervalStart: "2026-10-01T04:00:00.000Z", intervalEnd: "2026-11-01T04:00:00.000Z", lifecycle: "active" },
  metricKey: "retention", kind: "percentage", unit: "%", direction: "increase", aggregation: "latest",
  population: "eligible accounts", source: "manual", queryVersion: "v1", freshnessHours: 72, maturityHours: 24,
  baselineValue: 20, targetValue: 35, guardrails: [], trajectory: [],
};

function appFor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { actor }); next(); });
  app.use("/api", governanceOutcomeRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

const board = { type: "board", userId: "board-user", source: "session", companyIds: ["company-1"], isInstanceAdmin: false };
const agent = { type: "agent", agentId: "agent-1", source: "agent_key", companyId: "company-1", companyIds: ["company-1"], runId: "00000000-0000-4000-8000-000000000002", keyId: "00000000-0000-4000-8000-000000000003", keyScope: { issueId: "00000000-0000-4000-8000-000000000004" } };

describe("goal outcome routes authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.goal.mockResolvedValue({ id: "goal-1", companyId: "company-1" });
    mocks.read.mockResolvedValue({ periods: [], targets: [], observations: [], checkins: [], outcomes: [] });
    mocks.createTarget.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000010", revision: 1 });
    mocks.addObservation.mockResolvedValue({ observation: { id: "observation-1" }, reused: false });
  });

  it("requires a board actor before target revisions can be approved", async () => {
    const response = await request(appFor(agent)).post("/api/goals/goal-1/outcomes/targets").send(targetBody);
    expect(response.status).toBe(403);
    expect(mocks.createTarget).not.toHaveBeenCalled();
  });

  it("exposes target approval only to current writable board members", async () => {
    const membership = { companyId: "company-1", status: "active", membershipRole: "member" };
    const response = await request(appFor({ ...board, memberships: [membership] })).get("/api/goals/goal-1/outcomes");
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toMatchObject({ canApproveTargets: true, canCheckin: true });
  });

  it("does not disclose an inaccessible company's outcome ledger", async () => {
    mocks.goal.mockResolvedValue({ id: "goal-1", companyId: "company-2" });
    const response = await request(appFor(board)).get("/api/goals/goal-1/outcomes");
    expect(response.status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("uses valid resource identifiers so company denial reaches the authorization branch", async () => {
    const response = await request(appFor({ ...board, companyIds: ["company-2"] })).post("/api/goals/goal-1/outcomes/observations").send({
      targetId: "00000000-0000-4000-8000-000000000001", source: "manual", sourceRevision: "v1", sourceKey: "snapshot-1", value: 1, unit: "%", population: "eligible accounts",
      windowStart: "2026-10-01T04:00:00.000Z", windowEnd: "2026-10-02T04:00:00.000Z", observedAt: "2026-10-01T12:00:00.000Z", availableAt: "2026-10-02T04:00:00.000Z",
    });
    expect(response.status).toBe(404);
    expect(mocks.addObservation).not.toHaveBeenCalled();
  });

  it("keeps a viewer's ledger readable without offering any mutations", async () => {
    const viewer = { ...board, memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }] };
    const response = await request(appFor(viewer)).get("/api/goals/goal-1/outcomes");
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toEqual({ canApproveTargets: false, canCheckin: false, observationTargetIds: [], explanation: "Viewer access is read-only" });
    const denied = await request(appFor(viewer)).post("/api/goals/goal-1/outcomes/targets").send(targetBody);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Viewer access is read-only");
    expect(mocks.createTarget).not.toHaveBeenCalled();
  });

  it("limits an agent's observation controls to explicitly owned targets and never offers policy approval", async () => {
    mocks.read.mockResolvedValue({ periods: [], targets: [{ id: "owned", ownerAgentId: agent.agentId }, { id: "other", ownerAgentId: "another-agent" }], observations: [], checkins: [], outcomes: [] });
    const response = await request(appFor(agent)).get("/api/goals/goal-1/outcomes");
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toMatchObject({ canApproveTargets: false, canCheckin: true, observationTargetIds: ["owned"] });
  });

  it.each(["observations", "checkins"])("rejects viewer %s submissions despite readable history", async (resource) => {
    const viewer = { ...board, memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }] };
    const input = resource === "observations" ? {
      targetId: "00000000-0000-4000-8000-000000000001", source: "manual", sourceRevision: "v1", sourceKey: "snapshot-1", value: 1, unit: "%", population: "eligible accounts",
      windowStart: "2026-10-01T04:00:00.000Z", windowEnd: "2026-10-02T04:00:00.000Z", observedAt: "2026-10-01T12:00:00.000Z", availableAt: "2026-10-02T04:00:00.000Z",
    } : { targetId: "00000000-0000-4000-8000-000000000001", health: "unknown", evidence: "No mature sample", uncertainty: "High", nextReviewAt: "2026-10-30T00:00:00.000Z" };
    const response = await request(appFor(viewer)).post(`/api/goals/goal-1/outcomes/${resource}`).send(input);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Viewer access is read-only");
    expect(mocks.addObservation).not.toHaveBeenCalled();
    expect(mocks.addCheckin).not.toHaveBeenCalled();
  });

  it("returns idempotent correction replays as successful reuse", async () => {
    mocks.addObservation.mockResolvedValue({ observation: { id: "observation-1" }, reused: true });
    const response = await request(appFor(board)).post("/api/goals/goal-1/outcomes/observations/corrections").send({
      targetId: "00000000-0000-4000-8000-000000000001", source: "manual", sourceRevision: "v1", sourceKey: "correction-1", value: 1, unit: "%", population: "eligible accounts",
      windowStart: "2026-10-01T04:00:00.000Z", windowEnd: "2026-10-02T04:00:00.000Z", observedAt: "2026-10-01T12:00:00.000Z", availableAt: "2026-10-02T04:00:00.000Z",
      supersedesId: "00000000-0000-4000-8000-000000000005", correctionReason: "Corrected source", 
    });
    expect(response.status).toBe(200);
    expect(response.body.reused).toBe(true);
  });
});
