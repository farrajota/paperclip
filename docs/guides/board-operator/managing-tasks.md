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
