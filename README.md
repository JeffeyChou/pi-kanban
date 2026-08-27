# Kanban

Kanban is a local [Pi](https://github.com/badlogic/pi-mono) extension for keeping one selected, durable agent-work session per repository visible while work progresses. It is a Pi extension package – not a standalone CLI. Its manifest loads `src/index.ts` when Pi starts.

A board persists in the repository-local `.kanban/` directory. The widget deliberately renders only the selected session, so its activity, todos, progress, model, context budget, and source files remain readable while an agent works.

## Requirements

- Pi 0.84.3 (the version used to develop and test this package)
- Node.js and npm for local development

## Install into Pi

Install the package from an absolute path:

```sh
pi install /absolute/path/to/kanban
```

Pi records a local package path; it does not copy the repository. Restart Pi to load the extension, or use Pi's `/reload` after changing the package. Start Pi from the repository where you want the `.kanban/` harness to live.

## Quick start

In an interactive Pi session:

```text
/kanban create Documentation refresh -- explain setup and developer workflows
```

Creation selects the new session, sets the Pi session title, creates durable state, and queues the `refine` stage. Continue the staged workflow with the agent. It must explicitly call the `kanban_update` tool with `stage_complete` to move between stages:

```text
refine → research → grill → compose → implement → critique
```

Stage progression is recorded and queues the next stage automatically. It is agent guidance, not a policy gate: the extension does not independently verify that every task, review, or prerequisite is complete before accepting `stage_complete`.

## Commands

| Command | Behavior |
| --- | --- |
| `/kanban create <title> [-- <initial description>]` | Creates and selects a durable session, then starts `refine`. Put whitespace on both sides of `--` before an optional description. |
| `/kanban list` | Opens the session picker. It does not render an all-session board; choosing a title also changes the selected session. |
| `/kanban select` | Opens the same session picker and changes the selected session. |
| `/kanban resume` | Opens the picker and selects that session. It switches to a different existing Pi conversation, creates a new conversation for a missing path, or only refreshes when the stored path is already current. |
| `/kanban configure-context <provider/model> <tokens>` | Sets the explicit context-window limit used for the selected model's remaining-context display. |

The picker is available only in an interactive UI and requires at least one existing session; create one first. It displays session titles, stages, and states – never UUIDs as normal controls. Use ↑/↓ or `j`/`k` to choose, Enter to confirm, and Escape to cancel.

## Selected-session widget

The widget above Pi's editor displays only the selected session:

- current stage and session state
- primary model and recent activity
- configured context remaining, as a bar, or `unavailable` until that model has a configured limit
- completed/total progress and outstanding todo text
- associated local source files

The context figure is `configured limit − Pi-reported current tokens`. A limit is a user-supplied value keyed by `provider/model`; it is not obtained from a provider catalog.

## Durable state and handoffs

The `.kanban/` folder is ignored by this repository's `.gitignore` and contains:

- `state.json` – the canonical board state: sessions, tasks, todos, agents, reviews, selected-session mapping, model limits, and integration availability
- `plans/<session-id>.json` – a generated per-session planning snapshot
- `handoffs/<session-id>.md` – a generated per-session resume summary
- `lock/` – a cooperative repository mutation lock

The extension writes `state.json` atomically while holding its lock. It writes plan and handoff artifacts afterward, so those artifacts can temporarily lag the canonical state. Avoid sharing one board across multiple active Pi conversations: selection is repository-wide, and lifecycle updates apply to whichever session is currently selected. A crashed process can also leave a stale lock that must be cleared manually after confirming no other Pi process is mutating the board.

### Source files

Agents can associate paths explicitly through `kanban_update` with `source_file`. The widget also extracts source-shaped repository-relative paths from the session plan and handoff artifacts. It displays only paths that `fs.access()` can reach below the repository root; it does not scan the repository or show arbitrary artifact text as paths. The current check does not distinguish regular files from directories.

### Resume behavior

`/kanban resume` has three paths:

1. If the stored Pi conversation path exists and differs from the current conversation, Pi switches to it and queues the current stage.
2. If the stored path is absent, Pi starts a new conversation seeded with the durable handoff. The kickoff is included in that seed and sent again after the replacement session starts, so the stage instruction can appear twice.
3. If the stored path is already the current conversation, Pi only selects, names, and refreshes the session; it does not queue another kickoff.

The existence check is filesystem-only. The handoff is a summary, not a full board export, so `.kanban/state.json` must remain available to retain task, todo, review, and agent details.

## Agent updates

`kanban_update` is the agent-facing tool that records task and todo changes, dependencies, assignment, review evidence, source paths, context limits, blocks, and stage completion. Its session and task IDs are durable internal values returned to the agent; user-facing commands and the picker use session titles instead.

Tasks can be marked important at creation. Reviews are accepted only for important tasks, and review evidence is persisted. If a prerequisite task fails or is cancelled, dependent tasks are marked `blocked_manual` pending manual reconsideration.

## Validation

```sh
npm run typecheck
npm test
```

## Current limitations

- Background-task, subagent, and question-tool availability is detected, but this package does not itself launch or orchestrate those integrations.
- The cooperative lock has no stale-lock recovery or cross-process owner liveness check.
- Dependencies are not cycle-checked, and blocked tasks have no dedicated unblock action.
- `list`, `select`, and `resume` do nothing in headless mode because the picker requires an interactive Pi UI.
- Version-2 state is trusted without runtime schema validation. Do not hand-edit or treat `.kanban/` as safe-to-share metadata: it can contain repository paths and Pi conversation paths.
