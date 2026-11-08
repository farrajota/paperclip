# @paperclipai/server

## Unreleased

### Patch Changes
- Select each failed or timed-out run's latest matching exhaustion receipt through a run-correlated lateral query, preserving tenant and lifecycle filters, compact payload fields and feed ordering; no measured speedup or CI qualification is claimed.
- Scale the full streaming fixture's 180-second test budget and 120-second Git command budgets by the opt-in `PAPERCLIP_TEST_TIMEOUT_FACTOR` (1-10, default 1) for slower sandboxed CI runners; the 40,000-file workload and every assertion are unchanged, and an invalid factor fails the test instead of silently using another budget.
- Load the native session executor at native execution, recovery, cancellation, steering and runtime-request operations instead of eager server setup, preserving canonical error identities, durable admission, warm ownership, cleanup and required recovery before readiness.
- Keep Discord compatibility errors available to root-thread receipt validation without importing the optional Chat SDK or Teams adapter, preserving the error's identity, code and message.
- Load the Chat SDK when replacing an SDK endpoint and load Slack, GitHub, Teams and Discord publication formatting during publication preparation, preserving synchronous endpoint construction, caller-owned initialization, replacement lifecycle guards, wrapper validation and transaction-time payload revalidation.
- Load DOM parsing and sanitization libraries only when processing SVG assets, announcement animations or rendered GitHub attachments, avoiding their eager server-startup cost while preserving sanitization, provenance checks and per-operation window cleanup.
- Load the Cursor Cloud SDK only for cloud execution or credentialed environment checks, retaining provider validation, remote dispatch ordering, session recovery and diagnostics without loading its dependency graph during server startup.
- Defer Paperclip's AWS S3 SDK imports until S3 storage creation, multipart uploads or AWS Secrets Manager credential resolution, preserving storage streaming, diagnostics and credential-cache ordering without eager imports from these optional consumers.
- Load Slack connector operations at their existing asynchronous assignment and execution boundaries instead of importing them with route and tool-gateway setup, preserving current authorization, catalog metadata, transaction boundaries and operation errors.
- Build independent worktree and ignored-file snapshot trees concurrently while retaining every content and state check; join both private-index pipelines before temporary-store cleanup and preserve the original error priority.
- Avoid repeating identical keyed newer-run lookups when building attention feeds, preserving per-agent, per-issue and millisecond-cutoff visibility for every failed run, including mixed-timestamp histories.
- Register the complete governance and recurring-occurrence API inventory with its actual request, response, nullable-planning and authorization contracts, including milestone followup delivery arrays and empty results, pagination validation HTTP 400 versus malformed-cursor HTTP 422, and occurrence owner/state validation HTTP 422; preserve indistinguishable missing/inaccessible-resource responses and board-only exception management.
- Recheck current private-source and instruction authority during native recovery, retain durable routine-task wake receipts through preparation, and allow only fully settled terminal checkouts to be reused. Keep scheduled retries owned through cleanup and preserve unknown or no-replay outcomes instead of launching provider work early.
- Reconcile an exact failed suspend's pending terminal receipt before stopping and draining an owned active Codex provider in a later maintenance epoch; cleanup and retirement still require the existing ownership and acknowledgement proof. Keep authorization polling during delivery-only recovery without redundant command-driving state reads competing with receipt acknowledgements; acknowledgement deadlines remain unchanged.
- Recognize Git's standard filesystem-boundary non-repository diagnostic for proven local-path/worktree configuration conflicts without hiding missing Git, damaged metadata, permission or I/O failures.
- Resolve automatically provisioned bundled routines through native company responsibility instead of treating the system audit label as a user. Repair proven legacy bundled ownership through a registered current-revision cutover, preserving real-user ownership, configuration, activity timestamps, triggers and historical revisions/runs; the new audit revision records migration time without rewriting routine activity. Unavailable or revoked authority remains fail closed.
- Add immutable goal outcome contracts, scoped observations and corrections, provenance and check-ins, with freshness/maturity-aware health separate from authorized task delivery. Enforce same-company native references and expose server-derived mutation capabilities.
- Add versioned, timezone-explicit issue planning and a bounded read-only governance calendar with distinct planning, forecast and actual events. Apply native resource authorization before visible bounds, reuse native bounded recurrence projection, preserve exact date instants, and reset all calendar/editor state on account or company changes.
- Add race-safe native business-work admission and an authorized governance operations view, with current private/source fences, transaction-bound earliest-start readiness, preserved interaction-only triage and fenced native reattachment, honest held/live/settled/unknown accounting, and owned recurring-exception SLA pause/resume/resolution plus one atomically deduplicated private internal escalation through the existing scheduled monitor queue. Custom-adapter Stop/isolation/metering and universal cross-controller slot enforcement are not implied. See `docs/guides/governance-operations.md`.
- Add native Case milestones with board-promoted immutable criteria and pinned playbooks, exact stored artifact evidence, independent user/agent review, stale-proof current acceptance and atomic accepted-revision-scoped internal follow-up receipts. Preserve private sources, run/Stop/key authority, decision history and ordinary task/handoff controls; stored native provenance is not external verification.
- Persist each original recurring schedule occurrence atomically with cursor advancement, pin approved routine and playbook revisions, and reuse native Case primary tasks and durable handoffs. Preserve distinct skipped, waived, waiting, unknown and accepted obligations across bounded catch-up, replay and recovery; sharing execution never implies that another obligation was fulfilled. Preserve the native company-scoped authorization boundary and assigned-agent management restriction for routine revision history: missing and inaccessible routines return the same 404, same-company non-assignee agents receive 403, and board and assigned-agent access remains subject to service-level current-definition and pinned-snapshot filtering. See `docs/guides/governance-occurrences.md`.
- For eligible bounded workspace-overlay entries, fresh native pre-copy ancestor/leaf checks return same-observation leaf mode/kind, followed by fresh post-copy root-identity/ancestor checks. After a successful ordinary file copy or reflink, the existing native binding may perform `chmod(staged sibling, captured mode)` then `rename` in one existing-pool async work. Unsupported binding/path/mode inputs or a Node permission-model process use the complete JavaScript chmod-then-rename pair; a started native operation failure propagates without JavaScript replay. JavaScript retains target replacement, initial staging cleanup, copy/reflink fallback, and cleanup after failed copy/chmod/rename; successful rename consumes the staged path and needs no final removal. Native operation failures expose Node-style `errno`, `code`, `syscall`, and `path` (plus `dest` for rename), and completion failure is hard. Remote deletion behavior is unchanged. No speedup or native/CI qualification is claimed.
- Reuse only the last bounded eligible ancestor pathname's immutable spelling check at the private native guard boundary, avoiding repeated JavaScript canonical-component and surrogate scans for that spelling. Each native guard request validates its arguments and performs the complete fresh ordered ancestor pass; unsupported guard inputs keep the full JavaScript route. No measured speedup, timeout cause, sufficient remedy, or CI qualification is claimed.
- Correct OpenCode final-response selection when native terminal-tool events and controller acceptance arrive in either order, preserving delayed same-message answers and the existing fallback for ambiguous attempts or identities.
- Load the source-mode server runner shim from its canonical required modules instead of the aggregate runner entry, preserving existing exports and canonical operation validation. Compiled runner vendoring is unchanged; no startup timing or CI qualification is claimed.
- Hash files observed at 64 KiB or smaller with sequential reads into one fixed 8 KiB buffer through actual EOF, while larger files retain streaming; no size-based allocation or read limit is introduced, and no speedup is claimed.
- Admit small-file snapshot hashes through an ordered rolling queue of at most four capture-local 8 KiB slots; consume only the head and reuse its slot after awaited close and consumer resumption, while draining owned work before failures or traversal boundaries. No speedup or CI qualification is claimed.
- Encode NUL-delimited records directly into the existing 64 KiB chunk when each UTF-8 record fits, retaining byte-splitting fallback and write boundaries for larger records; no speedup is claimed.
- Add bounded test-only timings for the existing baseline snapshot, nested pack, and workspace staging spans in the full streaming fixture, labeled for initial and deletion stages. Diagnostics retain the original phase records and do not claim isolated span cost, cause, performance improvement, or CI qualification.
- Reuse each selected workspace overlay entry's checked `lstat` result for its staging copy, removing a duplicate source metadata lookup without changing path checks or copy semantics; no benchmark result is claimed.
- Keep the complete JavaScript fallback for unsupported workspace-overlay guard inputs, with ordered callback-`lstat` ancestor checks and a microtask boundary between ancestor submissions; every ancestor remains freshly checked and failures retain their original propagation.
- Reuse one pass-local callback across workspace overlay ancestor submissions instead of allocating a callback for each ancestor, retaining serial fresh checks, per-pass state, error propagation, and microtask boundaries; no speedup, timeout cause, or CI qualification is claimed.
- Pass each workspace overlay entry's captured path arguments directly to both ancestor guards, avoiding its guard-wrapper closure and per-pass argument objects while retaining fresh checks, serial ordering, microtask boundaries, and error handling; no speedup, timeout cause, sufficient remedy, or CI qualification is claimed.
- Skip the final removal request for a staged workspace file after its awaited rename succeeds; initial and failure cleanup remain unchanged, and no speedup is claimed.
- Detect whether each deleted-path ancestor has a slash with POSIX `case` matching instead of prefix-removal expansion and string comparison; ancestor checks and per-path deletion remain ordered, with no speedup or CI qualification claimed.
- Group disk-manifest ignore membership into category-scoped queries over up to eight exact path prefixes, preserving literal matching across deeper ancestors; for an applicable 40,000-file pass where the leaf and four ancestors miss, this can avoid 40,000 JavaScript-to-SQLite query calls by fitting those candidates in one query instead of two. This is an inferred source-operation count, not a measured speedup or CI qualification.

- Write staging tar-entry and deleted-path NUL lists in bounded 64 KiB chunks instead of one filesystem write per filename, retaining exact filename bytes, path validation, ordered extraction/deletion, and awaited cleanup; no elapsed-time improvement is claimed.

- Validate each opened Linux ancestor path descriptor as a directory before advancing workspace and device-login credential reads, preserving existing leaf validation and descriptor cleanup.
- Partially evaluate bounded immutable single-segment workspace exclusions, omit only root-only patterns subsumed by the same literal segment, and reuse one bounded parent-prefix match; ambiguous and other patterns retain the original matcher, including empty-segment behavior. No measured speedup or CI qualification is claimed.

- Restore the server's declared MCP SDK and HTTP-injection dependencies to the pinned workspace lockfile so the stable-based fork installs with `pnpm@9.15.4 --frozen-lockfile`; runtime dependency declarations are unchanged.

- Bound full-tree workspace Git scans with process-wide concurrency, queue, timeout, cancellation, coalescing, and short-lived changed-file caching. Saturated or timed-out changed-file requests now return a retryable degraded response, and hidden file-browser panels no longer initiate scans.

- Observe allocated-port listener presence before looking up its owner so a stale empty result cannot discard a newly bound child. Unattributed listeners still fail closed, and attributable owners retain the 250 ms process-group stability check. All 196 affected local cases pass, including the unchanged 20-second unknown-owner regression and a synchronized startup-race regression; exact Hetzner CI qualification remains pending.
- Confirm an empty request listing with one fresh poll when stopping, so a stale empty snapshot from an in-flight poll cannot discard queued callback requests; the original drain deadline and missed-deadline 503 behavior remain unchanged. This describes source behavior and makes no CI-cause or qualification claim.

- Drain each runtime-skills fixture heartbeat service's active wakeup and run executions before resetting experimental settings or truncating fixture tables, replacing the arbitrary 100 ms teardown delay with the existing execution owner barrier. This addresses the observed teardown deadlock at the source lifecycle boundary; no test rerun or CI qualification is claimed.
- Defer canonical ACPX runtime namespace and SDK initialization until validated native runtime admission, before adapter factories or resources are constructed. Import failure and cancellation now reject admission with their original reason and an already-complete no-resource cleanup proof; cancellation does not wait for a pending import to settle. Cold admission now bears this initialization work, with no measured saving, exclusive-cause or sufficient-remedy claim, or CI qualification.
- Acquire each provider's canonical JSON Schema 2020 compiler during ACPX/OpenCode admission and pass its constructor into the bridge, while compiling validators at the existing bridge-start position. OpenCode open and recovery bind their operation signals around acquisition before filesystem admission; OpenCode recovery now requires `HarnessSessionRecoveryOptions.signal`, and the supervised CLI proxy passes inert `AbortSignal.any([])` because it has no cooperative operation signal, leaving its process-group/SIGTERM shutdown unchanged. Acquisition failures remain outside retries and recovery formatting. The bridge start API now requires `ajvConstructor`; the server's ordinary eager Ajv usage is unchanged. No performance or sufficiency claim is made.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1
  - @paperclipai/adapter-claude-local@0.3.1
  - @paperclipai/adapter-codex-local@0.3.1
  - @paperclipai/adapter-cursor-local@0.3.1
  - @paperclipai/adapter-gemini-local@0.3.1
  - @paperclipai/adapter-openclaw-gateway@0.3.1
  - @paperclipai/adapter-opencode-local@0.3.1
  - @paperclipai/adapter-pi-local@0.3.1
  - @paperclipai/db@0.3.1
  - @paperclipai/shared@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies [6077ae6]
- Updated dependencies
  - @paperclipai/shared@0.3.0
  - @paperclipai/adapter-utils@0.3.0
  - @paperclipai/adapter-claude-local@0.3.0
  - @paperclipai/adapter-codex-local@0.3.0
  - @paperclipai/adapter-cursor-local@0.3.0
  - @paperclipai/adapter-openclaw-gateway@0.3.0
  - @paperclipai/adapter-opencode-local@0.3.0
  - @paperclipai/adapter-pi-local@0.3.0
  - @paperclipai/db@0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.7
  - @paperclipai/adapter-utils@0.2.7
  - @paperclipai/db@0.2.7
  - @paperclipai/adapter-claude-local@0.2.7
  - @paperclipai/adapter-codex-local@0.2.7
  - @paperclipai/adapter-openclaw@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.6
  - @paperclipai/adapter-utils@0.2.6
  - @paperclipai/db@0.2.6
  - @paperclipai/adapter-claude-local@0.2.6
  - @paperclipai/adapter-codex-local@0.2.6
  - @paperclipai/adapter-openclaw@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.5
  - @paperclipai/adapter-utils@0.2.5
  - @paperclipai/db@0.2.5
  - @paperclipai/adapter-claude-local@0.2.5
  - @paperclipai/adapter-codex-local@0.2.5
  - @paperclipai/adapter-openclaw@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.4
  - @paperclipai/adapter-utils@0.2.4
  - @paperclipai/db@0.2.4
  - @paperclipai/adapter-claude-local@0.2.4
  - @paperclipai/adapter-codex-local@0.2.4
  - @paperclipai/adapter-openclaw@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.3
  - @paperclipai/adapter-utils@0.2.3
  - @paperclipai/db@0.2.3
  - @paperclipai/adapter-claude-local@0.2.3
  - @paperclipai/adapter-codex-local@0.2.3
  - @paperclipai/adapter-openclaw@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.2
  - @paperclipai/adapter-utils@0.2.2
  - @paperclipai/db@0.2.2
  - @paperclipai/adapter-claude-local@0.2.2
  - @paperclipai/adapter-codex-local@0.2.2
  - @paperclipai/adapter-openclaw@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.1
  - @paperclipai/adapter-utils@0.2.1
  - @paperclipai/db@0.2.1
  - @paperclipai/adapter-claude-local@0.2.1
  - @paperclipai/adapter-codex-local@0.2.1
  - @paperclipai/adapter-openclaw@0.2.1
