import { useEffect, useRef, useState } from "react";
import type { IssueDocument, IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { cn, relativeTime } from "../lib/utils";
import { buildIssueHandoffSummary } from "../lib/issue-handoff-summary";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type IssueContinuationHandoffProps = {
  document: IssueDocument | null | undefined;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  focusSignal?: number;
  externalReferences?: MarkdownExternalReferenceMap;
};

export function IssueContinuationHandoff({
  document,
  executionPolicy,
  executionState,
  focusSignal = 0,
  externalReferences,
}: IssueContinuationHandoffProps) {
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!document || focusSignal <= 0) return;
    setExpanded(true);
    setHighlighted(true);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlighted(false), 3000);
    return () => clearTimeout(timer);
  }, [document, focusSignal]);


  const title = document?.title?.trim() || (document ? "Continuation handoff" : "Execution handoff context");
  const summary = buildIssueHandoffSummary({
    policy: executionPolicy,
    state: executionState,
    participantLabel: (principal) => principal.type === "agent"
      ? `Agent ${principal.agentId ?? "unknown"}`
      : `User ${principal.userId ?? "unknown"}`,
    handoffRevision: document && document.latestRevisionNumber > 0 ? document.latestRevisionNumber : null,
  });

  return (
    <div
      ref={rootRef}
      id={`document-${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`}
      className={cn(
        "mb-3 rounded-lg border border-border bg-accent/20 p-3 transition-colors duration-1000",
        highlighted && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? "Collapse continuation handoff" : "Expand continuation handoff"}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <History className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{title}</span>
            {document ? <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase text-muted-foreground">handoff</Badge> : null}
          </div>
          {document ? (
            <div className="text-(length:--text-micro) text-muted-foreground">
              Updated {relativeTime(document.updatedAt)}
              {document.latestRevisionNumber > 0 ? ` - revision ${document.latestRevisionNumber}` : ""}
            </div>
          ) : <div className="text-(length:--text-micro) text-muted-foreground">Handoff document: Unknown</div>}
        </div>
        {document ? (
          <AgentSetupPrompt
            prompt={document.body}
            label="Continue with an agent"
            title="Task handoff"
            description="Paste this into your agent to continue from this handoff."
            align="end"
          />
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 rounded-md border border-border bg-background/60 p-3 text-xs sm:grid-cols-2">
        <div><span className="text-muted-foreground">Execution status: </span>{summary.status ?? "Unknown"}</div>
        <div>
          <span className="text-muted-foreground">Current responsible actor: </span>
          {summary.currentActor ?? (summary.currentActorStatus === "idle"
            ? "None (workflow idle)"
            : summary.currentActorStatus === "none"
              ? "None (execution completed)"
              : "Unknown")}
        </div>
        <div><span className="text-muted-foreground">Next stage: </span>{summary.nextStage ?? (summary.nextStageStatus === "none" ? "None" : "Unknown")}</div>
        <div><span className="text-muted-foreground">Next stage audience: </span>{summary.nextStageStatus === "unknown" ? "Unknown" : summary.nextAudience.length ? summary.nextAudience.join(", ") : "None"}</div>
        <div><span className="text-muted-foreground">Return destination: </span>{summary.returnDestination ?? "Unknown"}</div>
        <div><span className="text-muted-foreground">Handoff document revision: </span>{summary.handoffRevision ?? "Unknown"}</div>
        <div><span className="text-muted-foreground">Reviewed work-product revision: </span>{summary.reviewedRevision ?? "Unknown (not recorded)"}</div>
        <div><span className="text-muted-foreground">Last durable decision: </span>{summary.lastDecisionId ?? "Unknown"}</div>
        <div><span className="text-muted-foreground">Last decision outcome: </span>{summary.lastDecisionOutcome ?? "Unknown"}</div>
        {summary.reviewInstructions ? <div className="sm:col-span-2"><span className="text-muted-foreground">Review instructions: </span>{summary.reviewInstructions}</div> : null}
        {summary.reworkReasonStatus === "unknown" ? <div className="sm:col-span-2"><span className="text-muted-foreground">Rework reason: </span>Unknown (decision body not available in this reader)</div> : null}
        <div className="sm:col-span-2 text-muted-foreground">Configured participants are an audience, not a confirmed dispatch. Review instructions are not a change-request decision. Handoff content and revision are not evidence that a prior process stopped or that a decision approved a particular revision.</div>
      </div>
      {expanded && document ? (
        <div className="mt-3 rounded-md border border-border bg-background/80 p-3">
          <MarkdownBody
            className="paperclip-edit-in-place-content text-sm leading-6"
            softBreaks={false}
            externalReferences={externalReferences}
          >
            {document.body}
          </MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
