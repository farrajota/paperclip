import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { useMobileVisualViewport } from "@/hooks/useMobileVisualViewport";

function StreamingResponse({ running, navigationContainer }: { running: boolean; navigationContainer: HTMLElement | null }) {
  const [lines, setLines] = useState(16);
  useEffect(() => {
    if (!running || lines >= 256) return;
    const timer = window.setTimeout(() => setLines(lines + 1), 500);
    return () => window.clearTimeout(timer);
  }, [running, lines]);
  return <TaskChatThreadView navigationHistoryPartial={false} navigationContainer={navigationContainer} items={[
    { id: "request", kind: "message", author: "human", text: "Give me a detailed progress report as you work." },
    {
      id: "response", kind: "message", author: "agent", authorName: "Researcher", streaming: running,
      text: Array.from({ length: lines }, (_, index) => `Update ${index + 1}: I checked the next section and recorded the results for the final report.`).join("\n\n"),
    },
  ]} />;
}

function MobileFollow() {
  const [running, setRunning] = useState(true);
  const viewportRef = useMobileVisualViewport(true);
  const [navigationContainer, setNavigationContainer] = useState<HTMLDivElement | null>(null);
  return <div ref={viewportRef} data-mobile="true" className="paperclip-app-shell flex min-h-dvh flex-col bg-background text-foreground">
    <div className="app-main-row"><div className="app-content-column flex flex-col">
    <header className="app-breadcrumb flex h-12 shrink-0 items-center px-4 text-sm font-medium">iOS layout — focus-scroll correction</header>
    <div className="app-content-row"><main id="main-content" className="flex flex-1 flex-col p-4">
      <div data-task-chat-shell="" data-testid="task-chat-thread" className="-mx-4 flex min-h-0 flex-1 flex-col">
        <StreamingResponse running={running} navigationContainer={navigationContainer} />
        <TaskChatComposerDock mobile streamlined={false} navigationRef={setNavigationContainer}>
          <TaskChatComposer mobile workMode="standard" onAdd={async () => setRunning(true)}
            onStop={running ? async () => setRunning(false) : undefined} />
        </TaskChatComposerDock>
      </div>
    </main></div></div></div>
    <MobileBottomNav visible />
  </div>;
}

const meta = {
  id: "task-chat-mobile-streaming-follow",
  title: "Tasks and conversations/Task creation and lifecycle/Task chat/Mobile streaming follow",
  component: MobileFollow,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Controlled output in the production thread and composer. At the bottom, updates stay visible. Scroll up to hold your reading position, then return to the bottom to resume following. Stop pauses the fixture; send a message to resume. No agent or provider calls." } },
    paperclip: {
      "capabilities": [
        "tasks/discussion"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production mobile viewport sizing, message scroller, and composer with bounded synthetic streaming. Physical iPhone keyboard acceptance is required."
    },
  },
  globals: { theme: "light", viewport: { value: "mobile", isRotated: false } },
} satisfies Meta<typeof MobileFollow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Streaming: Story = {};

export const NarrowNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = canvasElement.ownerDocument;
    const viewport = doc.defaultView!;
    await expect(viewport.innerWidth).toBeLessThan(768);
    await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
    const editor = await canvas.findByRole("textbox", { name: "editable markdown" });
    const dock = canvas.getByTestId("task-chat-composer-dock");
    const rail = await canvas.findByRole("navigation", { name: "Conversation navigation" });
    const button = within(rail).getByRole("button", { name: "Message: Researcher" });
    const shell = canvasElement.querySelector("main")!;
    const originalOffset = shell.style.getPropertyValue("--tc-composer-bottom");
    const originalEditorHeight = editor.getBoundingClientRect().height;
    const checkLayout = async () => {
      await waitFor(() => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        expect(bounds.width).toBeGreaterThan(0);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(viewport.innerWidth);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(viewport.innerHeight);
        expect(button.contains(doc.elementFromPoint(x, y))).toBe(true);
        expect(rail.getBoundingClientRect().bottom).toBeLessThanOrEqual(editor.getBoundingClientRect().top);
      });
      const dockHeight = dock.getBoundingClientRect().height;
      const readingPosition = viewport.scrollY;
      button.focus({ preventScroll: true });
      const preview = await canvas.findByTestId("conversation-navigation-preview");
      await waitFor(() => {
        const bounds = preview.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(rail.getBoundingClientRect().top);
        expect(preview.contains(doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
        expect(dock.getBoundingClientRect().height).toBe(dockHeight);
        expect(viewport.scrollY).toBe(readingPosition);
      });
      // Unlike target-directed userEvent alone, the preceding browser hit test
      // rejects an editor layered over this button. Main still owns real taps.
      await userEvent.click(button);
      await waitFor(() => expect(dock.querySelector('[aria-live="polite"]')).toHaveTextContent("Opened Researcher."));
    };
    try {
      for (const grown of [false, true]) {
        if (grown) {
          await userEvent.type(editor, "A growing native composer draft. ".repeat(30));
          await waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(originalEditorHeight));
        }
        for (const offset of ["--tc-composer-visible-nav-offset", "--tc-composer-hidden-nav-offset"]) {
          shell.style.setProperty("--tc-composer-bottom", `var(${offset})`);
          await checkLayout();
        }
      }
    } finally {
      shell.style.setProperty("--tc-composer-bottom", originalOffset);
    }
  },
};
