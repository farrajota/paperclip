# Task creation and lifecycle

People create, assign, organize, discuss, and finish tasks. A task retains its owner, project, priority, history, and outputs as it moves through the work lifecycle.

Implementation: [new task](../ui/src/components/NewIssueDialog.tsx), [task list](../ui/src/pages/Issues.tsx), [task detail](../ui/src/pages/IssueDetail.tsx).

## Sub-features

- `create`: capture a title/request with the intended agent, project, and attachments.
- `organize`: filter, sort, group, and navigate tasks without losing the selected context.
- `properties`: change status, priority, assignee, project, and relationships where authorized.
- `discussion`: persist comments, references, and files on the task.
- `completion`: distinguish backlog, active work, review, blocked, done, and cancelled outcomes.

## How to get to it (user POV)

### `new-task`

Use New task from the global launcher, task list, or project task view.

### `task-list`

Open `/issues` or a project’s Issues view; legacy `/tasks` links redirect.

### `task-detail`

Open `/issues/:issueId` from a row, mention, or direct link.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use an invokable test agent and a project; record whether a real or simulated harness handles the request.

### `new-task`

Automated: [creation dialog](../ui/src/components/NewIssueDialog.test.tsx) is component coverage with mocked requests.

Manual: Create a uniquely named task with an agent and project. Open its resulting link and reload. Confirm text, attachment, assignment, and project persisted, and verify execution started only when the task and agent are eligible.

### `task-list`

Automated: [task-list helpers](../ui/src/pages/Issues.test.tsx) cover search URLs, pagination, deduplication, and presentation constants. The suite does not render the page or exercise filtering, grouping, opening a task, and returning; those interactions still need a running-browser check.

Manual: Filter by status and assignee, change grouping/sort, open a task, and return. Verify the correct records and selected view survive navigation and reload. Include an empty result and a failed request.

### `task-detail`

Automated: [task detail](../ui/src/pages/IssueDetail.test.tsx) covers component behavior, while [issue service](../server/src/__tests__/issues-service.test.ts) covers server contracts.

Manual: Add a comment and edit authorized properties. Reload and verify history, actor, and values. Complete a disposable task and inspect its deliverable; reopen through an available action and confirm the next execution follows current policy.

### `conversation-navigation`

In the task conversation, use the compact edge rail to jump among rendered messages, saved plans, review summaries, and meaningful turn summaries. Hovering or keyboard focus previews capped plain text in a stationary card beside (not inside) the overflow-scrolling rail, and outlines the existing transcript row without moving the reading position. Selecting a turn summary uses its native disclosure, scrolls to that selected summary, and reports a landing only when the summary itself intersects the actual viewport; it does not substitute visibility of the containing message. The index excludes hidden nested tool/thinking rows and does not reconstruct their contents. A `Loaded` rail label means older history remains available to fetch; it is not a claim that the thread is complete. The rail and preview do not fetch history, write reading state, or invoke an agent.

Historical and superseded runs keep their authorized replies and inspectable activity without reviving obsolete failure, stop, or success labels in the rail or preview. Historical classic folds are labeled `Activity` with their existing metrics; native timeline headers retain only the rendered agent identity. A historical turn whose renderer has no summary header does not gain a synthetic status entry, and nested activity is still owned by the transcript renderer.

On narrow native task readers, the horizontal rail occupies a slot above the composer inside the existing sticky composer dock. Composer drafts, accessories, and the existing mobile-nav/safe-area bottom offset therefore move both controls together, rather than leaving the rail at a guessed fixed height behind the editor. The stationary preview opens above the rail over the transcript, outside the rail's overflow region and outside dock layout flow; opening it does not resize the composer dock. Desktop edge navigation retains its existing placement. Qualify narrow access with real button-center hit tests and touchscreen taps on the settled native reader, including a grown draft and visible/hidden mobile navigation; keyboard activation alone is not touch evidence.

For a credential-free built-component check, use the existing Storybook story `Task chat/Mobile streaming follow / Streaming` in the built Storybook bundle; it renders the actual `TaskChatThreadView` with synthetic messages and navigation enabled. `/dev/task-chat-lab` is a separate DEV-only route using the same renderer and its synthetic state switcher; it is not a production-bundle path. Use Main's isolated built task-detail candidate with synthetic persisted comments/documents for history paging, plan/review entries, Back/document return, and the five-target retrieval comparison.
For the long-thread baseline, reuse [`issueChatLongThreadFixture.ts`](../ui/src/fixtures/issueChatLongThreadFixture.ts) (`issueChatLongThreadComments`, 469 deterministic synthetic comments) as isolated persisted seed input for the native task-detail route; add synthetic plan/review/turn entries for those cases. Its current perf-page consumer uses the classic thread, so the comparison must be opened through the redesigned task-detail surface, not `IssueChatLongThreadPerf`.
Manual retrieval comparison: on the same built candidate and the same synthetic long-thread fixture, prepare five numbered decision/artifact targets spanning early, middle, and recent history. First retrieve each target using the existing scroll-only path, then repeat in a randomized order with the rail; record elapsed time, correct target count, and whether the target was already in loaded history. Also check hover/focus without scrolling, turn expansion, older-history indication, Back/document return, latest-follow, keyboard use, and narrow touch access. Use no live task or provider run; record the observed result rather than treating a test or screenshot as user-value evidence.

## Gotchas

- A status label alone does not prove that the requested work exists.
- Single-assignee and atomic checkout rules still apply when tasks are created from different hosts.
- Use [coordination](./task-coordination.md), [steering](./steering.md), and [documents](./documents-artifacts.md) for their distinct workflows.
