# Kanban architecture

This document is for agents and maintainers who need to change Kanban without reintroducing high-noise state updates or coupling durable control state to presentation.

## System boundary

Pi owns model invocation, context accounting, the active conversation, tool execution, and any external subagent/background-task facilities. Kanban is deliberately narrower: it records the selected repository-local work session and gives the active agent a compact durable workflow.

Kanban does **not** launch, cancel, or inspect external agents. When an external scheduler creates them, the active agent records their names, roles, and statuses in a material checkpoint.

| Owned by Pi | Owned by Kanban |
| --- | --- |
| Current model, context-window size, live context token count | Selected unfinished session and fixed workflow stage |
| Main-agent streaming/idle state | Compact external-agent roster and role/status records |
| Pi conversation switching and creation | Saved conversation path, plan snapshots, handoff, and migration |
| Tool scheduling and subagent execution | Low-frequency checkpoint contract and final-session cleanup |
| Git commands when an agent explicitly runs them | Never automatic staging or committing |

## Component contracts

| Module | Reads | Writes | Must not do |
| --- | --- | --- | --- |
| `src/index.ts` | Pi context, selected state, plan/handoff | Commands, checkpoints, stage transition artifacts, saved conversation path | Keep task/todo graphs, expose durable IDs, persist every tool event |
| `src/store.ts` | `.kanban/state.json` | Locked atomic v3 state; v1/v2 migration | Store work-item detail, evidence, source lists, model limits, or completed sessions |
| `src/artifacts.ts` | Existing plan/handoff | Atomic compact plan JSON and one bounded handoff | Duplicate state fields into the handoff |
| `src/ui.ts` | Selected state plus live Pi context | Ephemeral widget only | Mutate durable state or scan arbitrary repository files |
| `init.sh` | State, handoff, plans, Git metadata | No repository data | Stage, commit, or rewrite application code |

The one-way data relationship is intentional:

1. `state.json` answers **what session is active, at which stage, with which agents**.
2. Its `planPath` locates the progressive detail needed for a work decision.
3. `handoff.md` adds only context that would otherwise be lost between conversations: decisions, blockers, next steps, and verification information.
4. The widget combines state with Pi's live context and idleness signals, but never becomes a source of truth.

## Durability and mutation protocol

All state changes run through the cooperative repository lock in `store.ts`. A mutation creates `.kanban/lock/owner.json`, loads/migrates state, atomically replaces `state.json`, and releases the lock. Lock contention retries 100 times. There is no stale-lock owner-liveness check.

Artifact writes use a separate atomic replacement. A checkpoint writes its plan/handoff before the enclosing state mutation completes; a normal failed artifact write therefore leaves the previous state intact. Do not move artifact writes out of that protected checkpoint path without designing a replacement consistency strategy.

The only ordinary state writes are:

- create, select, or resume a session;
- a changed saved Pi conversation path on `session_start` or `model_select`;
- a material `checkpoint` or `stage_complete` call;
- one-time v1/v2 migration.

`agent_start`, `agent_end`, and `tool_execution_end` refresh the widget but do not mutate state. This protects both disk churn and agent context from a stream of bookkeeping tool calls.

## Session lifecycle

1. `/kanban create <prompt>` asks the current model for a short title. A local summary fallback makes creation independent of model availability.
2. The new v3 state record and initial plan are written; `handoff.md` receives its fixed operating rules and an empty supplement.
3. The kickoff asks the agent to run `./init.sh`, inspect the plan, and use only material checkpoints.
4. `stage_complete` advances the fixed sequence `refine → research → grill → compose → implement → critique`.
5. Final `critique` writes the plan with `status: "complete"`, removes the session from `state.json`, and replaces `handoff.md` with standby text pointing to that latest plan.

Because completed sessions are deliberately absent from state, `/kanban list`, `/kanban select`, and `/kanban resume` operate only on unfinished sessions. Historical review is file-based through `.kanban/plans/`.

## Extension seams and safe changes

When changing a feature, preserve these seams:

- Add a display field only when it can be derived from live Pi data or v3 core state. Do not make UI requirements expand the durable schema by default.
- Add plan detail only when it helps a later agent make a decision. Plans must remain readable without identifiers or verbose evidence arrays.
- Treat a checkpoint payload as a complete replacement for supplied plan sections. Do not add per-item mutation actions just to avoid sending one small array.
- If adding an external agent status, keep the primary agent special: its working count comes from `ctx.isIdle()`, while external agents are checkpointed.
- Any new state shape requires migration coverage, init validation updates, README/development documentation updates, and a no-auto-commit review.

## Non-goals

- Kanban is not a general project-management database.
- It is not a multi-conversation ownership coordinator.
- It is not a source-file tracker, evidence archive, review engine, or model-capacity catalog.
- It is not allowed to commit user work automatically.
