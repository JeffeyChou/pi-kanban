# Kanban

Kanban is a local [Pi](https://github.com/badlogic/pi-mono) extension for a single selected, durable agent-work session per repository. It keeps the active workflow compact in `.kanban/state.json`, puts work detail in progressive plan snapshots, and gives later conversations a short durable handoff.

Kanban is a Pi extension package, not a standalone service. Pi loads `src/index.ts` directly from `package.json`.

## Install

```sh
pi install /absolute/path/to/kanban
```

Restart Pi after installation, or use `/reload` after editing the package. Start Pi in the repository where the `.kanban/` harness should live.

## Start a session

```text
/kanban create refresh persistence and improve the session UI
```

The prompt is the session brief. Kanban asks the current authenticated Pi model for a short title, then falls back to a safe local prompt summary if title generation is unavailable. It creates and selects the session, creates its plan, and begins `refine`.

Before implementation, the kickoff requires the agent to run:

```sh
./init.sh
```

The staged workflow is fixed:

```text
refine → research → grill → compose → implement → critique
```

Only `kanban_update` with `stage_complete` advances a stage. A final `critique` completion archives the plan and removes the completed session from `state.json`.

## Commands

| Command | Behavior |
| --- | --- |
| `/kanban create <prompt>` | Generates a short title, creates and selects a durable session, then queues `refine`. |
| `/kanban list` | Opens the title-based session picker and selects the chosen unfinished session. |
| `/kanban select` | Opens the same picker and changes the selected session. |
| `/kanban resume` | Resumes the saved Pi conversation when available; otherwise seeds a new conversation from `handoff.md` and the selected plan. |

The picker shows title, stage, and state. Use ↑/↓ or `j`/`k`, Enter to choose, and Escape to cancel. It never exposes internal identifiers because active sessions are selected by title.

## Low-noise checkpoints

`kanban_update` works only on the selected session. There are no session, task, or todo IDs and no task-level actions.

| Action | Use |
| --- | --- |
| `checkpoint` | Record one material update to scope, agent roster, compact work summary, or handoff. |
| `stage_complete` | Record an optional checkpoint and explicitly move to the next stage, or complete the final stage. |

A checkpoint may supply `inScope`, `outOfScope`, a complete `agents` roster (`name`, `role`, `status`), `work` (`done`, `current`, `next`), and a replacement `handoff` supplement. Use it at stage boundaries or when the plan materially changes—not after each tool call or todo.

Kanban records externally scheduled agents but does not itself launch Pi background tasks or subagents. The widget derives the primary agent's live state from Pi and combines it with checkpointed external-agent statuses.

## Selected-session widget

The task-style widget above Pi's editor intentionally shows only four things:

```text
☐ Refresh durable persistence
  ◉ Stage 5/6 · implement
  Context remaining  [██████████░░] 211k / 272k · 77%
  ● Agents working 2
```

Context capacity comes directly from Pi's active model and context-usage APIs. It no longer requires a manually configured model limit and does not display `unavailable`; immediately after compaction it uses the last known token usage, or zero if none exists yet.

## Durable files

`.kanban/` stays untracked and contains:

- `state.json` — schema v3 canonical core state: selected unfinished session, stage, saved conversation path, agent names/roles/statuses, and timestamps.
- `plans/YYYY-MM-DD-safe-title.json` — compact, reviewable session detail: prompt, scope boundaries, agents, work summary, status, and timestamps. Completed session plans remain here.
- `handoff.md` — one handoff, capped at 200 lines. Its fixed rules are followed by supplemental decisions, blockers, next steps, and verification notes; it does not restate state fields.
- `lock/` — cooperative mutation lock.

Version-1 and version-2 state migrates automatically when Kanban initializes. Migration creates compact date/title plans, removes completed sessions from core state, creates the new handoff, and removes legacy UUID-named plans and `handoffs/` only after the new data is written.

`state.json` is atomically replaced under the lock. Plan and handoff writes are individually atomic; do not hand-edit `.kanban/` while a Pi session is mutating it.

## Start and finish checks

```sh
./init.sh
./init.sh --check
```

The default command quickly reports the selected Kanban session, current branch, five most recent commit subjects, and working-tree summary. `--check` additionally validates state/plan/handoff constraints, verifies no completed session remains in `state.json`, runs `git diff --check`, `npm run typecheck`, and `npm test`.

Neither Kanban nor `init.sh` runs `git add` or `git commit`. After a successful final check, the script and the final agent response provide a suggested commit message and affected files; the user decides whether and when to commit.

## Development

```sh
npm run typecheck
npm test
```

Read [docs/development.md](docs/development.md) before modifying persistence, workflow, TUI, `kanban_update`, or the validation script.

For agent-facing reference material, use:

- [Architecture and module boundaries](docs/architecture.md)
- [Agent operating guide and checkpoint cadence](docs/agent-workflow.md)
- [State and artifact reference](docs/state-and-artifacts.md)
- [Troubleshooting and verification](docs/troubleshooting.md)

## Current limitations

- Kanban records externally orchestrated agents but does not launch, cancel, or monitor Pi subagents/background tasks itself.
- Session selection is repository-wide; do not use multiple active Pi conversations against the same board concurrently.
- The cooperative lock has no stale-lock owner-liveness recovery.
- `resume` only verifies that the saved conversation path exists; it cannot guarantee Pi can load it.
- The model-generated title is a short independent completion. It can incur the current model's normal request cost and falls back locally on failure.
