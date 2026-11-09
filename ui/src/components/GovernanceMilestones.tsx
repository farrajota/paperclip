import { useCallback, useEffect, useState } from "react";
import type { CaseDetail, CaseDocumentRef, CaseTaskDocumentRef } from "@/api/cases";
import { casesApi } from "@/api/cases";
import { CaseDocumentPreview } from "@/components/cases/CaseDocumentPreview";
import type { MilestoneContractInput, MilestoneEvidenceInput } from "@paperclipai/shared/governance-milestones";
import { Link } from "@/lib/router";
import { governanceMilestonesApi, type MilestoneHistory } from "../api/governance-milestones";

const CONTRACT_TEMPLATE: MilestoneContractInput = {
  title: "New milestone",
  description: null,
  playbookBinding: { documentId: "", documentRevisionId: "" },
  requiredDeliverables: [{
    key: "deliverable",
    label: "Required deliverable",
    evidenceKind: "document_revision",
    reference: { kind: "document", documentId: "" },
    maxAgeHours: 168,
  }],
  executorPolicy: { kind: "any_internal_agent" },
  reviewerPolicy: { kind: "board_user" },
  followups: [],
};
const EMPTY_CONTRACT = JSON.stringify(CONTRACT_TEMPLATE, null, 2);

function contractToEdit(history: MilestoneHistory | null) {
  const revisions = history?.revisions ?? [];
  return [...revisions].reverse().find((revision) => revision.state === "draft")
    ?? [...revisions].reverse().find((revision) => revision.state === "active" || revision.state === "accepted")
    ?? [...revisions].reverse()[0];
}

function sourceTaskId(provenance: Record<string, unknown>) {
  const taskId = provenance.taskId ?? provenance.issueId;
  return typeof taskId === "string" ? taskId : null;
}

export function GovernanceMilestones({ caseId }: { caseId: string }) {
  const [history, setHistory] = useState<MilestoneHistory | null>(null);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [contractText, setContractText] = useState(EMPTY_CONTRACT);
  const [evidenceText, setEvidenceText] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (reloadContract = false) => {
    setError(null);
    try {
      const next = await governanceMilestonesApi.getForCase(caseId);
      setHistory(next);
      try { setCaseDetail(await casesApi.get(caseId)); }
      catch { setCaseDetail(null); }
      if (reloadContract) setContractText(JSON.stringify(contractToEdit(next)?.contract ?? CONTRACT_TEMPLATE, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load milestone history");
    }
  }, [caseId]);
  useEffect(() => { void refresh(true); }, [refresh]);

  async function run(action: () => Promise<unknown>, reloadContract = false) {
    setBusy(true);
    setError(null);
    try { await action(); await refresh(reloadContract); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Milestone action failed"); }
    finally { setBusy(false); }
  }

  function documentPreview(documentId: string) {
    if (!caseDetail) return null;
    const document = caseDetail.documents.find((item) => item.document.id === documentId)
      ?? caseDetail.taskDocuments?.find((item) => item.document.id === documentId);
    return document ? <CaseDocumentPreview key={documentId} caseIdentifier={caseDetail.identifier} document={document as CaseDocumentRef | CaseTaskDocumentRef} /> : null;
  }

  const milestone = history?.milestone;
  const readiness = history?.readiness;
  const revisions = history?.revisions ?? [];
  const evidenceHistory = history?.evidence ?? [];
  const decisions = history?.decisions ?? [];
  const followups = history?.followups ?? [];
  const currentRevision = revisions.find((revision) => revision.id === readiness?.revisionId);
  const active = currentRevision?.state === "active" ? currentRevision : null;
  const accepted = currentRevision?.state === "accepted" ? currentRevision : null;
  const isAccepted = readiness?.accepted === true && readiness.state === "accepted_current";
  const activeRevisionId = [...revisions].reverse().find((revision) => revision.state === "active" || revision.state === "accepted")?.id ?? null;
  const permissions = history?.permissions;
  const editableRevision = contractToEdit(history);

  return <section aria-labelledby="milestone-heading" className="space-y-4 rounded-md border p-4">
    <header className="flex items-center justify-between gap-3">
      <div>
        <h2 id="milestone-heading" className="text-lg font-semibold">Milestones</h2>
        <p className="text-sm text-muted-foreground">Immutable criteria, stored evidence, and independent review for this case’s primary task.</p>
      </div>
      <div className="flex gap-2">
        {milestone && <button type="button" disabled={busy} onClick={() => void refresh(true)}>Reload current contract</button>}
        {!milestone && permissions?.canCreate && <button type="button" disabled={busy} onClick={() => void run(() => governanceMilestonesApi.createForCase(caseId), true)}>Create milestone</button>}
      </div>
    </header>

    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!history && !error && <p className="text-sm text-muted-foreground" role="status">Loading milestone history…</p>}
    {!milestone && permissions && !permissions.canCreate && <p className="text-sm text-muted-foreground">Read-only: this actor may view this case but cannot create its milestone.</p>}
    {readiness && <div className="space-y-1 text-sm" role="status">
      {isAccepted
        ? <p>Accepted; the current task, pinned playbook, stored evidence, and reviewer authority remain valid.</p>
        : readiness.state === "accepted_stale"
          ? <p>Historical acceptance is no longer current: {readiness.reason}. Existing decisions and task history are retained.</p>
          : readiness.state === "eligible_for_review"
            ? <p>Eligible for independent review. This is not an acceptance.</p>
            : <p>Not ready: {readiness.reason}</p>}
      {permissions?.actorType === "agent" && <p>{readiness.executionAllowed ? "The current agent is permitted to execute under this contract." : "The current agent is not permitted to execute under this contract."}</p>}
    </div>}

    {milestone && <>
      <p className="text-xs text-muted-foreground">
        Native primary task: <Link className="underline" to={`/issues/${milestone.issueId}`}>{milestone.issueId}</Link>. Contract authorship and promotion are board-controlled; review is limited to the exact verifier policy. The UI never substitutes an agent identity.
      </p>

      {permissions?.canAuthorContract ? <div className="space-y-2">
        <h3 className="font-medium">Author or revise criteria</h3>
        <p className="text-sm text-muted-foreground">Bind the exact case-linked playbook document and revision, required internal artifacts, executor/reviewer policy, freshness, and stable follow-up action keys. Replace the blank IDs in the new-contract template with real stored IDs.</p>
        {editableRevision && <p className="text-xs text-muted-foreground">Editing a copy of stored revision {editableRevision.revision} ({editableRevision.state}); saving always appends a new immutable draft.</p>}
        <textarea aria-label="Milestone contract JSON" className="min-h-64 w-full rounded border p-2 font-mono text-xs" value={contractText} onChange={(event) => setContractText(event.target.value)} />
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const contract = JSON.parse(contractText) as MilestoneContractInput;
          await governanceMilestonesApi.createRevision(milestone.id, contract);
        }, true)}>Save immutable draft</button>
      </div> : <p className="text-sm text-muted-foreground">Contract authoring is restricted to an authorized board user.</p>}

      {revisions.filter((revision) => revision.state === "draft").map((revision) => <div key={revision.id} className="flex items-center justify-between border-t py-2">
        <span>Revision {revision.revision}: {revision.contract.title} · draft</span>
        {permissions?.canPromote && <button type="button" disabled={busy} onClick={() => void run(() => governanceMilestonesApi.promoteRevision(milestone.id, revision.id, { expectedActiveRevisionId: activeRevisionId }), true)}>Board promote</button>}
      </div>)}

      {active && permissions?.canSubmitEvidence && <div className="space-y-2 border-t pt-3">
        <h3 className="font-medium">Submit stored evidence</h3>
        <p className="text-sm text-muted-foreground">Only the exact current company artifact bound by the active contract is accepted. External URLs and claimed statuses are unsupported.</p>
        <button type="button" disabled={busy || !active.contract.requiredDeliverables.length} onClick={() => {
          const deliverable = active.contract.requiredDeliverables.find((item) => !evidenceHistory.some((entry) => entry.revisionId === active.id && entry.deliverableKey === item.key))
            ?? active.contract.requiredDeliverables[0];
          if (deliverable) setEvidenceText(JSON.stringify({
            deliverableKey: deliverable.key,
            evidenceKind: deliverable.evidenceKind,
            artifactId: "",
            expectedRevision: active.revision,
            expectedEvidenceVersion: readiness?.evidenceVersion ?? 0,
          }, null, 2));
        }}>Use next deliverable template</button>
        <textarea aria-label="Milestone evidence JSON" className="min-h-24 w-full rounded border p-2 font-mono text-xs" value={evidenceText} onChange={(event) => setEvidenceText(event.target.value)} placeholder="Choose a template, then enter the UUID of the stored current artifact." />
        <button type="button" disabled={busy || !readiness} onClick={() => void run(() => governanceMilestonesApi.addEvidence(milestone.id, JSON.parse(evidenceText) as MilestoneEvidenceInput))}>Attach evidence</button>
      </div>}
      {active && !permissions?.canSubmitEvidence && <p className="text-sm text-muted-foreground">This actor does not have current write authority to submit evidence.</p>}

      {active && <div className="space-y-2 border-t pt-3">
        <h3 className="font-medium">Independent decision</h3>
        {permissions?.canReview ? <>
          <label className="block text-sm">Decision reason<textarea className="mt-1 block w-full rounded border p-2" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} /></label>
          <div className="flex gap-2">{(["accept", "reject"] as const).map((outcome) => <button key={outcome} type="button" disabled={busy || !decisionReason.trim() || !readiness || (outcome === "accept" && !permissions.canAccept)} onClick={() => void run(() => governanceMilestonesApi.decide(milestone.id, active.id, {
            outcome,
            reason: decisionReason.trim(),
            expectedRevision: active.revision,
            expectedEvidenceVersion: readiness!.evidenceVersion,
            expectedEvidenceSnapshotHash: readiness!.evidenceSnapshotHash,
          }))}>{outcome}</button>)}</div>
        </> : <p className="text-sm text-muted-foreground">Only the exact board user or designated independent internal agent may decide. This page does not impersonate another reviewer.</p>}
      </div>}

      {accepted && permissions?.canReview && <div className="space-y-2 border-t pt-3">
        <h3 className="font-medium">Acceptance control</h3>
        <p className="text-sm text-muted-foreground">Revoke this historical decision if its governing policy or evidence is no longer acceptable.</p>
        <label className="block text-sm">Decision reason<textarea className="mt-1 block w-full rounded border p-2" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} /></label>
        <button type="button" disabled={busy || !decisionReason.trim() || !readiness} onClick={() => void run(() => governanceMilestonesApi.decide(milestone.id, accepted.id, {
          outcome: "revoke",
          reason: decisionReason.trim(),
          expectedRevision: accepted.revision,
          expectedEvidenceVersion: readiness!.evidenceVersion,
          expectedEvidenceSnapshotHash: readiness!.evidenceSnapshotHash,
        }))}>Revoke acceptance</button>
      </div>}

      <h3 className="border-t pt-3 font-medium">Revision and policy history</h3>
      <ol className="space-y-3">{revisions.map((revision) => <li key={revision.id} className="rounded border p-3 text-sm">
        <strong>Revision {revision.revision}: {revision.contract.title}</strong><span className="ml-2">{revision.state}</span>
        {revision.contract.description && <p className="mt-1">{revision.contract.description}</p>}
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><dt className="font-medium">Pinned playbook document</dt><dd className="break-all">{revision.contract.playbookBinding.documentId}</dd></div>
          <div><dt className="font-medium">Pinned playbook revision</dt><dd className="break-all">{revision.contract.playbookBinding.documentRevisionId}</dd></div>
          <div><dt className="font-medium">Executor policy</dt><dd className="break-all">{JSON.stringify(revision.contract.executorPolicy)}</dd></div>
          <div><dt className="font-medium">Reviewer policy</dt><dd className="break-all">{JSON.stringify(revision.contract.reviewerPolicy)}</dd></div>
        </dl>
        {documentPreview(revision.contract.playbookBinding.documentId)}
        <h4 className="mt-3 font-medium">Required artifacts</h4>
        <ul className="space-y-1">{revision.contract.requiredDeliverables.map((item) => <li key={item.key} className="break-all">
          <strong>{item.key}</strong>: {item.label} · {item.evidenceKind} · {item.maxAgeHours == null ? "no age limit" : `${item.maxAgeHours}h freshness`} · {JSON.stringify(item.reference)}
          {item.reference.kind === "document" && documentPreview(item.reference.documentId)}
          {item.reference.kind === "task" && <Link className="ml-2 underline" to={`/issues/${item.reference.taskId}`}>Open bound task</Link>}
          {item.reference.kind === "work_product" && <Link className="ml-2 underline" to={`/issues/${item.reference.issueId}`}>Open bound task</Link>}
        </li>)}</ul>
        <h4 className="mt-3 font-medium">Stable follow-up bindings</h4>
        <ul>{(revision.contract.followups ?? []).map((action) => <li key={action.actionKey} className="break-all">{action.actionKey}: {action.title}{action.description ? ` — ${action.description}` : ""}</li>)}</ul>
        <details className="mt-2"><summary className="cursor-pointer">Promotion snapshot</summary><pre className="overflow-auto text-xs">{JSON.stringify(revision.promotionProof, null, 2)}</pre></details>
      </li>)}</ol>

      <h3 className="font-medium">Reviewer decision history</h3>
      <ol className="space-y-2">{decisions.map((decision) => <li key={decision.id} className="rounded border p-2 text-sm">
        <strong>Revision {revisions.find((revision) => revision.id === decision.revisionId)?.revision ?? "unknown"} · {decision.outcome}</strong> — {decision.reason}
        <div>Reviewer: {decision.reviewerUserId ? `board user ${decision.reviewerUserId}` : decision.reviewerAgentId ? `internal agent ${decision.reviewerAgentId}` : "reviewer identity unavailable"} · evidence version {decision.evidenceVersion}</div>
        <div>Executor: {decision.executorUserId ? `user ${decision.executorUserId}` : decision.executorAgentId ? `agent ${decision.executorAgentId}` : "unassigned"}</div>
        <div className="break-all">Evidence snapshot: {decision.evidenceSnapshotHash}</div>
        <time dateTime={decision.createdAt}>{new Date(decision.createdAt).toLocaleString()}</time>
      </li>)}</ol>

      <h3 className="font-medium">Stored evidence history</h3>
      <ul className="space-y-2">{evidenceHistory.map((item) => {
        const revision = revisions.find((candidate) => candidate.id === item.revisionId);
        const documentId = typeof item.artifactProvenance.documentId === "string" ? item.artifactProvenance.documentId : null;
        const taskId = sourceTaskId(item.artifactProvenance);
        return <li key={item.id} className="rounded border p-2 text-sm">
          <strong>Revision {revision?.revision ?? "unknown"} · {item.deliverableKey}</strong> · {item.evidenceKind} · evidence version {item.evidenceVersion}
          <div className="break-all">Stored artifact: {item.artifactId} · artifact revision/version: {item.artifactRevision ?? "not applicable"}</div>
          <div className="break-all">Artifact hash: {item.artifactHash ?? "not recorded"}</div>
          {documentId && documentPreview(documentId)}
          {taskId && <Link className="underline" to={`/issues/${taskId}`}>Open source task</Link>}
          <details><summary className="cursor-pointer">Producer and source-trust provenance</summary><pre className="overflow-auto text-xs">{JSON.stringify({ sourceTrust: item.artifactSourceTrust, provenance: item.artifactProvenance }, null, 2)}</pre></details>
          <div>Submitted by {item.submittedByUserId ? `board user ${item.submittedByUserId}` : item.submittedByAgentId ? `agent ${item.submittedByAgentId}` : "unknown actor"} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
        </li>;
      })}</ul>

      <h3 className="font-medium">Native follow-up task receipts</h3>
      <ul className="space-y-1">{followups.map((receipt) => <li key={receipt.id} className="break-all text-sm">
        Revision {revisions.find((revision) => revision.id === receipt.acceptedRevisionId)?.revision ?? "unknown"} · {receipt.actionKey} · <Link className="underline" to={`/issues/${receipt.issueId}`}>{receipt.issueId}</Link>
      </li>)}</ul>
    </>}
  </section>;
}
