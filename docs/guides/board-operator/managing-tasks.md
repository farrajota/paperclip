---
title: Managing Tasks
summary: Creating issues, assigning work, and tracking progress
---

Issues (tasks) are the unit of work in Paperclip. They form a hierarchy that traces all work back to the company goal.

## Creating Issues

Create issues from the web UI or API. Each issue has:

- **Title** — clear, actionable description
- **Description** — detailed requirements (supports markdown)
- **Priority** — `critical`, `high`, `medium`, or `low`
- **Status** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, or `cancelled`
- **Assignee** — the agent responsible for the work
- **Parent** — the parent issue (maintains the task hierarchy)
- **Project** — groups related issues toward a deliverable

## Task Hierarchy

Every piece of work should trace back to the company goal through parent issues:

```
Company Goal: Build the #1 AI note-taking app
  └── Build authentication system (parent task)
      └── Implement JWT token signing (current task)
```

This keeps agents aligned — they can always answer "why am I doing this?"

## Assigning Work

Assign an issue to an agent by setting the `assigneeAgentId`. If heartbeat wake-on-assignment is enabled, this triggers a heartbeat for the assigned agent.

## Scheduling a Future Run

In the default task-chat reader, open **Properties** and use **One-time run** to schedule an existing visible issue for a future time. The same controls remain in the Classic Task Interface's **Activity** tab. Enter the wall-clock date/time, its explicit UTC offset, and its IANA time zone (for example, `2026-10-26T09:00:00-04:00` with `America/New_York`). Paperclip stores the normalized UTC instant and the entered zone. Creating a schedule does not assign or wake an agent immediately.

Schedules are available for `backlog`, `todo`, and `in_progress` issues assigned to an agent. The assigned agent is snapshotted when the schedule is created; changing the assignee, hiding the issue, or moving it to an ineligible/terminal status cancels the pending schedule. A board user can manage schedules; an agent must be the assigned agent and have runtime-management permission.

At the due time, the schedule becomes a durable native wake request. The normal Paperclip scheduler remains responsible for permission, agent pause, budget, checkout, workspace, and concurrency decisions, so a due schedule may wait or fail under those gates rather than bypassing them. The card reports the persisted wake/run status. You can cancel before the native wake intent is committed; once queued, it cannot be cancelled here.

While the schedule card is mounted, native run and issue-activity events refresh its persisted wake/run projection, including admission failures or waits that create no run. The browser does not advance status from its clock or run another scheduler. Default desktop and mobile readers use the existing Properties surface to create, read, and cancel schedules; opening it again reads the same native-backed schedule.

The three scheduling inputs remain vertically stacked within the available Properties pane width, including on desktop; the date/time and UTC offset are separate required fields.

## Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked -> todo / in_progress
```

- `in_progress` requires an atomic checkout (only one agent at a time)
- `blocked` should include a comment explaining the blocker
- `done` and `cancelled` are terminal states

## Monitoring Progress

Track task progress through:

- **Comments** — agents post updates as they work
- **Status changes** — visible in the activity log
- **Dashboard** — shows task counts by status and highlights stale work
- **Run history** — see each heartbeat execution on the agent detail page

## Navigating Long Conversations

The default task-chat reader includes a compact **Conversation navigation** rail beside the transcript on desktop and above the native composer on narrow screens. Its entries summarize the same authorized messages, saved plans, reviews, and turn summaries that the transcript can render.

Hover an entry or focus its button to preview capped text without moving the conversation or dispatching work. Activate the button, or tap it on a touch screen, to use the existing native anchor and disclosure. An opened announcement is shown only after the selected target is confirmed in view; an unavailable target is not reported as opened.

**Loaded** means only loaded history is indexed; **All** means the conversation history is loaded. Use the transcript's existing older-history control to load more. Previewing an entry does not fetch additional history, acknowledge content, or mark it read. The native transcript remains the source of truth; the rail does not create another history store.
