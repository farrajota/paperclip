# Governance operations and admission

Governance operations is a read model over Paperclip's existing tasks, routine occurrences, runs, recovery actions, decision queues, milestone contract revisions, and accounting. It is not a second dispatcher, task graph, scheduler, acceptance engine, or ledger.

## Operational view

The company operations view loads `GET /api/companies/:companyId/governance-operations` using the authenticated request actor. It shows:

- Visible tasks with native priority/status, the current reviewer wait, dependency and planning holds, native tree controls, and snapshot age.
- Actual queued, running, settled, or unknown run evidence. A task without a proven queued/running run is parked; an execution owner outside the bounded run sample is unknown, not a free worker.
- Native reservation holds, live observations, settled receipt evidence, accounting-pending states, and observed provider/model identity. Missing cost evidence remains unknown or unpriced; it is not zero.
- Existing routine schedules and occurrences, authorized cases, native recovery holds, visible decision-queue sources, and milestone contract revision state. A displayed revision state or a completed task is **not** proof of current valid milestone acceptance.
- Owned recurring exceptions with receipt/admission dates, owner, reason, deadline, accumulated active SLA age, pause/resume/resolution state, revision, audit history, and readable native source/escalation links.

Use **Refresh** for a new snapshot. This view does not add a polling timer. Each source sample is bounded to 100 records; authorization filtering can make the visible sample smaller or empty. Older authorized records may be absent even when no particular truncation source is reported. Reported counts describe only visible sampled records, never hidden company totals. Receipt/history truncation is disclosed where the sampled parent is authorized.

The entire read/control subtree is remounted for the resolved account/company scope. Unresolved account identity hides operations. Each mounted scope has its own uncached query lifetime, so returning to a previous company starts a fresh read and late results or mutation callbacks from an old scope cannot populate the new view. Already submitted explicit mutations are not retroactively cancelled by navigation.

Native resource authorization applies to tasks, project/case sources, decision sources, agent details, and run bindings. Additional persisted run source references must also remain readable. The response never includes hidden run/source identifiers merely to explain a count. An unreadable escalation task is omitted from links and audit details. Accountable owner names come from the actual user account attached to the exception, not a fabricated operator identity.

Company-wide financial exposure can reveal private work. Complete-scope budget aggregates are therefore restricted to an unscoped instance-admin/local-implicit read context, without an external authorizer or an instance-admin suppression flag. Ordinary company operators and scoped callers receive only authorized run-level evidence. Held, live-observed, and settled figures are distinct native accounting categories and must not be summed naively.

### Capacity and selection limits

The view reports visible occupancy, not a universal available-slot number. Unknown/recovering execution remains occupied or unproven. Native reservation generations, held/live/settled accounting, cancellation, and recovery ownership remain authoritative.

The existing agent-start lock is process-local, with its existing stale-lock timeout; it does not establish universal cross-controller slot enforcement. Native provider preparation retains its own credential, quota, provider-pool, and effective-model decisions. A provider/model observed in a receipt is not proof that every custom adapter honored pool admission. Custom adapters can lack enforceable Stop, isolation, or complete metering. The operations view explicitly does not promise those capabilities or label unknown execution free.

Native queues retain their existing priority, readiness, schedule, retry, and concurrency ordering. Hard gates exclude work before selection. There is no synthetic universal governance score.

## Final business-work admission

Dependency graph changes serialize company graph validation **before** locking endpoint issue rows. Both nonempty replacement and edge removal use the same protocol. Competing edits with disjoint endpoints cannot independently validate a combined cycle. A cancelled dependency is not a successful predecessor.

Native task creation takes the company row `FOR NO KEY UPDATE` before the existing company graph advisory (when creating with predecessors), then the company privacy-tree advisory, then source/endpoint rows. Final business dispatch retains its established company/accounting/recovery order before graph, privacy, and endpoints. Number allocation still uses the native self-correcting counter; conversation, title, and idempotency reuse retain their existing semantics. The earlier company lock prevents creation from holding privacy while waiting for a company row already held by final dispatch or escalation. It does not add another lock namespace or a deadlock-retry mechanism.

**Transaction callers:** when passing an existing transaction to native creation, acquire the company row before locking source rows. Acquire any required graph advisory before privacy, and privacy before source endpoints. Calling creation after taking those locks in reverse order cannot repair the transaction's earlier acquisition order. `FOR NO KEY UPDATE` fences company state changes without unnecessarily blocking native foreign-key checks.

Legacy and native business dispatch carry an explicit business-work classification through the public use case and PostgreSQL adapter. At the existing reservation/final-handoff boundaries they re-evaluate current task/review assignment, dependencies, tree controls, cancellation/Stop, current access, and the native planning earliest-start gate. The planning gate receives the transaction-bound database as its first argument and the actual executing agent identity as its optional fifth argument. Future planning dates hold work; unknown planning readiness does not become permission to start.

The final private-access read fences the actual authority rows consumed by that decision, including privacy ancestry, effective issue grants, project membership, and company membership. Competing grant revoke/delete and source mutations cannot invalidate a successful final read before the synchronous handoff boundary.

An actual interaction-only native control/triage wake remains an interaction under business holds. Removing that interaction intent does not turn the same held source into admissible fresh business work. Already-started native local/remote reattachment is recovery of the recorded execution, not a new paid task: changed assignment, terminal business status, review, or schedule alone does not cancel receipt recovery. Current access, company/agent authority, Stop/cancellation, reservation generation, and native recovery-owner/lease fences still apply. A dead-runner replacement that starts new paid work still needs fresh business admission.

Human policy/external approval is not conflated with authorized independent internal-agent review. No operations action accepts a milestone or infers fulfillment from execution completion.

## Owned recurring-exception clock

A current authenticated human company owner, admin, or member can admit an exception for a readable, not-satisfied occurrence. A viewer, agent, externally authorized principal, or identity-less implicit board context cannot operate the clock. The selected owner must be a real active company user. Source authority and current operator/owner membership are checked again for continuing work and automatic delivery.

Admission writes the exception plus separate `received` and `admitted` events atomically. Their timestamps are the admission transaction's receipt time, not the occurrence's earlier scheduled time. The clock starts at admission. The operator must supply a nonblank reason, explicit owner, and offset-qualified future deadline; there is no silent default SLA.

The clock policy is UTC elapsed time:

1. **Pause** requires the current revision, a reason, an open unpaused exception, and a time strictly before the deadline and before escalation. Pausing exactly at the deadline is rejected.
2. **Resume** requires the current revision and an existing pause. It adds exactly the paused duration to the deadline and accumulates the duration in durable `clock_paused_total_ms`.
3. **Resolve** requires the current revision and a reason. It stops active age, preserves history, accounts for an in-progress pause, and removes pending retry/hold state. A current authorized operator can close an obligation after its former owner departs; closing does not delegate more work to that person.
4. A transition cannot move the clock backwards relative to the last committed update. Concurrent/stale transitions return a revision conflict rather than overwriting the winner.

Active SLA age excludes **all** completed and current pauses and freezes at resolution. Age since receipt is reported separately. Company pause or unavailable source/owner/operator authority blocks delivery but does not silently pause the SLA clock. A concrete undelivered obligation retains a 60-second native scheduled retry and an audited blocked reason. Explicit pause, resolution, or successful delivery removes that pending deadline.

Each occurrence has at most one admitted exception. This narrow policy has one escalation generation and no automatic reopen/reset. Exception transitions do not mutate an occurrence's fulfillment or acceptance.

### Escalation and replay

Once an open, unpaused deadline is due, the existing scheduled monitor queue invokes `tickExceptions`. Delivery revalidates current company authority, the original admitting operator's current membership, the current owner, and all occurrence sources. It creates one **private native internal task** assigned to the accountable human owner. There is no external notification or provider/network call in this transaction.

Task creation, the escalation receipt, exception revision/generation, and audit event commit atomically. Stable task origin/idempotency identity is `governance-operation:<companyId>:<exceptionId>:1`; the durable receipt is unique by exception and generation. A callback replay, second controller, restart, or failure before commit therefore reuses the logical effect instead of duplicating a task. An already delivered generation is not delivered again.

The escalation transaction follows the same company-first protocol as native creation. It acquires privacy serialization before its authority/source fences, not only when it eventually calls the native creator. Otherwise a privacy mutation could own privacy while waiting to update a source row that escalation already holds. The company lock still fences Stop/company-status changes, and the existing source, membership, owner, dedupe, and audit checks remain in force.

Short source-authority transactions take actual row/table fences. Contested source lifecycle work returns `409` rather than waiting in an inverted lock order or using a permissive fallback. Some authority fences cover native grant/member tables across companies; they are intentionally short, and no provider or external work occurs while they are held.

## HTTP controls

All routes are company-scoped under `/api/companies/:companyId/governance-operations`:

| Method/path | Payload |
| --- | --- |
| `GET /` | None; authorized bounded read model |
| `POST /occurrences/:occurrenceId/exceptions` | `{ reason, ownerUserId, deadlineAt }` |
| `POST /exceptions/:exceptionId/pause` | `{ expectedRevision, reason }` |
| `POST /exceptions/:exceptionId/resume` | `{ expectedRevision }` |
| `POST /exceptions/:exceptionId/resolve` | `{ expectedRevision, reason }` |

`ownerUserId` is a native text user identity, not necessarily a UUID. Payloads are strict. Invalid payloads return `400` at the router; authoritative lifecycle validation returns `422`; current-role denial returns `403`; inaccessible/missing sources return `404`; stale revisions or contested source authority return `409`. The real UI shows server failures and requires a fresh snapshot after conflicts.

## Integration boundary

Mount `governanceOperationsRouter(db)` under the application's existing `/api` router. Render `GovernanceOperations` from `ui/src/components/GovernanceOperations.tsx` with the selected real `companyId`. The client is `ui/src/api/governance-operations.ts`. Queries use the prefix `["governance-operations", companyId]` plus the resolved account/company scope and mounted-view lifetime; controls invalidate only their exact owned query.

Extend the existing `registerScheduledWork` options with the already-created service and deadline query:

```ts
const operations = governanceOperationsService(db);
registerScheduledWork(coordinator, db, {
  retryMs,
  tickTimers,
  tickRoutines,
  governanceOperations: {
    tickExceptions: () => operations.tickExceptions(),
    deadlineQuery: governanceExceptionDeadlineQuery,
  },
});
```

The option adds the SLA callback and its actual next deadline to the existing `issueMonitors` queue. Producer intents are registered transactionally before clock writes. Paused/resolved/delivered history does not create a timer. The existing coordinator owns coalescing, retry, startup reconstruction, drain/resume, and shutdown; no feature interval or second controller is introduced.

Schema and SQL are in `packages/db/src/schema/governance_operations.ts` and `0383_governance_operations.sql`. Production migration SQL adds no custom functions or triggers. The three schema exports, migration journal/snapshots, API mount, callback mount, and top-level navigation are integration-owned.
