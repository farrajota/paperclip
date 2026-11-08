# @paperclipai/server

## Unreleased

### Patch Changes
- Accept one-time schedule timestamps whose UTC offset is not a whole hour (for example `+05:30` or `+05:45`); offset hours and minutes were read from the wrong capture groups, so those timestamps were rejected as invalid and out-of-range offset hours were never range-checked.
- Added native one-time issue schedules with explicit UTC-offset/IANA-time-zone input, durable due wake intents, assignee/issue invalidation, native admission, cancellation, and persisted wake/run status in the issue detail UI.
- Refresh mounted one-time schedule cards through native run/activity invalidation, including due/admission receipts without a run; expose controls in default desktop/mobile task-chat Properties and Classic Activity, retaining normalized UTC text and HTML datetime for Date and string timestamps.
- Keep scheduling fields full-width and vertically stacked inside desktop and mobile Properties panes so required date/time and UTC-offset inputs neither overlap nor extend beyond the reader.
- Documented the existing native child-completion return barrier and packaged a reusable manager-led specialist delegation protocol in the Paperclip skill. No new coordinator or native return state was added.
- Scale the three background-drain waits in the reversed GitHub edit/delete ordering integration test by the opt-in `PAPERCLIP_TEST_TIMEOUT_FACTOR`; they used Vitest's implicit 1-second `waitFor` budget, and on the gVisor runner the ordered conversation drain crossed it (wrapper pipeline 3043257928). The default budget and every assertion are unchanged.
- Scale the server suite's 15-second per-test and 30-second hook/teardown Vitest budgets by the same opt-in `PAPERCLIP_TEST_TIMEOUT_FACTOR`; on the gVisor runner a `beforeEach` that re-imports the issue routes spent over 30 seconds in its cold module transform. Default budgets and every assertion are unchanged, and an invalid factor refuses to load the config.
- Scale the full streaming fixture's 180-second test budget and 120-second Git command budgets by the opt-in `PAPERCLIP_TEST_TIMEOUT_FACTOR` (1-10, default 1) for slower sandboxed CI runners; the 40,000-file workload and every assertion are unchanged, and an invalid factor fails the test instead of silently using another budget.
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
