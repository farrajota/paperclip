import { useState } from "react";
import { Link } from "@/lib/router";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { routinesApi } from "../api/routines";
import { useAccountIdentity } from "../api/companies-query";
import { queryKeys } from "../lib/queryKeys";

export function RoutineOccurrences({ routineId }: { routineId: string }) {
  const account = useAccountIdentity();
  return <OccurrenceHistory key={`${routineId}:${account.userId ?? "anonymous"}`} routineId={routineId} userId={account.userId} enabled={account.settled || account.failed} />;
}

function OccurrenceHistory({ routineId, userId, enabled }: { routineId: string; userId: string | null; enabled: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = [...queryKeys.routines.detail(routineId), "occurrences", userId];
  const history = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => routinesApi.listOccurrences(routineId, { cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    refetchInterval: query => query.state.data?.pages.some(page => page.catchup.hasMoreDue || page.items.some(item => ["pending", "dispatching", "waiting"].includes(item.executionState))) ? 3000 : false,
  });
  const [decision, setDecision] = useState<{ id: string; disposition: "skipped" | "waived" } | null>(null);
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState("");
  const disposition = useMutation({
    mutationFn: () => {
      if (!decision) throw new Error("Select an occurrence");
      return routinesApi.setOccurrenceDisposition(routineId, decision.id, { disposition: decision.disposition, reason, ...(owner.trim() ? { ownerUserId: owner.trim() } : {}) });
    },
    onSuccess: () => {
      setDecision(null);
      setReason("");
      setOwner("");
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(routineId) });
    },
  });
  const page = history.data?.pages[0];
  const rows = history.data?.pages.flatMap(item => item.items) ?? [];
  const current = rows.find(row => row.disposition === "obligation");

  return <section className="mt-8 rounded-lg border border-border p-4" aria-labelledby="routine-occurrences-heading">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 id="routine-occurrences-heading" className="text-base font-semibold">Schedule obligations</h2>
        <p className="mt-1 text-sm text-muted-foreground">Every captured original instant has its own obligation. Sharing a task does not fulfill a distinct occurrence. A bound milestone requires current acceptance of its exact pinned revision, not merely review readiness.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void history.refetch()} disabled={history.isFetching}>Refresh</Button>
    </div>
    {!enabled || history.isLoading ? <p role="status">Loading occurrence history…</p> : null}
    {history.isError ? <p role="alert" className="text-destructive">Could not load occurrence history. Your access may have changed.</p> : null}
    {page ? <div className="mb-4 space-y-1 text-sm">
      <p>Newest outstanding occurrence on this history page: {current ? new Date(current.scheduledAt).toLocaleString() : "none"}. Older pages may contain other obligations.</p>
      <p>Next unmaterialized schedule instant: {page.catchup.nextScheduledAt ? new Date(page.catchup.nextScheduledAt).toLocaleString() : "none"}.</p>
      {page.catchup.hasMoreDue ? <p role="status" className="text-amber-700">Coverage is incomplete: more original instants are due. Each native tick records at most {page.catchup.batchLimit} instants per trigger; its cursor stays at the first uncovered instant. Future ticks continue coverage; this read does not dispatch work.</p> : <p className="text-muted-foreground">No overdue schedule coverage continuation is currently reported.</p>}
      <p>Coverage batching is separate from execution: each catch-up episode permits at most {page.catchup.executionLimit} executable obligations. Further original instants receive explicit cap-skipped receipts; coverage continuation does not replenish that allowance.</p>
      {page.catchup.episodes.map(episode => <p key={episode.triggerId}>Trigger {episode.triggerId}: accounting through {new Date(episode.cutoff).toLocaleString()}, pinned revision {episode.revisionId}; {episode.executionsConsumed}/{episode.latestOnly ? 1 : page.catchup.executionLimit} executable obligations consumed. {episode.latestOnly ? "Only the latest eligible instant executes." : "Excess instants are skipped with the cap reason."}</p>)}
    </div> : null}
    {page && rows.length === 0 ? <p className="text-muted-foreground">No persisted schedule occurrences yet.</p> : null}
    {disposition.isError ? <p role="alert" className="text-destructive">Could not record this decision. The owner must be an active company member; active or accepted work cannot be disposed. Refresh to inspect its current state.</p> : null}
    <ol className="divide-y divide-border">{rows.map(row => {
      const settled = row.disposition !== "obligation";
      const canDecide = page?.canDecide && row.disposition === "obligation" && ["pending", "failed", "cancelled", "unknown"].includes(row.executionState);
      return <li key={row.id} className="space-y-2 py-4">
        <div className="flex items-center gap-2 font-medium">
          {row.executionState === "unknown" ? <AlertCircle className="size-4 text-amber-600" /> : settled ? <CheckCircle2 className="size-4" /> : <Clock3 className="size-4" />}
          <time dateTime={row.scheduledAt}>{new Date(row.scheduledAt).toLocaleString()}</time>
        </div>
        <p className="text-sm">Obligation: {row.disposition} · execution: {row.executionState} · pinned routine revision {row.revisionNumber}</p>
        {row.decisionReason ? <p className="text-sm">{row.decisionReason}</p> : null}
        <p className="text-xs text-muted-foreground">Accountable owner: {row.ownerUserId ?? "not assigned"} · dispatch attempts: {row.dispatchAttempts}</p>
        {row.approvedWorkflowDocumentId ? <p className="text-xs">Pinned approved procedure: {row.approvedWorkflowDocumentId}, revision {row.approvedWorkflowRevisionId}</p> : null}
        {row.milestoneId ? <p className="text-xs">Milestone: {row.milestoneId}, required accepted revision {row.milestoneRevisionId}</p> : null}
        {row.acceptedAt ? <p className="text-xs">Accepted at {new Date(row.acceptedAt).toLocaleString()} · task status version {row.acceptedTaskStatusVersion}</p> : null}
        {row.taskId ? <Link className="inline-block text-sm underline" to={`/issues/${row.taskId}`}>Open native task</Link> : null}
        {row.executionState === "unknown" ? <p className="text-sm text-amber-700">Execution is uncertain. Lease expiry is not proof that work did not start; no automatic blind retry is made.</p> : null}
        {row.decisionHistory.length ? <details><summary className="cursor-pointer text-sm">Decision audit ({row.decisionHistory.length})</summary><ol className="space-y-2 pl-4 text-xs">{row.decisionHistory.map(event => <li key={event.id}>{new Date(event.createdAt).toLocaleString()} · {event.action} · {event.actorType} {event.actorId} · owner {event.ownerUserId ?? "none"}<p>{event.reason}</p></li>)}</ol></details> : null}
        {canDecide ? <div className="flex gap-2">{(row.executionState === "unknown" ? ["waived"] as const : ["skipped", "waived"] as const).map(value => <Button key={value} size="sm" variant="outline" disabled={disposition.isPending} onClick={() => { setDecision({ id: row.id, disposition: value }); setReason(""); setOwner(row.ownerUserId ?? userId ?? ""); }}>{value === "skipped" ? "Skip with reason" : "Waive after review"}</Button>)}</div> : null}
        {decision?.id === row.id ? <form className="grid gap-2 rounded border border-border p-3" onSubmit={event => { event.preventDefault(); if (reason.trim()) disposition.mutate(); }}>
          <label className="grid gap-1 text-sm">Accountable owner user ID (blank uses your account)<input className="rounded border bg-background p-2" value={owner} onChange={event => setOwner(event.target.value)} /></label>
          <label className="grid gap-1 text-sm">Reason for explicit {decision.disposition}<textarea className="rounded border bg-background p-2" required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <div className="flex gap-2"><Button type="submit" disabled={!reason.trim() || disposition.isPending}>Record audited decision</Button><Button type="button" variant="outline" onClick={() => setDecision(null)}>Cancel</Button></div>
        </form> : null}
      </li>;
    })}</ol>
    {history.hasNextPage ? <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading older occurrences…" : "Load older occurrences"}</Button> : null}
  </section>;
}
