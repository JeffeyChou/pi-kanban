# Kanban repository guide

## Purpose

Develop `kanban`, a local Pi extension for durable, low-noise Kanban sessions. The package entry point is `src/index.ts`; Pi loads it directly from `package.json`.

## Start here

1. Read `README.md` for supported user behavior and limitations.
2. Read `docs/development.md` before changing persistence, workflows, UI, `kanban_update`, or `init.sh`; then use the linked architecture/workflow/state reference for the subsystem being changed.
3. Inspect the relevant source module before editing it.
4. Run `./init.sh` before beginning a session; run `./init.sh --check` before handoff.

## Repository map

- `src/index.ts` – Pi commands, low-noise checkpoints, lifecycle hooks, resume, title generation, and stage kickoff.
- `src/store.ts` – compact v3 state, migrations, lock, mutations, selection, agents, and stage progression.
- `src/artifacts.ts` – compact plan snapshots and the one bounded handoff.
- `src/ui.ts` – themed selected-session widget and keyboard title picker.
- `init.sh` – start report and completion checks.
- `test/store.test.ts` – state, migration, lock, plan, and handoff tests.
- `test/extension.integration.test.ts` – command, checkpoint, UI, and resume tests.

## Core invariants

- `.kanban/state.json` is canonical repository-local control state; `.kanban/` stays untracked.
- Use the repository lock and mutation helpers for state changes. Do not hand-edit durable state in normal flows.
- State holds only unfinished sessions, selection, stage, conversation path, and agent name/role/status; completed sessions never remain in it.
- Plans use date-plus-safe-title filenames and contain progressive work detail without UUIDs, task/todo IDs, evidence, reviews, or source-file lists.
- `handoff.md` is the only handoff, stays within 200 physical lines, supplements rather than repeats state, and resets to the latest completed plan on final completion.
- Render only the selected session and only its title, current stage, context remaining bar, and number of agents working.
- Obtain context capacity from Pi's model/context APIs; never require a user-maintained model limit or render `unavailable`.
- Stage order is `refine → research → grill → compose → implement → critique`.
- Only explicit `kanban_update` `stage_complete` advances a stage. Do not advance stages implicitly.
- `kanban_update` is a low-frequency selected-session checkpoint: do not restore task/todo-level actions or identifier parameters.
- External scheduling remains external; record agent roles/statuses but do not claim that the extension launches agents.
- Resume a saved Pi conversation when available; otherwise seed a new one from the single handoff and selected plan.
- Never run `git add` or `git commit` automatically. After validation, output a suggested commit and let the user decide.

## Change guidelines

- Keep the TUI separate from persistence and plan/handoff artifact control.
- Preserve rehydration on `session_start`, durable handoffs across Pi conversations, and legacy v1/v2 migration.
- Lifecycle refreshes must not write state on every tool execution.
- Document behavior and limitations accurately; do not promise orchestration the code does not perform.
- Update tests with behavior changes, especially migration, locking, stages, resume, selection, checkpoint payloads, handoff bounds, and init checks.
- Keep `README.md` and `docs/development.md` consistent with implementation.

## Validation

Run before handing off:

```sh
npm run typecheck
npm test
./init.sh --check
```

For manual Pi verification, install from the local package path with `pi install /absolute/path/to/kanban`, then restart Pi or use `/reload`.
