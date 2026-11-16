// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueOneTimeSchedule, LiveEvent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueOneTimeScheduleCard } from "../components/IssueOneTimeScheduleCard";
import { queryKeys } from "../lib/queryKeys";
import { DEFAULT_INVALIDATION_INTERVAL_MS } from "../lib/query-invalidation-batcher";

const { getSchedule, pushToast } = vi.hoisted(() => ({ getSchedule: vi.fn(), pushToast: vi.fn() }));
vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1" } }),
}));
vi.mock("./ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ pathname: "/PAP/issues/PAP-204" }) }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "viewer" }, session: { id: "session", userId: "viewer" } }) },
}));
vi.mock("../api/health", () => ({ healthApi: { get: async () => ({ deploymentMode: "authenticated" }) } }));
vi.mock("../api/issues", () => ({ issuesApi: { getOneTimeSchedule: getSchedule } }));
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Socket {
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null;
  constructor() { Socket.instances.push(this); }
  close() { this.readyState = 3; }
}

const scheduled: IssueOneTimeSchedule = {
  id: "schedule-1", issueId: "issue-1", agentId: "agent-1",
  dueAt: "2026-10-26T13:00:00.000Z", timeZone: "America/New_York", status: "scheduled",
  cancellationReason: null, wakeupRequestId: null, runId: null, runStatus: null, error: null,
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
};

describe("connected one-time schedule reader", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    getSchedule.mockReset();
    getSchedule.mockResolvedValue(scheduled);
    pushToast.mockReset();
    Socket.instances = [];
    vi.stubGlobal("WebSocket", Socket);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" }, session: { id: "session", userId: "viewer" } });
    client.setQueryData(queryKeys.health, { deploymentMode: "authenticated" });
    client.setQueryData(queryKeys.issues.detail("PAP-204"), {
      id: "issue-1", companyId: "company-1", identifier: "PAP-204", assigneeAgentId: "agent-1",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connect() {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <LiveUpdatesProvider><IssueOneTimeScheduleCard issueId="issue-1" canSchedule /></LiveUpdatesProvider>
      </QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(Socket.instances).toHaveLength(1);
    await act(async () => Socket.instances[0].onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[data-testid="one-time-schedule-status"]')?.textContent).toContain("Scheduled");
  }

  async function receive(type: LiveEvent["type"], payload: Record<string, unknown>) {
    await act(async () => Socket.instances[0].onmessage!(new MessageEvent("message", {
      data: JSON.stringify({ id: 1, companyId: "company-1", type, createdAt: "2026-10-26T13:00:00.000Z", payload }),
    })));
    await act(async () => vi.advanceTimersByTimeAsync(DEFAULT_INVALIDATION_INTERVAL_MS + 1));
    expect(Socket.instances).toHaveLength(1);
  }

  it("refetches persisted queued, running and failed states on the same visible socket without remount or focus", async () => {
    await connect();
    for (const [status, label, type] of [
      ["queued", "Queued", "heartbeat.run.queued"],
      ["running", "Running", "heartbeat.run.status"],
      ["failed", "Failed", "heartbeat.run.status"],
    ] as const) {
      const response: IssueOneTimeSchedule = {
        ...scheduled, status, wakeupRequestId: "wake-1", runId: "run-1", runStatus: status,
        error: status === "failed" ? "Native run failed" : null,
      };
      getSchedule.mockResolvedValue(response);
      const readsBeforeEvent = getSchedule.mock.calls.length;
      // Native status delivery may omit issueId; the native visible-route owner resolves the assignee.
      await receive(type, { runId: "run-1", agentId: "agent-1", status });
      expect(getSchedule.mock.calls.length).toBeGreaterThan(readsBeforeEvent);
      expect(client.getQueryData(queryKeys.issues.oneTimeSchedule("issue-1"))).toEqual(response);
      expect(container.querySelector('[data-testid="one-time-schedule-status"]')?.textContent).toContain(label);
      expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).toBeNull();
    }
    expect(container.textContent).toContain("Native run failed");
  });

  it.each([
    ["waiting", "Waiting for execution"],
    ["failed", "Failed"],
  ] as const)("refreshes a due %s receipt even when admission creates no run", async (status, label) => {
    await connect();
    getSchedule.mockResolvedValue({ ...scheduled, status, wakeupRequestId: "wake-1", error: "Native admission result" });
    await receive("activity.logged", {
      entityType: "issue", entityId: "issue-1", actorType: "system", actorId: "heartbeat",
      action: "issue.one_time_schedule_updated", details: { scheduleId: "schedule-1" },
    });
    expect(container.querySelector('[data-testid="one-time-schedule-status"]')?.textContent).toContain(label);
    expect(container.textContent).toContain("Native admission result");
    expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).toBeNull();
  });

  it("refreshes cancellation from a reassignment activity even when native conversation refetch is deferred", async () => {
    await connect();
    getSchedule.mockResolvedValue({
      ...scheduled, status: "cancelled", cancellationReason: "Issue assignee changed after scheduling",
    });
    await receive("activity.logged", {
      entityType: "issue", entityId: "issue-1", actorType: "user", actorId: "viewer",
      action: "issue.updated", details: { source: "comment", assigneeAgentId: "replacement-agent" },
    });
    expect(container.querySelector('[data-testid="one-time-schedule-status"]')?.textContent).toContain("Cancelled");
    expect(container.textContent).toContain("Issue assignee changed after scheduling");
    expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).toBeNull();
  });
});
