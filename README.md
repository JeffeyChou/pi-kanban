# Kanban

Kanban is a local [Pi](https://github.com/badlogic/pi-mono) extension for a single selected, durable agent-work session per repository. It keeps the active workflow compact in `.kanban/state.json`, puts work detail in progressive plan snapshots, and gives later conversations a short durable handoff. Kanban sessions are deliberately independent from Pi's native conversation files.

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
| `/kanban` | Opens the keyboard-driven Kanban dashboard. ↑/↓ or `j`/`k` previews a session's status; Enter selects it and opens a clean Pi conversation; Tab opens management mode, where Enter opens, `r` renames, and `x` permanently deletes after confirmation. Rename/delete return to the refreshed dashboard; only opening a session leaves it. |
| `/kanban create <prompt>` | Generates a title, creates/selects the durable session, then opens a clean Pi conversation seeded with the plan and global handoff. |
| `/kanban pause` / `/kanban unpause` | Marks the currently selected session `blocked` or `active` without changing its stage. |
| `/kanban remove` | Permanently deletes the currently selected session and its plan after confirmation. |

The dashboard is rendered as a bordered editor-area panel, not a floating transcript overlay. Escape closes it. It never exposes internal identifiers because active sessions are selected by title.

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
  Current Pi context  [██████████░░] 211k / 272k · 77% remaining
  ● Agents working 2
```

Context capacity comes directly from Pi's active model and context-usage APIs. This row belongs to the **current Pi conversation**, not the selected Kanban session. It no longer requires a manually configured model limit and does not display `unavailable`; immediately after compaction it uses the last known token usage for that Pi conversation, or zero if none exists yet.

## Durable files

`.kanban/` stays untracked and contains:

- `state.json` — schema v4 canonical core state: selected unfinished session, stage, agent names/roles/statuses, and timestamps. It never stores Pi conversation paths.
- `plans/YYYY-MM-DD-safe-title.json` — compact, reviewable session detail: prompt, scope boundaries, agents, work summary, status, and timestamps. Completed session plans remain here.
- `handoff.md` — one handoff, capped at 200 lines. Its fixed rules are followed by supplemental decisions, blockers, next steps, and verification notes; it does not restate state fields.
- `lock/` — cooperative mutation lock.

Version-1, version-2, and version-3 state migrates automatically when Kanban initializes. Legacy migration creates compact date/title plans, removes completed sessions from core state, creates the new handoff, and removes legacy UUID-named plans and `handoffs/` only after the new data is written. Version 3 migration preserves unfinished sessions while removing their saved Pi conversation paths.

`handoff.md` is global rather than per session. Selecting, opening, pausing, renaming, or removing one session preserves it; a newly opened Pi conversation is told that the handoff may describe a previously selected session and that its selected plan takes precedence. `state.json` is atomically replaced under the lock. Plan and handoff writes are individually atomic; do not hand-edit `.kanban/` while a Pi session is mutating it.

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
- Kanban cannot prevent Pi itself from opening or continuing a native Pi conversation; it simply does not bind that conversation to a Kanban session. The context widget reports the conversation Pi currently has open.
- The model-generated title is a short independent completion. It can incur the current model's normal request cost and falls back locally on failure.
