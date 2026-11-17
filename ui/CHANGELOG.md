# @paperclipai/ui

## Unreleased

### Patch Changes

- Give the streamlined mobile task header a Show properties control that opens the existing Properties sheet. Its breadcrumb toggle only drives the desktop panel, so mobile users could not reach Properties (including the one-time run card) except through deep links or the inbox toolbar.
- Keep an agent run's retry denial on screen when the route canonicalizes from the agent's id to its URL key. The page keeps rendering the same agent while the canonical read loads, instead of falling back to a skeleton that discarded the run's local state; an agent of another company that shares the URL key is never kept.
- Surface native execution handoff context in the task Properties reader, keep completed workflows free of a false next stage, and distinguish pending review instructions from unavailable change-request reasoning. Label idle workflow actor absence separately from completed execution without changing native monitor or workflow behavior.
