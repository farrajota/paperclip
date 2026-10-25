# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

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
