// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueOneTimeSchedule } from "@paperclipai/shared";
import { IssueOneTimeScheduleCard } from "./IssueOneTimeScheduleCard";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    getOneTimeSchedule: api.get,
    createOneTimeSchedule: api.create,
    cancelOneTimeSchedule: api.cancel,
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const scheduled: IssueOneTimeSchedule = {
  id: "schedule-1",
  issueId: "issue-1",
  agentId: "agent-1",
  dueAt: "2026-10-26T13:00:00.000Z",
  timeZone: "America/New_York",
  status: "scheduled",
  cancellationReason: null,
  wakeupRequestId: null,
  runId: null,
  runStatus: null,
  error: null,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
};

async function waitForUi(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    assertion();
  });
}

function render(canSchedule = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueOneTimeScheduleCard issueId="issue-1" canSchedule={canSchedule} />
      </QueryClientProvider>,
    );
  });
}

function setInput(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!input) throw new Error(`Missing input ${name}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("HTML input value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function click(testId: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`Missing button ${testId}`);
  act(() => button.click());
}

beforeEach(() => {
  api.get.mockReset();
  api.create.mockReset();
  api.cancel.mockReset();
  api.get.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("IssueOneTimeScheduleCard", () => {
  it.each([
    "2026-10-26T09:00:00-04:00",
    new Date("2026-10-26T13:00:00.000Z"),
  ])("shows the persisted zone and normalized UTC text and HTML datetime for %s", async (dueAt) => {
    api.get.mockResolvedValue({ ...scheduled, dueAt });
    render();

    await waitForUi(() => {
      expect(container.textContent).toContain("America/New_York");
      expect(container.textContent).toContain("2026-10-26T13:00:00.000Z");
      expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-26T13:00:00.000Z");
      expect(container.textContent).toContain("Scheduled");
      expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).not.toBeNull();
    });
  });

  it("submits the entered UTC offset and IANA zone without waking the issue at form submission", async () => {
    api.create.mockResolvedValue(scheduled);
    render();

    await waitForUi(() => expect(container.querySelector('[name="dueLocalTime"]')).not.toBeNull());
    setInput("dueLocalTime", "2026-10-26T09:00");
    setInput("utcOffset", "-04:00");
    setInput("timeZone", "America/New_York");
    click("one-time-schedule-create");

    await waitForUi(() => {
      expect(api.create).toHaveBeenCalledWith("issue-1", {
        timestamp: "2026-10-26T09:00-04:00",
        timeZone: "America/New_York",
      });
      expect(container.textContent).toContain("Scheduled");
    });
    expect(api.get).toHaveBeenCalledWith("issue-1");
  });

  it("keeps the form available and reports authoritative timezone validation errors", async () => {
    api.create.mockRejectedValue(new Error("Invalid IANA timezone"));
    render();

    await waitForUi(() => expect(container.querySelector('[name="dueLocalTime"]')).not.toBeNull());
    setInput("dueLocalTime", "2999-12-31T23:00");
    setInput("utcOffset", "+00:00");
    setInput("timeZone", "Mars/Olympus");
    click("one-time-schedule-create");

    await waitForUi(() => {
      expect(container.textContent).toContain("Invalid IANA timezone");
      expect(container.querySelector('[data-testid="one-time-schedule-create"]')).not.toBeNull();
    });
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("cancels a still-scheduled wake and reflects the persisted cancellation reason", async () => {
    api.get.mockResolvedValue(scheduled);
    api.cancel.mockResolvedValue({
      ...scheduled,
      status: "cancelled",
      cancellationReason: "Cancelled by user",
      updatedAt: "2026-10-23T00:05:00.000Z",
    });
    render();

    await waitForUi(() => expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).not.toBeNull());
    click("one-time-schedule-cancel");
    await waitForUi(() => {
      expect(api.cancel).toHaveBeenCalledWith("issue-1", "schedule-1");
      expect(container.textContent).toContain("Cancelled by user");
      expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).toBeNull();
    });
  });

  it("does not offer creation for an issue without an eligible agent assignee", async () => {
    render(false);

    await waitForUi(() => {
      expect(container.textContent).toContain("Assign an eligible agent");
      expect(container.querySelector('[data-testid="one-time-schedule-create"]')).toBeNull();
    });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("shows running state from the native run projection without a second schedule action", async () => {
    api.get.mockResolvedValue({
      ...scheduled,
      status: "running",
      wakeupRequestId: "wake-1",
      runId: "run-1",
      runStatus: "running",
    });
    render();

    await waitForUi(() => {
      expect(container.textContent).toContain("Running");
      expect(container.querySelector('[data-testid="one-time-schedule-cancel"]')).toBeNull();
      expect(container.querySelector('[data-testid="one-time-schedule-create"]')).toBeNull();
    });
  });
});
