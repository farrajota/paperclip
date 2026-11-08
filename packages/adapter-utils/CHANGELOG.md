# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Remove deleted workspace paths with one `rm` per 64-path batch instead of one process per path, after checking every ancestor in the batch with shell builtins. A symlink or non-directory ancestor now refuses the whole batch before anything in it is deleted. Spawning a process per path made a 40,000-path deletion take minutes under gVisor and timed out the streaming fixture in CI.
- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.
- Stage independent Git overlay entries in batches of at most four, preserving
  input order for overlapping destinations, per-entry root and ancestor checks,
  exclusions, and settlement of started copies before failure cleanup. Manifest
  consumption stays bounded; native command deadlines are unchanged.
  Reuse only bounded ancestor path spellings, never filesystem metadata; all
  root-identity and ancestor-type checks still run before and after each copy.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
