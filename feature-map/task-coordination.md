# Delegation, dependencies, and signoff

A larger task can coordinate child work, dependencies, reviewers, and execution controls while preserving a clear owner and a traceable completion decision. For reusable manager/roster/role/instruction packaging and child-result acceptance, see the [Paperclip skill's specialist delegation protocol](../skills/paperclip/SKILL.md#managing-specialist-child-work).

Implementation: [task thread](../ui/src/pages/IssueDetail.tsx), [execution policy and child-return barrier](../server/src/services/issues.ts).

## Native child-result return

When a direct child becomes `done` or `cancelled`, the issue route asks the native issue service whether every direct child is terminal. A `blocked` child keeps the barrier closed; `cancelled` is terminal but is not evidence of successful work. Once the barrier opens, the assigned parent manager receives the `issue_children_completed` wake with child IDs and bounded summaries. The service includes summaries for at most 20 children, using each child's latest non-deleted comment, preferring the just-completed child's result where supplied, and truncating each inline body to 500 characters. The wake is a pointer/context, not the durable deliverable: open child tasks and follow their document/work-product links before accepting results.

The native return wakes the responsible parent assignee; it does not synthesize a manager decision, finish the parent, or override pause/budget, blocker, checkout/concurrency, or independent-review policy. The manager checks each child against its acceptance criteria, links usable child results from the parent, then records a synthesis or an explicit escalation and next owner. Team membership is roster context only. Use supported assignment or an addressed interaction, never @-mentions or a polling loop, to dispatch/wake an actor.

This repository has fixture evidence, not an autonomous two-specialist manager acceptance: no real provider/agent run is authorized by this qualification. Reviewers must distinguish source/test evidence from real model synthesis and artifact usability.

## Sub-features

- `delegation`: inspect parent/child tasks and the original request behind delegated work.
- `dependencies`: show blocking tasks and wake eligible work when prerequisites resolve.
- `signoff`: apply the configured implementation/review completion policy.
- `tree-control`: pause or resume a task tree without bypassing its gates.

## How to get to it (user POV)

### `task-relationships`

Open the task’s parent/child and dependency links in task detail.

### `review-and-controls`

Inspect the task’s execution policy and available review, pause, resume, or stop controls.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a parent, child, and dependent task plus implementer/reviewer agents. Record execution policy and use a disposable tree.

### `task-relationships`

Automated: [issue service](../server/src/__tests__/issues-service.test.ts) verifies the two-child barrier stays closed while one child is blocked, then returns both done/cancelled children; [issue routes](../server/src/__tests__/issue-dependency-wakeups-routes.test.ts) verifies `issue_children_completed` carries linked child IDs and summaries in payload/context; [heartbeat dispatch](../server/src/__tests__/heartbeat-dependency-scheduling.test.ts) verifies durable native wake coalescing into one run and recovery of the duplicate intent. These are fixture/service/route/dispatch tests, not model-driven synthesis.

Manual: In an authorized disposable company, prepare an assigned manager and two specialist children with self-contained acceptance criteria. Keep one child blocked and confirm no parent return wake; resolve it, complete both children with linked durable results, and confirm the manager re-enters once, opens both results, accepts them against criteria, then posts a linked synthesis or explicit escalation. Separately exercise a failed child via its first-class blocked path and a cancelled child as non-success terminal input; verify parent remains truthful, and pause/budget/checkout/independent review gates are unchanged. This autonomous manager/provider run remains unapproved; do not execute it as part of this fixture qualification.

### `review-and-controls`

Automated: [execution policy](../server/src/__tests__/issue-execution-policy.test.ts), [tree control](../server/src/__tests__/issue-tree-control-service.test.ts), and [signoff browser suite](../tests/e2e/signoff-policy.spec.ts) target these layers. A linked suite is not a claim that its current run is green.

Manual: Complete implementation under a review-required policy and confirm it waits for the required review outcome. Exercise rejection and later approval. Pause the parent while child work is pending, then verify resumption respects budget and ownership gates.

## Gotchas

- Review completion and task completion are different events under some policies.
- Pausing a tree must not be “tested” by changing statuses until the screen looks quiet.
- Use [questions and approvals](./questions-and-approvals.md) for decision forms and [recovery](./recovery.md) for interrupted work.
