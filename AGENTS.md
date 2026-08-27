# Kanban repository guide

## Purpose

Develop `kanban`, a local Pi extension for durable, agent-driven Kanban sessions. The package entry point is `src/index.ts`; Pi loads it directly from `package.json`.

## Start here

1. Read `README.md` for supported user behavior and known limitations.
2. Read `docs/development.md` before changing persistence, workflows, UI, or the `kanban_update` tool.
3. Inspect the relevant source module before editing it.

## Repository map

- `src/index.ts` – Pi commands, tool registration, lifecycle hooks, and stage kickoff.
- `src/store.ts` – durable state types, migrations, lock, mutations, task graph, and progress.
- `src/artifacts.ts` – plan and handoff artifact persistence.
- `src/sources.ts` – explicit and artifact-derived local source-path discovery.
- `src/ui.ts` – selected-session widget and keyboard session picker.
- `test/store.test.ts` – storage, migration, locking, source, and dependency tests.
- `test/extension.integration.test.ts` – commands, workflow, UI, and resume tests.

## Core invariants

- `.kanban/state.json` is the canonical repository-local state; `.kanban/` stays untracked.
- Use the repository lock and `mutate()` for state changes. Do not hand-edit durable state in normal flows.
- UUIDs are durable internal IDs. User-facing commands, picker rows, and status should use session titles.
- Render only the selected session in the widget.
- Source visibility combines stored paths and paths discovered from plan/handoff artifacts; show only safe, accessible paths below the repository.
- Context remaining needs an explicit limit for the selected `provider/model`; otherwise show it as unavailable.
- Stage order is `refine → research → grill → compose → implement → critique`.
- Only explicit `kanban_update` `stage_complete` advances a stage. Do not advance stages implicitly.
- Failed or cancelled prerequisites leave dependents manually blocked.
- Resume an existing Pi conversation when its saved path is available; otherwise seed a new conversation from the durable handoff.

## Change guidelines

- Keep the TUI separate from state control and source-file discovery.
- Preserve rehydration on `session_start` and durable handoffs across Pi conversations.
- Document implemented behavior and limitations accurately; do not promise orchestration that the code does not perform.
- Update tests when behavior changes, especially state migration, concurrency, stages, resume, selection, or source discovery.
- Keep `README.md` and `docs/development.md` consistent with the implementation.

## Validation

Run before committing:

```sh
npm run typecheck
npm test
```

For manual Pi verification, install from the local package path with `pi install /absolute/path/to/kanban`, then restart Pi or use `/reload`.
