import type { TaskChatItem, TaskChatTurnItem } from "./task-chat-model";

export const CONVERSATION_NAVIGATION_PREVIEW_LIMIT = 180;
const CONVERSATION_NAVIGATION_SOURCE_SCAN_LIMIT = 1024;

export interface ConversationNavigationEntry {
  id: string;
  domId: string;
  anchorKey: string;
  kind: "message" | "plan" | "review" | "turn";
  label: string;
  preview: string;
}

function plaintext(value: string): string {
  return value
    .replace(/```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[#>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capped(value: string): string {
  const excerpt = value.slice(0, CONVERSATION_NAVIGATION_SOURCE_SCAN_LIMIT);
  const text = plaintext(excerpt);
  if (text.length <= CONVERSATION_NAVIGATION_PREVIEW_LIMIT && excerpt.length === value.length) return text;
  return `${text.slice(0, CONVERSATION_NAVIGATION_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

function reviewLabel(item: Extract<TaskChatItem, { kind: "interaction" }>): string | null {
  const interaction = item.interaction;
  if (interaction.kind === "request_item_verdicts") return interaction.title ?? "Review";
  if (interaction.kind === "request_confirmation") {
    const target = interaction.payload.target;
    if (target?.type !== "issue_document") return null;
    return target.key === "plan" ? interaction.title ?? "Plan review" : null;
  }
  return null;
}

function turnEntry(
  item: TaskChatTurnItem,
  id: string,
  anchorKey: string,
  domId: string,
): ConversationNavigationEntry | null {
  // Match TaskChatTurn: historical timelines retain identity only; historical
  // folds retain Activity only when there are children behind the disclosure.
  // Raw summary.failed remains in the projection but is no longer a status.
  if (item.historical && item.standaloneHeader) {
    const label = item.agentName;
    return label ? { id, domId, anchorKey, kind: "turn", label, preview: capped(label) } : null;
  }
  const meaningful = item.historical
    ? item.settled && item.items.some((child) => child.kind !== "protocol" || child.surface !== "runtime_request")
    : item.summary.failed || item.summary.toolCount > 0 || item.summary.added > 0 || item.summary.removed > 0 || Boolean(item.summary.durationLabel || item.summary.tokensLabel);
  if (!meaningful) return null;
  const label = item.historical ? "Activity" : item.summary.failed ? "Stopped" : "Worked";
  const metrics = [
    item.summary.durationLabel,
    item.summary.toolCount > 0 ? `${item.summary.toolCount} tools` : "",
    item.summary.added > 0 || item.summary.removed > 0 ? `+${item.summary.added} −${item.summary.removed}` : "",
    item.summary.tokensLabel ?? "",
  ].filter(Boolean).join(" · ");
  return { id, domId, anchorKey, kind: "turn", label, preview: capped(metrics ? `${label} · ${metrics}` : label) };
}

/** Maps only the semantic entries rendered as top-level thread anchors. */
export function buildConversationNavigationEntries(
  items: readonly TaskChatItem[],
  rendersInteractions = false,
): ConversationNavigationEntry[] {
  const entries: ConversationNavigationEntry[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      const preview = capped(item.text);
      const anchorKey = item.renderKey ?? item.id;
      if (preview) {
        const label = item.authorName ?? (item.author === "human" ? "You" : item.author === "agent" ? "Agent" : "System");
        entries.push({ id: item.id, domId: `comment-${item.id}`, anchorKey, kind: "message", label, preview });
      }
      if (item.attachedTurn) {
        const attached = turnEntry(item.attachedTurn, `${item.id}:turn`, anchorKey, `comment-${item.id}`);
        if (attached) entries.push(attached);
      }
      continue;
    }
    if (item.kind === "plan_document") {
      const label = item.document.title ?? "Saved plan";
      const preview = capped(item.document.body) || capped(label);
      if (!preview) continue;
      entries.push({
        id: item.id,
        domId: `thread-anchor-${encodeURIComponent(item.id)}`,
        anchorKey: item.id,
        kind: "plan",
        label,
        preview,
      });
      continue;
    }
    if (item.kind === "interaction") {
      if (!rendersInteractions) continue;
      const label = reviewLabel(item);
      if (!label) continue;
      const preview = capped(label);
      entries.push({ id: item.id, domId: `thread-anchor-${encodeURIComponent(item.id)}`, anchorKey: item.id, kind: "review", label, preview });
      continue;
    }
    if (item.kind === "turn") {
      const entry = turnEntry(item, item.id, item.id, `thread-anchor-${encodeURIComponent(item.id)}`);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}
