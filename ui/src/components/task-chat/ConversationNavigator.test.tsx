// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationNavigator } from "./ConversationNavigator";
import type { ConversationNavigationEntry } from "./conversation-navigation";

const entry: ConversationNavigationEntry = {
  id: "message-1",
  domId: "comment-message-1",
  anchorKey: "stable-message-1",
  kind: "message",
  label: "Agent",
  preview: "Keep the native adapter contract.",
};

describe("ConversationNavigator", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("previews on hover without activating or changing reading state", () => {
    const onActivate = vi.fn(async () => true);
    const onHighlight = vi.fn();
    act(() => root.render(
      <ConversationNavigator entries={[entry]} historyPartial onHighlight={onHighlight} onActivate={onActivate} />,
    ));
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.textContent).toContain(entry.preview);
    expect(container.textContent).toContain("Loaded history only");
    expect(onHighlight).toHaveBeenCalledWith(expect.objectContaining({ anchorKey: entry.anchorKey }));
    expect(onActivate).not.toHaveBeenCalled();
  });
  it("renders the stationary preview outside the overflow-scrolling rail", () => {
    act(() => root.render(
      <ConversationNavigator entries={[entry]} historyPartial={false} onHighlight={vi.fn()} onActivate={vi.fn(async () => false)} />,
    ));
    const rail = container.querySelector("nav[aria-label='Conversation navigation']")!;
    act(() => rail.querySelector("button")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const preview = container.querySelector('[data-testid="conversation-navigation-preview"]')!;
    expect(rail.className).toContain("overflow-x-auto");
    expect(rail.className).toContain("md:overflow-y-auto");
    expect(rail.contains(preview)).toBe(false);
    expect(preview.parentElement).toBe(rail.parentElement);
  });

  it("reports a missing landing instead of announcing success", async () => {
    const onActivate = vi.fn(async () => false);
    act(() => root.render(
      <ConversationNavigator entries={[entry]} historyPartial={false} onHighlight={vi.fn()} onActivate={onActivate} />,
    ));
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.textContent).toContain("This conversation entry is no longer available.");
    expect(container.textContent).not.toContain("Opened Agent");
  });
  it("previews on keyboard focus, refreshes redacted text, and labels coverage", () => {
    act(() => root.render(
      <ConversationNavigator entries={[entry]} historyPartial onHighlight={vi.fn()} onActivate={vi.fn(async () => true)} />,
    ));
    const button = container.querySelector("button")!;
    act(() => button.focus());
    expect(container.textContent).toContain(entry.preview);
    expect(button.className).toContain("size-8");
    expect(container.textContent).toContain("Loaded");
    act(() => root.render(
      <ConversationNavigator entries={[{ ...entry, preview: "[redacted]" }]} historyPartial={false} onHighlight={vi.fn()} onActivate={vi.fn(async () => true)} />,
    ));
    expect(container.textContent).not.toContain(entry.preview);
    expect(container.textContent).toContain("[redacted]");
    expect(container.textContent).toContain("All");
  });
});
