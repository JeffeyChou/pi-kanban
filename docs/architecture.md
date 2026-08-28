# Kanban architecture

This document is for agents and maintainers who need to change Kanban without reintroducing high-noise state updates or coupling durable control state to presentation.

## System boundary

Pi owns model invocation, context accounting, the active conversation, tool execution, and any external subagent/background-task facilities. Kanban is deliberately narrower: it records the selected repository-local work session and gives the active agent a compact durable workflow.

Kanban does **not** launch, cancel, or inspect external agents. When an external scheduler creates them, the active agent records their names, roles, and statuses in a material checkpoint.

| Owned by Pi | Owned by Kanban |
| --- | --- |
| Current model, context-window size, live context token count | Selected unfinished session and fixed workflow stage |
| Main-agent streaming/idle state | Compact external-agent roster and role/status records |
| Pi conversation switching and creation | Session selection, plan snapshots, handoff, and migration |
| Tool scheduling and subagent execution | Low-frequency checkpoint contract and final-session cleanup |
| Git commands when an agent explicitly runs them | Never automatic staging or committing |

## Component contracts

| Module | Reads | Writes | Must not do |
| --- | --- | --- | --- |
| `src/index.ts` | Pi context, selected state, plan/handoff | Commands, checkpoints, stage transition artifacts | Keep task/todo graphs, expose durable IDs, bind Pi conversation files, or persist every tool event |
| `src/store.ts` | `.kanban/state.json` | Locked atomic v4 state; v1/v2/v3 migration | Store work-item detail, evidence, source lists, model limits, Pi conversation paths, or completed sessions |
| `src/artifacts.ts` | Existing plan/handoff | Atomic compact plan JSON and one bounded handoff | Duplicate state fields into the handoff |
| `src/ui.ts` | Selected state plus live Pi context | Ephemeral widget only | Mutate durable state or scan arbitrary repository files |
| `init.sh` | State, handoff, plans, Git metadata | No repository data | Stage, commit, or rewrite application code |

The one-way data relationship is intentional:

1. `state.json` answers **what session is active, at which stage, with which agents**.
2. Its `planPath` locates the progressive detail needed for a work decision.
3. `handoff.md` adds only context that would otherwise be lost between conversations: decisions, blockers, next steps, and verification information.
4. The widget combines state with Pi's live context and idleness signals, but never becomes a source of truth. Its context row belongs to the current Pi conversation, never to a Kanban session.

## Durability and mutation protocol

All state changes run through the cooperative repository lock in `store.ts`. A mutation creates `.kanban/lock/owner.json`, loads/migrates state, atomically replaces `state.json`, and releases the lock. Lock contention retries 100 times. There is no stale-lock owner-liveness check.

Artifact writes use a separate atomic replacement. A checkpoint writes its plan/handoff before the enclosing state mutation completes; a normal failed artifact write therefore leaves the previous state intact. Do not move artifact writes out of that protected checkpoint path without designing a replacement consistency strategy.

The only ordinary state writes are:

- create, select, rename, pause, unpause, or remove a session;
- a material `checkpoint` or `stage_complete` call;
- one-time v1/v2/v3 migration.

`agent_start`, `agent_end`, and `tool_execution_end` refresh the widget but do not mutate state. This protects both disk churn and agent context from a stream of bookkeeping tool calls.

## Session lifecycle

1. `/kanban create <prompt>` asks the current model for a short title. A local summary fallback makes creation independent of model availability.
2. The new v4 state record and initial plan are written. The global `handoff.md` is created only if absent, so existing continuity text is preserved.
3. `create`, `open`, and `resume` start a fresh Pi conversation from the selected plan plus the global handoff. The seed states that the selected plan is authoritative because the handoff may describe a previously selected session.
4. `stage_complete` advances the fixed sequence `refine → research → grill → compose → implement → critique`.
5. Final `critique` writes the plan with `status: "complete"` and removes the session from `state.json`; it replaces `handoff.md` with standby text only when no active session remains.

Because completed sessions are deliberately absent from state, dashboard management and current-session commands operate only on unfinished sessions. `remove` permanently deletes its confirmed selected session and plan. Historical review is file-based through `.kanban/plans/`.

## Extension seams and safe changes

When changing a feature, preserve these seams:

- Add a display field only when it can be derived from live Pi data or v4 core state. Do not make UI requirements expand the durable schema by default.
- Add plan detail only when it helps a later agent make a decision. Plans must remain readable without identifiers or verbose evidence arrays.
- Treat a checkpoint payload as a complete replacement for supplied plan sections. Do not add per-item mutation actions just to avoid sending one small array.
- If adding an external agent status, keep the primary agent special: its working count comes from `ctx.isIdle()`, while external agents are checkpointed.
- Any new state shape requires migration coverage, init validation updates, README/development documentation updates, and a no-auto-commit review.

## Non-goals

- Kanban is not a general project-management database.
- It is not a multi-conversation ownership coordinator.
- It is not a source-file tracker, evidence archive, review engine, or model-capacity catalog.
- It is not allowed to commit user work automatically.
