# @paperclipai/server

## Unreleased

### Patch Changes
- Hash files observed at 64 KiB or smaller with sequential reads into one fixed 8 KiB buffer through actual EOF, while larger files retain streaming; no size-based allocation or read limit is introduced, and no speedup is claimed.
- Admit small-file snapshot hashes through an ordered rolling queue of at most four capture-local 8 KiB slots; consume only the head and reuse its slot after awaited close and consumer resumption, while draining owned work before failures or traversal boundaries. No speedup or CI qualification is claimed.
- Encode NUL-delimited records directly into the existing 64 KiB chunk when each UTF-8 record fits, retaining byte-splitting fallback and write boundaries for larger records; no speedup is claimed.
- Add bounded test-only timings for the existing baseline snapshot, nested pack, and workspace staging spans in the full streaming fixture, labeled for initial and deletion stages. Diagnostics retain the original phase records and do not claim isolated span cost, cause, performance improvement, or CI qualification.
- Reuse each selected workspace overlay entry's checked `lstat` result for its staging copy, removing a duplicate source metadata lookup without changing path checks or copy semantics; no benchmark result is claimed.
- Skip the final removal request for a staged workspace file after its awaited rename succeeds; initial and failure cleanup remain unchanged, and no speedup is claimed.
- Group disk-manifest ignore membership into category-scoped queries over up to four exact path prefixes, preserving literal matching across deeper ancestors; no speedup or CI qualification is claimed.

- Write staging tar-entry and deleted-path NUL lists in bounded 64 KiB chunks instead of one filesystem write per filename, retaining exact filename bytes, path validation, ordered extraction/deletion, and awaited cleanup; no elapsed-time improvement is claimed.

- Validate each opened Linux ancestor path descriptor as a directory before advancing workspace and device-login credential reads, preserving existing leaf validation and descriptor cleanup.
- Partially evaluate bounded immutable single-segment workspace exclusions, omit only root-only patterns subsumed by the same literal segment, and reuse one bounded parent-prefix match; ambiguous and other patterns retain the original matcher, including empty-segment behavior. No measured speedup or CI qualification is claimed.

- Restore the server's declared MCP SDK and HTTP-injection dependencies to the pinned workspace lockfile so the stable-based fork installs with `pnpm@9.15.4 --frozen-lockfile`; runtime dependency declarations are unchanged.

- Bound full-tree workspace Git scans with process-wide concurrency, queue, timeout, cancellation, coalescing, and short-lived changed-file caching. Saturated or timed-out changed-file requests now return a retryable degraded response, and hidden file-browser panels no longer initiate scans.

- Observe allocated-port listener presence before looking up its owner so a stale empty result cannot discard a newly bound child. Unattributed listeners still fail closed, and attributable owners retain the 250 ms process-group stability check. All 196 affected local cases pass, including the unchanged 20-second unknown-owner regression and a synchronized startup-race regression; exact Hetzner CI qualification remains pending.
- Confirm an empty request listing with one fresh poll when stopping, so a stale empty snapshot from an in-flight poll cannot discard queued callback requests; the original drain deadline and missed-deadline 503 behavior remain unchanged. This describes source behavior and makes no CI-cause or qualification claim.

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
