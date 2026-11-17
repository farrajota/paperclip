import { describe, expect, it } from "vitest";
import { buildConversationNavigationEntries } from "./conversation-navigation";
import type { TaskChatItem, TaskChatMessageItem, TaskChatTurnItem } from "./task-chat-model";

const message = (id: string, text: string): TaskChatItem => ({
  id,
  kind: "message",
  author: "agent",
  text,
});

describe("conversation navigation entries", () => {
  it("indexes messages and meaningful saved-plan, review, and turn summaries only", () => {
    const entries = buildConversationNavigationEntries([
      message("reply", "Decision: keep the adapter contract."),
      { id: "plan", kind: "plan_document", document: { id: "plan", title: "Release plan", body: "Ship after review", latestRevisionNumber: 1 } as never },
      { id: "review", kind: "interaction", interaction: { id: "review", kind: "request_item_verdicts", title: "Review release risks", status: "completed", payload: {} } as never },
      { id: "plan-review", kind: "interaction", interaction: { id: "plan-review", kind: "request_confirmation", title: "Review release plan", status: "completed", payload: { target: { type: "issue_document", key: "plan" } } } as never },
      { id: "turn", kind: "turn", items: [], settled: true, summary: { durationLabel: "38s", toolCount: 2, added: 4, removed: 1 } },
      { id: "noise", kind: "marker", variant: "session_start", label: "Run started" },
    ], true);

    expect(entries.map(({ id, kind }) => [id, kind])).toEqual([
      ["reply", "message"],
      ["plan", "plan"],
      ["review", "review"],
      ["plan-review", "review"],
      ["turn", "turn"],
    ]);
    expect(entries.find((entry) => entry.id === "reply")?.preview).toContain("Decision: keep");
  });

  it("caps previews without mutating authorized source text", () => {
    const text = "A".repeat(500);
    const [entry] = buildConversationNavigationEntries([message("long", text)]);
    expect(entry.preview.length).toBeLessThanOrEqual(180);
    expect(entry.preview).not.toContain(text);
  });

  it("keeps distinct render identity through streaming-to-settled messages", () => {
    const streaming = { ...message("comment-1", "Answer"), renderKey: "stable-comment-1" };
    const [entry] = buildConversationNavigationEntries([streaming]);
    expect(entry.anchorKey).toBe("stable-comment-1");
  });

  it("does not index empty or non-semantic activity rows", () => {
    expect(buildConversationNavigationEntries([
      message("empty", "   "),
      { id: "tool", kind: "tool", name: "Read", status: "completed", target: "src/a.ts" },
      { id: "brief", kind: "brief" },
    ])).toEqual([]);
  });
  it("does not index review content when the renderer would omit it", () => {
    const review = {
      id: "review-hidden",
      kind: "interaction",
      interaction: { id: "review-hidden", kind: "request_item_verdicts", title: "Review risks", status: "completed", payload: {} },
    } as unknown as TaskChatItem;
    expect(buildConversationNavigationEntries([review])).toEqual([]);
    expect(buildConversationNavigationEntries([review], true).map((entry) => entry.id)).toEqual(["review-hidden"]);
  });
  it("indexes an attached folded turn at its stable message anchor", () => {
    const attached: TaskChatMessageItem = {
      id: "comment-2",
      kind: "message",
      author: "agent",
      text: "Decision recorded.",
      renderKey: "stable-comment-2",
      attachedTurn: {
        id: "turn-2",
        kind: "turn",
        items: [],
        settled: true,
        summary: { durationLabel: "12s", toolCount: 1, added: 0, removed: 0 },
      },
    };
    const entries = buildConversationNavigationEntries([attached]);
    expect(entries.map(({ id, kind, anchorKey }) => [id, kind, anchorKey])).toEqual([
      ["comment-2", "message", "stable-comment-2"],
      ["comment-2:turn", "turn", "stable-comment-2"],
    ]);
  });

  describe.each([false, true])("historical summaries (standaloneHeader=%s)", (standaloneHeader) => {
    it.each([false, true])("retains attached and standalone activity without obsolete status (failed=%s)", (failed) => {
      const turn: TaskChatTurnItem = {
        id: "historical-turn", kind: "turn", settled: true, historical: true,
        standaloneHeader, agentName: "Researcher",
        items: [{ id: "tool", kind: "tool", name: "Read", status: "completed", target: "src/a.ts" }],
        summary: { failed, durationLabel: "19s", toolCount: 2, added: 4, removed: 1, tokensLabel: "1k tokens" },
      };
      const reply: TaskChatMessageItem = {
        id: "reply", kind: "message", author: "agent", text: "Saved the useful response.",
        renderKey: "stable-reply", attachedTurn: turn,
      };
      const entries = buildConversationNavigationEntries([reply, turn]);
      expect(entries.map(({ id, anchorKey }) => [id, anchorKey])).toEqual([
        ["reply", "stable-reply"], ["reply:turn", "stable-reply"], ["historical-turn", "historical-turn"],
      ]);
      expect(entries[0].preview).toBe("Saved the useful response.");
      for (const entry of entries.slice(1)) {
        // TaskChatTurn keeps only identity on native timeline headers, and
        // Activity plus metrics on classic folds, in either presentation mode.
        expect(entry.label).toBe(standaloneHeader ? "Researcher" : "Activity");
        expect(entry.preview).toBe(standaloneHeader ? "Researcher" : "Activity · 19s · 2 tools · +4 −1 · 1k tokens");
        expect(`${entry.label} ${entry.preview}`).not.toMatch(/Stopped|Worked|Run failed/);
      }
      expect(turn.summary.failed).toBe(failed);
      expect(reply.text).toBe("Saved the useful response.");
    });

    it("does not recreate a suppressed header from failure or metrics alone", () => {
      const turn: TaskChatTurnItem = {
        id: "status-only", kind: "turn", settled: true, historical: true, standaloneHeader,
        items: [], summary: { failed: true, durationLabel: "19s", toolCount: 0, added: 0, removed: 0 },
      };
      const reply: TaskChatMessageItem = {
        id: "reply", kind: "message", author: "agent", text: "Keep this reply.", attachedTurn: turn,
      };
      const entries = buildConversationNavigationEntries([turn, reply]);
      expect(entries.map((entry) => entry.id)).toEqual(["reply"]);
      expect(entries[0].preview).toBe("Keep this reply.");
    });
  });

  it("retains historical folded activity even when summary metrics are unavailable", () => {
    const [entry] = buildConversationNavigationEntries([{
      id: "activity", kind: "turn", settled: true, historical: true,
      items: [{ id: "note", kind: "message", author: "agent", text: "Inspected the source." }],
      summary: { toolCount: 0, added: 0, removed: 0 },
    }]);
    expect(entry).toMatchObject({ id: "activity", kind: "turn", label: "Activity", preview: "Activity" });
  });

  it("does not invent a historical fold header for persistent runtime receipts", () => {
    expect(buildConversationNavigationEntries([{
      id: "receipt-turn", kind: "turn", settled: true, historical: true,
      items: [{
        id: "receipt", kind: "protocol", surface: "runtime_request", runId: "run", requestId: "request",
        requestKind: "permission_approval", turnId: null, requestType: "permission", status: "resolved",
        prompt: "Read approved", choices: [], fields: [],
      }],
      summary: { failed: true, durationLabel: "19s", toolCount: 0, added: 0, removed: 0 },
    }])).toEqual([]);
  });

  it.each([false, true])("retains current execution status when it is not historical (failed=%s)", (failed) => {
    const [entry] = buildConversationNavigationEntries([{
      id: "current-turn", kind: "turn", settled: true, items: [],
      summary: { failed, durationLabel: "19s", toolCount: 0, added: 0, removed: 0 },
    }]);
    expect(entry.label).toBe(failed ? "Stopped" : "Worked");
    expect(entry.preview).toBe(`${failed ? "Stopped" : "Worked"} · 19s`);
  });
});
