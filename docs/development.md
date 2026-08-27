# Kanban development guide

This repository is a local Pi extension package. Pi discovers the extension from the `pi.extensions` entry in `package.json` and loads `src/index.ts` directly through Pi's TypeScript loader. There is no build artifact or standalone executable.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Registers `/kanban` and `kanban_update`; synchronizes Pi lifecycle state; starts the next workflow stage after explicit completion. |
| `src/store.ts` | Defines the durable schema, stage order, state migration, repository lock, atomic state write, task graph helpers, and progress calculations. |
| `src/artifacts.ts` | Generates per-session plan JSON and Markdown handoff artifacts. |
| `src/sources.ts` | Combines explicit source paths with source-shaped paths found in plan/handoff text, then filters to accessible paths below the repository root. |
| `src/ui.ts` | Renders the selected-session widget and title-based keyboard picker. |
| `test/store.test.ts` | Covers migration, locking, artifacts, source discovery, and dependency blocking. |
| `test/extension.integration.test.ts` | Covers command, stage, UI, and resume behavior with a mocked Pi host. |

## Local development

```sh
npm install
npm run typecheck
npm test
```

For manual extension testing, install the repository into Pi with an absolute path and restart Pi:

```sh
pi install /absolute/path/to/kanban
```

The package uses Pi's bundled `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` packages as peers. The two Pi library development dependencies are pinned to 0.84.3; the remaining development-tool versions follow their own package ranges.

## Durable model

`KanbanState` is persisted at `.kanban/state.json` and contains:

- schema version, sessions, the repository-wide selected-session ID, integration availability, and configured model context limits
- for each `Session`: title, stage/state, tasks, agents, reviews, source paths, artifact paths, Pi conversation metadata, activity, progress, and timestamps
- for each `Task`: state, dependency links, todos, assignment, importance, review state, and evidence

UUIDs are durable internal identifiers. The UI and commands use session titles; the agent receives IDs through `kanban_update` results when it must mutate a session.

### Schema and persistence

The current schema version is `2`. Version `1` state migrates in memory by adding source/artifact/activity/progress fields and context-limit storage; the migration is persisted on the next mutation. Version `2` data is trusted as-is, without runtime validation, so malformed manually edited state can fail later.

Every `mutate()` call obtains `.kanban/lock/` by creating the directory, writes `owner.json`, reads state, atomically replaces `state.json`, and releases the lock. Contention retries up to 100 times. This is a cooperative lock: it has no stale-lock recovery or PID liveness check, so confirm no mutation is active before clearing a stranded lock.

`persistSessionArtifacts()` writes `plans/<session-id>.json` and `handoffs/<session-id>.md` using atomic replacement. Artifact writes occur after the state mutation has released the repository lock. Consequently, individual files are atomic, but a state update and its artifacts are not one cross-file transaction; the artifacts may lag.

## Workflow and lifecycle

The fixed stage order is:

```text
refine → research → grill → compose → implement → critique
```

Creating a session starts at `refine`. Only `kanban_update` with `action: "stage_complete"` advances it; the tool records evidence, changes the stage (or marks the session complete after `critique`), and queues the next-stage kickoff message. It does not check task completion, reviews, evidence, blocked state, or prerequisites before advancing. Treat the prompt instruction to complete work first as an agent contract, not an enforcement mechanism.

`src/index.ts` refreshes state and the widget on `session_start` and `model_select`. It marks active work interrupted on `session_shutdown`; it updates activity on `agent_start` and after each tool execution. Refresh also records the active Pi conversation ID/path and current primary-agent model/context use on the selected session.

Selection is global to the repository, not bound to a Pi conversation. Multiple active Pi conversations sharing the same `.kanban/` directory can therefore overwrite selected-session metadata or update the wrong selected session. Avoid concurrent use until session ownership is made explicit.

## UI behavior

The widget renders only `selectedSession(state)` and includes:

1. title, stage, and state
2. primary model and current activity
3. context bar when `modelContextLimits[provider/model]` and Pi context usage are both available; otherwise an unavailable state
4. todo-derived progress and remaining todo text
5. discovered accessible source paths

`pickSession()` is an interactive overlay used by `list`, `select`, and `resume`. It shows title/stage/state and accepts Up/Down or `j`/`k`, Enter, and Escape. It intentionally does not use UUIDs as user controls. In a non-UI mode it returns no selection, so those commands make no change.

## Commands and resume

`/kanban create <title> [-- <description>]` creates/selects a session, records the current Pi conversation, and queues refine. The parser recognizes a description only when `--` has whitespace on both sides. `/kanban configure-context <provider/model> <tokens>` stores a positive explicit context limit.

`list`, `select`, and `resume` all first open the picker; a choice from any of them persists that session as selected. The picker expects at least one session, so create a session before opening it. For resume, a stored conversation path that exists on disk is switched to only when it differs from the current path. A missing path creates a new session seeded with the handoff artifact, which already contains the kickoff, then sends the kickoff again after startup. When the stored path is already current, resume only selects, names, and refreshes the session. This is a filesystem-existence check, not a guarantee that Pi can successfully load the conversation. The handoff is a summary; complete continuation relies on the canonical state file too.

## `kanban_update` contract

| Action | Required inputs | Persisted effect and validation |
| --- | --- | --- |
| `stage_complete` | `sessionId` | Records explicit completion and starts the next stage unconditionally. |
| `context_limit` | `sessionId`, positive `limit`; optional model in `text` | Stores a per-`provider/model` context limit. |
| `source_file` | `sessionId`, `text` | Stores an explicit source path. Display-time discovery rejects paths outside the repository and paths that cannot be accessed. |
| `task` | `sessionId`, `text` | Adds a pending task; optional `important` makes its review pending. |
| `task_state` | `sessionId`, `taskId`, valid state | Starts/completes only when prerequisites are complete; failed/cancelled tasks recursively mark dependents `blocked_manual`. |
| `todo` | `sessionId`, `taskId`, `text` | Adds a pending todo. |
| `todo_state` | `sessionId`, `taskId`, `todoId`, valid state | Changes a todo to pending, in progress, or completed. |
| `dependency` | `sessionId`, `taskId`, `prerequisiteId` | Records reciprocal prerequisite/subsequent links. |
| `assign` | `sessionId`, `taskId`, `agentId` | Assigns an existing agent and refreshes that agent's remaining todo IDs. |
| `review` | `sessionId`, important `taskId`, `text` | Records passed or failed review evidence for an important task. |
| `evidence` | `sessionId`, `taskId`, `text` | Appends task evidence. |
| `block` | `sessionId`, `taskId` | Fails or cancels a task, blocks dependents, and marks the session blocked. |

`importantCriteria` is currently accepted by the runtime schema but is not used by the implementation. Todo records have an evidence field, but no action adds todo-specific evidence. These are implementation limitations, not documented guarantees.

### Dependencies, reviews, and integration availability

Dependencies have no cycle detection. A cycle can prevent work from becoming eligible, and there is no explicit unblock action. `block` is one-way at the session level; manual state changes are required to reconsider work.

The extension records whether the active tool set includes `bg_run`, `subagent`, and `ask_user_question`. That detection does not launch background work, delegate subagents, or ask questions. Documentation and code should distinguish availability from orchestration.

## Source discovery

`discoverSessionFiles()` starts with explicit `session.sourceFiles`, reads the generated plan and handoff text, extracts source-shaped relative paths, removes paths outside `cwd`, and returns only local paths accepted by `fs.access()`. It is not a repository scanner and does not distinguish a regular file from a directory. New planned output files can remain stored as explicit paths before they exist, but appear in the widget only after creation.

## Testing and release checks

Run both repository checks before submitting documentation or code changes:

```sh
npm run typecheck
npm test
```

The automated tests are mocked/unit-level. Before release, also manually verify extension discovery in a clean Pi instance; session creation; picker keyboard navigation; context-limit display; source-file discovery; each stage transition; resume with an existing different path, a missing path, and an already-current path; and recovery behavior around repository locks. Add coverage before claiming a behavior is guaranteed, especially for corrupt state, empty pickers, dependency cycles, stale locks, cross-process access, artifact/state consistency, and failed resume loading.
