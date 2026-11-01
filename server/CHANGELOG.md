# @paperclipai/server

## Unreleased

### Patch Changes
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

- Validate each opened Linux ancestor path descriptor as a directory before advancing workspace and device-login credential reads, preserving existing leaf validation and descriptor cleanup.

- Restore the server's declared MCP SDK and HTTP-injection dependencies to the pinned workspace lockfile so the stable-based fork installs with `pnpm@9.15.4 --frozen-lockfile`; runtime dependency declarations are unchanged.

- Bound full-tree workspace Git scans with process-wide concurrency, queue, timeout, cancellation, coalescing, and short-lived changed-file caching. Saturated or timed-out changed-file requests now return a retryable degraded response, and hidden file-browser panels no longer initiate scans.

- Observe allocated-port listener presence before looking up its owner so a stale empty result cannot discard a newly bound child. Unattributed listeners still fail closed, and attributable owners retain the 250 ms process-group stability check. All 196 affected local cases pass, including the unchanged 20-second unknown-owner regression and a synchronized startup-race regression; exact Hetzner CI qualification remains pending.

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
