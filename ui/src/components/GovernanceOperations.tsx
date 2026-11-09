import { useId, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GovernanceOperationException } from "@paperclipai/shared/governance-operations";
import { governanceOperationsApi } from "../api/governance-operations";
import { useAccountIdentity } from "../api/companies-query";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

function ExceptionCard({ companyId, exception, canManage, generatedAt, queryKey }: { companyId: string; exception: GovernanceOperationException; canManage: boolean; generatedAt: string; queryKey: readonly string[] }) {
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: (kind: "pause" | "resume" | "resolve") => {
      const input = { expectedRevision: exception.revision, reason };
      if (kind === "pause") return governanceOperationsApi.pause(companyId, exception.id, input);
      if (kind === "resolve") return governanceOperationsApi.resolve(companyId, exception.id, input);
      return governanceOperationsApi.resume(companyId, exception.id, { expectedRevision: exception.revision });
    },
    onSuccess: async () => { setReason(""); await client.invalidateQueries({ queryKey }); },
  });
  return <article className="rounded border border-border p-3 space-y-2">
    <h4 className="font-medium">{exception.reason}</h4>
    <p className="text-sm">Owner: {exception.ownerName} · {exception.state} · revision {exception.revision} · received {exception.receivedAgeSeconds}s ago · active SLA age {exception.activeAgeSeconds}s{exception.clockPausedAt ? " (clock paused)" : ""}</p>
    <dl className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
      <div>Received: {exception.receivedAt}</div><div>Admitted: {exception.admittedAt}</div>
      <div>Deadline (UTC): {exception.deadlineAt}</div><div>Escalation generation: {exception.escalationGeneration}</div>
      <div>Paused: {exception.clockPausedAt ?? "No"}{exception.pauseReason ? ` — ${exception.pauseReason}` : ""}</div>
      <div>Last resumed: {exception.lastResumedAt ?? "Never"}</div>
      <div>Resolved: {exception.resolvedAt ?? "No"}{exception.resolutionNote ? ` — ${exception.resolutionNote}` : ""}</div>
    </dl>
    {exception.taskIssueId && <Link className="underline text-sm mr-3" to={`/issues/${exception.taskIssueId}`}>Source task</Link>}
    {exception.escalationBlockReason && <p className="text-sm">Escalation held: {exception.escalationBlockReason}. Next native retry: {exception.escalationRetryAt ?? "Unavailable"}</p>}
    {exception.escalationIssueId && <Link className="underline text-sm" to={`/issues/${exception.escalationIssueId}`}>Internal escalation task</Link>}
    {canManage && exception.state === "open" && <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">Pause / resolution reason<input className="block border rounded p-1 bg-background" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {exception.clockPausedAt ? <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("resume")}>Resume clock</Button>
        : <Button size="sm" disabled={action.isPending || !reason.trim() || exception.escalationGeneration > 0 || Date.parse(exception.deadlineAt) <= Date.parse(generatedAt)} onClick={() => action.mutate("pause")}>Pause clock</Button>}
      <Button size="sm" disabled={action.isPending || !reason.trim()} onClick={() => action.mutate("resolve")}>Resolve exception</Button>
    </div>}
    {action.error && <p role="alert" className="text-destructive">{action.error.message} Reload before retrying a revision conflict.</p>}
    <details><summary className="cursor-pointer text-sm">Audit history ({exception.events.length} visible events)</summary>
      <ol className="text-xs space-y-1 mt-2">{exception.events.map(event => <li key={event.id}>{event.createdAt} · {event.kind} · {event.actorUserId ?? "Native scheduled work"}{event.reason ? ` — ${event.reason}` : ""}<pre className="whitespace-pre-wrap">{JSON.stringify(event.details, null, 2)}</pre></li>)}</ol>
    </details>
  </article>;
}

export function GovernanceOperations({ companyId }: { companyId: string }) {
  const { userId, settled, failed } = useAccountIdentity();
  if (!settled) return <main className="p-4"><p role={failed ? "alert" : "status"}>{failed ? "Account identity unavailable. Operations is hidden until the account can be resolved." : "Loading account…"}</p></main>;
  const requestScope = JSON.stringify([companyId, userId]);
  return <ScopedGovernanceOperations key={requestScope} companyId={companyId} requestScope={requestScope} />;
}

function ScopedGovernanceOperations({ companyId, requestScope }: { companyId: string; requestScope: string }) {
  const client = useQueryClient();
  const viewId = useId();
  // A remounted account/company scope must never reuse an earlier snapshot or
  // accept a late response from its previous lifetime.
  const queryKey = queryKeys.governanceOperations.snapshot(companyId, requestScope, viewId);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => governanceOperationsApi.get(companyId, signal), gcTime: 0, staleTime: 0, refetchOnMount: "always" });
  const [occurrenceId, setOccurrenceId] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [deadline, setDeadline] = useState("");
  const [reason, setReason] = useState("");
  const admission = useMutation({ mutationFn: async () => {
    const parsed = new Date(`${deadline}:00Z`);
    if (!Number.isFinite(parsed.getTime())) throw new Error("Enter an explicit UTC deadline");
    return governanceOperationsApi.admit(companyId, occurrenceId, { ownerUserId, reason, deadlineAt: parsed.toISOString() });
  }, onSuccess: async () => { setOccurrenceId(""); setReason(""); setDeadline(""); await client.invalidateQueries({ queryKey }); } });
  function submit(event: FormEvent) { event.preventDefault(); admission.mutate(); }
  if (query.isPending) return <p role="status">Loading authorized operations…</p>;
  if (query.error || !query.data) return <div role="alert">{query.error?.message ?? "Operations unavailable"}<Button onClick={() => void query.refetch()}>Retry</Button></div>;
  const model = query.data;
  return <main className="space-y-6 p-4 max-w-7xl mx-auto">
    <header className="flex justify-between gap-3"><div><h1 className="text-xl font-semibold">Governance operations</h1><p className="text-xs text-muted-foreground">Snapshot {model.generatedAt}; currently authorized native objects only.</p></div><Button onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh</Button></header>
    <p className="text-sm">{model.truncation.note} Each source is capped at {model.truncation.limitPerSource}; this is not a company-wide total.{model.truncation.sources.length ? ` Capped visible sources: ${model.truncation.sources.join(", ")}.` : ""}</p>
    <section className="space-y-2"><h2 className="font-semibold">Admission and reviewer waits</h2>
      {!model.issues.length && <p>No readable tasks in this bounded snapshot.</p>}
      <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">Native task</th><th>State / age</th><th className="text-left">Current explanation</th></tr></thead><tbody>{model.issues.map(issue => <tr key={issue.id} className="border-t align-top"><td className="py-2"><Link className="underline" to={`/issues/${issue.id}`}>{issue.identifier ?? issue.title}</Link><div className="text-xs">{issue.title} · {issue.priority} · {issue.status}</div></td><td className="p-2">{issue.admissionState}<div>{issue.ageSeconds}s</div></td><td className="py-2"><ul>{issue.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>{issue.reviewParticipant && <div>Reviewer: {issue.reviewParticipant}</div>}</td></tr>)}</tbody></table></div>
    </section>
    <section className="space-y-2"><h2 className="font-semibold">Execution, capacity and financial evidence</h2><p className="text-sm">{model.capacity.visibleActiveRuns} visible queued/running/unknown records; unknown workers are not free.</p>
      <ul className="text-xs list-disc pl-4">{model.capacity.guarantees.map(note => <li key={note}>{note}</li>)}</ul>
      <p className="text-xs">{model.financialVisibility}</p>
      <div className="overflow-auto"><table className="w-full text-xs"><thead><tr><th className="text-left">Run / native task</th><th>State / age</th><th className="text-left">Reason / recovery</th><th className="text-left">Receipt provider / model</th><th className="text-left">Held / live / settled cents</th></tr></thead><tbody>{model.runs.map(run => <tr key={run.id} className="border-t align-top"><td className="py-2"><Link className="underline" to={`/agents/${run.agentId}/runs/${run.id}`}>{run.id.slice(0, 8)}</Link>{run.issueId && <div><Link className="underline" to={`/issues/${run.issueId}`}>Task</Link></div>}{run.runtimeMode}</td><td className="p-2">{run.operationalState}<div>{run.status} · {run.ageSeconds}s</div></td><td className="py-2">{run.reason}<div>Recovery: {run.recoveryPhase ?? "No visible pending finalization"}</div></td><td className="py-2">{run.effectiveProvider ?? "Unknown"} / {run.effectiveModel ?? "Unknown"}<div>{run.providerIdentitySource}</div></td><td className="py-2">{run.heldCents ?? "Unknown/not held"} / {run.liveObservedCents ?? "Unknown/not live"} / {run.settledCents ?? "Not proven settled"}<div>{run.unpriced ? "Unpriced/pending evidence" : ""}{run.costAccountingPending ? " Receipt accounting pending" : ""}</div></td></tr>)}</tbody></table></div>
      {model.capacity.perAgentActiveRuns.map(agent => <p className="text-xs" key={agent.agentId}>{agent.agentName}: {agent.activeRuns} visible occupied/unproven run records</p>)}
      {model.budgets.map(budget => <article key={budget.id} className="border rounded p-2 text-xs"><strong>{budget.scopeType} {budget.scopeName}</strong> · {budget.metric} / {budget.windowKind} · limit {budget.amount} · hard stop {budget.hardStopEnabled ? "enabled" : "disabled"}<div>Settled ledger {budget.ledgerCents} · live {budget.liveObservedCents} · effective held {budget.effectiveHeldCents} cents (do not add live to held)</div><div>Pending terminal receipts {budget.pendingTerminalRunCount} · unpriced {budget.unpricedEventCount} · unknown browser work {budget.unknownBrowserRunCount}</div></article>)}
    </section>
    <section className="space-y-3"><h2 className="font-semibold">Recurring occurrences and owned exceptions</h2><p className="text-xs">{model.clockPolicy}</p>
      {model.canManageExceptions && <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded border p-3">
        <label className="text-xs">Occurrence<select className="block border rounded bg-background p-1 max-w-80" required value={occurrenceId} onChange={e => setOccurrenceId(e.target.value)}><option value="">Choose authorized occurrence</option>{model.occurrences.filter(row => !row.exception && row.disposition !== "satisfied" && row.executionState !== "satisfied").map(row => <option key={row.id} value={row.id}>{row.scheduledAt} · {row.executionState} · {row.id.slice(0, 8)}</option>)}</select></label>
        <label className="text-xs">Owner<select className="block border rounded bg-background p-1" required value={ownerUserId} onChange={e => setOwnerUserId(e.target.value)}><option value="">Choose current member</option>{model.ownerOptions.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
        <label className="text-xs">Deadline (UTC, not browser local)<input className="block border rounded bg-background p-1" type="datetime-local" required value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
        <label className="text-xs">Admission reason<input className="block border rounded bg-background p-1" required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button type="submit" size="sm" disabled={admission.isPending || !ownerUserId || !occurrenceId || !reason.trim() || !deadline}>Admit exception</Button>
        {admission.error && <p role="alert" className="text-destructive">{admission.error.message}</p>}
      </form>}
      {model.occurrences.map(occurrence => <div key={occurrence.id} className="space-y-2 border-l-2 pl-3"><p className="text-sm"><Link className="underline" to={`/routines/${occurrence.routineId}`}>Routine</Link> · {occurrence.scheduledAt} · obligation {occurrence.disposition} · execution {occurrence.executionState}{occurrence.decisionReason ? ` — ${occurrence.decisionReason}` : ""}{occurrence.taskId && <> · <Link className="underline" to={`/issues/${occurrence.taskId}`}>Native task</Link></>}{occurrence.caseId && <> · <Link className="underline" to={`/cases/${occurrence.caseId}`}>Case</Link></>}</p>{occurrence.exception && <ExceptionCard companyId={companyId} exception={occurrence.exception} canManage={model.canManageExceptions} generatedAt={model.generatedAt} queryKey={queryKey} />}</div>)}
    </section>
    <section className="grid md:grid-cols-2 gap-4 text-sm">
      <div><h2 className="font-semibold">Routines / next native schedule</h2>{model.routines.map(row => <p key={row.id}><Link className="underline" to={`/routines/${row.id}`}>{row.name}</Link> · {row.status} · {row.enabled ? row.nextRunAt ?? "No next date" : "No enabled trigger in snapshot"} · {row.timezone ?? "No schedule timezone"}</p>)}</div>
      <div><h2 className="font-semibold">Cases and milestone review</h2>{model.cases.map(row => <p key={row.id}><Link className="underline" to={`/cases/${row.id}`}>{row.title}</Link> · {row.status}</p>)}{model.milestones.map(row => <p key={row.id}><Link className="underline" to={`/cases/${row.caseId}`}>{row.issueTitle}</Link> · revision {row.revision ?? "none"} · {row.revisionState ?? "unknown"} (contract state; not proof of current valid acceptance)</p>)}</div>
      <div><h2 className="font-semibold">Recovery holds</h2>{model.recoveries.map(row => <p key={row.id}><Link className="underline" to={`/issues/${row.issueId}`}>{row.issueIdentifier ?? row.issueTitle}</Link> · {row.status} · {row.cause} · {row.updatedAt}</p>)}</div>
      <div><h2 className="font-semibold">Visible native decision queue sources</h2>{model.decisionQueues.map(queue => <div key={queue.id}><h3><Link className="underline" to={`/decisions/queues/${encodeURIComponent(queue.key)}`}>{queue.title}</Link>: {queue.itemCount} visible items</h3>{queue.items.map(item => <p key={item.id}><Link className="underline" to={`/decisions/queues/${encodeURIComponent(queue.key)}`}>{item.sourceKind} decision source</Link> · received {item.createdAt}</p>)}</div>)}</div>
    </section>
    <footer className="text-xs space-y-1"><p>{model.policyNotes.ranking}</p><ul className="list-disc pl-4">{model.policyNotes.exclusions.map(note => <li key={note}>{note}</li>)}</ul></footer>
  </main>;
}
