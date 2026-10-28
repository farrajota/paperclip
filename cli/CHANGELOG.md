# paperclipai

## Unreleased

### Patch Changes

- Extend opt-in company portability diagnostics with bounded startup timings around the fixed `startup-workspace-prerequisites`, `startup-server-import`, and `startup-server-start` calls. The child emits at most six fixed-name outcome and elapsed-time frames only when the dedicated test flag is enabled; `enter` frames use elapsed time zero, and the fixture accepts only closed, canonical, ordered frames as setup observations.
  Artifacts retain the existing limits of 38 observations, 256 UTF-8 bytes per observation, and 8,192 UTF-8 bytes total, with elapsed times bounded to 0–3,600,000 ms. No raw errors or raw child stdout/stderr are included in the artifact; these timings do not diagnose startup cause.

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
  - @paperclipai/server@0.3.1

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
  - @paperclipai/server@0.3.0

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
  - @paperclipai/server@0.2.7

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
  - @paperclipai/server@0.2.6

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
  - @paperclipai/server@0.2.5

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
  - @paperclipai/server@0.2.4

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
  - @paperclipai/server@0.2.3

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
  - @paperclipai/server@0.2.2

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
  - @paperclipai/server@0.2.1
