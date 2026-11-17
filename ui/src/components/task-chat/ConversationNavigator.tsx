import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ConversationNavigationEntry } from "./conversation-navigation";

interface ConversationNavigatorProps {
  entries: ConversationNavigationEntry[];
  historyPartial: boolean;
  docked?: boolean;
  onHighlight: (entry: ConversationNavigationEntry | null) => void;
  onActivate: (entry: ConversationNavigationEntry) => Promise<boolean>;
}

const KIND_LABEL: Record<ConversationNavigationEntry["kind"], string> = {
  message: "Message",
  plan: "Saved plan",
  review: "Review",
  turn: "Turn summary",
};

export function ConversationNavigator({
  entries,
  historyPartial,
  docked = false,
  onHighlight,
  onActivate,
}: ConversationNavigatorProps) {
  const [active, setActive] = useState<ConversationNavigationEntry | null>(null);
  const [result, setResult] = useState("");
  useEffect(() => {
    if (active && !entries.some((entry) => entry.id === active.id)) {
      setActive(null);
      onHighlight(null);
      setResult("This conversation entry is no longer available.");
    }
  }, [active, entries, onHighlight]);

  if (entries.length === 0) return null;

  const currentActive = active
    ? entries.find((entry) => entry.id === active.id) ?? null
    : null;
  const highlight = (entry: ConversationNavigationEntry | null) => {
    setActive(entry);
    setResult("");
    onHighlight(entry);
  };

  const activate = async (entry: ConversationNavigationEntry) => {
    setResult("");
    const landed = await onActivate(entry);
    setResult(landed ? `Opened ${entry.label}.` : "This conversation entry is no longer available.");
  };

  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col-reverse items-end md:gap-2",
        docked
          ? "relative mx-auto w-full"
          : "fixed bottom-(--tc-composer-bottom) left-1/2 z-20 w-[90%] -translate-x-1/2 md:absolute md:bottom-auto md:left-auto md:right-1 md:top-1/2 md:h-[70%] md:w-auto md:-translate-y-1/2 md:translate-x-0 md:flex-row-reverse md:items-center",
      )}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) highlight(null);
      }}
    >
      <nav
        aria-label="Conversation navigation"
        className={cn(
          "flex min-w-0 max-h-full max-w-full flex-row gap-1 overflow-x-auto rounded-full border border-border/70 bg-background/90 p-1 shadow-sm backdrop-blur",
          !docked && "md:h-full md:max-h-full md:flex-col md:overflow-x-hidden md:overflow-y-auto",
        )}
      >
        <span className="sr-only">{historyPartial ? "Showing loaded history only" : "All conversation history loaded"}</span>
        <span className="px-1 text-center text-[9px] leading-none text-muted-foreground" aria-hidden>
          {historyPartial ? "Loaded" : "All"}
        </span>
        {entries.map((entry) => {
          const selected = active?.id === entry.id;
          return (
            <button
              aria-label={`${KIND_LABEL[entry.kind]}: ${entry.label}`}
              aria-current={selected ? "location" : undefined}
              className={cn(
                "group flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                !docked && "md:size-5",
                selected && "bg-muted",
              )}
              key={entry.id}
              onMouseEnter={() => highlight(entry)}
              onFocus={() => highlight(entry)}
              onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) highlight(null);
              }}
              onClick={() => void activate(entry)}
              type="button"
            >
              <span aria-hidden className={cn("size-2.5 rounded-full border border-muted-foreground/50 bg-muted-foreground/35 transition-colors group-hover:bg-primary", selected && "bg-primary")} />
              <span className="sr-only">{entry.label}</span>
            </button>
          );
        })}
      </nav>
      {currentActive ? (
        <div data-testid="conversation-navigation-preview" className={cn(
          "absolute bottom-full right-0 mb-2 w-64 max-w-full shrink-0 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg",
          !docked && "md:static md:mb-0",
        )}>
          <p className="text-xs font-medium">{currentActive.label}</p>
          <p className="mt-1 line-clamp-3 break-words text-xs text-muted-foreground">{currentActive.preview}</p>
          <p className="mt-2 text-[10px] text-muted-foreground">{historyPartial ? "Loaded history only" : KIND_LABEL[currentActive.kind]}</p>
        </div>
      ) : null}
      <span aria-live="polite" className="sr-only">{result}</span>
    </div>
  );
}
