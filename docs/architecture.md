# Kanban architecture

This document is for agents and maintainers who need to change Kanban without reintroducing high-noise state updates or coupling durable control state to presentation.

## System boundary

Pi owns model invocation, context accounting, the active conversation, tool execution, and any external subagent/background-task facilities. Kanban is deliberately narrower: it records the selected repository-local work session, gives the active agent a compact durable workflow, and runs the pipeline stages (refine, research, grill, compose) in its own internal child sessions.

Kanban never invokes third-party subagent/background-task tools. Installed tools (`pi-subagents` / `pi-background-tasks` / `rpiv-ask-user-question`) are only detected by name and named in the implement kickoff. When an external scheduler creates agents, the active agent records their names, roles, and statuses in a material checkpoint.

| Owned by Pi | Owned by Kanban |
| --- | --- |
| Current model, context-window size, live context token count | Selected unfinished session, fixed workflow stage, and session `mode` |
| Main-agent streaming/idle state | Internal pipeline child sessions (in-process or subprocess runner) and the abort registry |
| Pi conversation switching and creation | `/kanban open`-initiated implement conversation; pipeline itself never switches conversations |
| Tool scheduling and external subagent execution | Compact external-agent roster and role/status records |
| Model/auth resolution for child sessions (L1 limits it to `~/.pi/agent`-registered providers) | Per-stage model config and fallback to the parent model |
| Git commands when an agent explicitly runs them | Read-only git, worktree scaffolding, and `git apply` without `--index`; never automatic staging or committing |
| Filesystem isolation for child sessions (Kanban has none to give) | Per-iteration `git worktree` experiment isolation for the implement loop |

## Component contracts

| Module | Reads | Writes | Must not do |
| --- | --- | --- | --- |
| `src/index.ts` | Pi context, selected state, plan/handoff | Commands, checkpoints, critique-gate mutations | Keep task/todo graphs, expose durable IDs, switch conversations mid-pipeline, or inject followUp kickoffs |
| `src/store.ts` | `.kanban/state.json` | Locked atomic v4 state; v1/v2/v3 migration; session modes and pipeline tokens | Store work-item detail, evidence, source lists, model limits, Pi conversation paths, or completed sessions |
| `src/artifacts.ts` | Existing plan/handoff | Atomic compact plan JSON (plus the bounded archive-time `completion` record) and one bounded handoff | Duplicate state fields into the handoff or accumulate review archives |
| `src/orchestrator.ts` | State, workfile, config, prompt grammar | Child sessions, title-keyed abort registry, locked one-stage commits, workfile sections, the implement-loop run handle | Run children under the lock, auto-switch conversations, or commit without token revalidation |
| `src/implementloop.ts` | Config `loop`, plan prompt, workfile `## compose`, loop breadcrumbs | Private `kanban-autoresearch/<base>` commits for accepted candidates, durable run/history records, final patch landing, one locked implement→critique commit | Stage or commit the user's checkout; commit a failed/unmeasured/reverted candidate; measure before capturing the candidate; land without re-checking HEAD/cleanliness/token; or treat the baseline as a success |
| `src/worktree.ts` | Repository git state | Detached worktrees, private experiment refs/commits, per-attempt `kanban-audit/<base>` snapshots, patches captured and applied without the index, experiment-path staging | Touch the user's checkout's index or HEAD from an iteration, shell-interpolate a path, move HEAD or the experiment branch from an audit write, or commit an accepted candidate outside `kanban-autoresearch/<base>` |
| `src/measure.ts` | The opt-in `loop.validate`/`loop.metric` commands | Nothing durable; a `MeasureOutcome` | Throw, run git, write files, leave a process group alive after a timeout, or let a failing `loop.validate` skip `loop.metric` |
| `src/looplog.ts` | `.kanban/loop/*`, `.kanban/worktrees/*/manifest.json` | Per-base run manifest, iteration log, living summary, best patch, landed marker, worktree manifest | Use a shared global path or sweep a worktree whose owner PID is alive |
| `src/runner.ts` | Child spec | Pass-through child-session text | Throw; both backends return `ChildResult` errors |
| `src/prompts.ts` | Stage inputs | Prompt/system-prompt text, parsed stage output | Mention `init` in stage prompts |
| `src/config.ts` | Defaults, global + repository config files | Resolved merged `KanbanConfig` | Require a user-maintained model limit |
| `src/capabilities.ts` | `pi.getActiveTools()` | Detected external-tool names | Invoke or configure external tools |
| `src/workfile.ts` | `.kanban/work/<base>.md` | One `## <stage>` section at a time (300-line cap) | Write outside the protected locked-commit path |
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

- create, select, rename, pause, unpause, or remove a session (pause/remove/rename also abort any live pipeline run and clear its token);
- a material `checkpoint` or `stage_complete` call;
- an orchestrator stage commit or critique-gate mutation;
- one-time v1/v2/v3 migration.

`agent_start`, `agent_end`, and `tool_execution_end` refresh the widget but do not mutate state. This protects both disk churn and agent context from a stream of bookkeeping tool calls.

## Lock protocol and pipeline commits

Child sessions never run under the repository lock. The orchestrator runs each refine/research/grill/compose child lock-free, and the critique-gate child runs lock-free inside `stage_complete(critique)`; the lock is only ever held for the short commit that follows a successful child.

Per child stage, exactly one locked `mutateAsync` commit happens after a successful child:

1. Revalidate: session by title exists, `state === "active"`, `mode === "pipeline"`, `stage === expected`, `pipelineToken === ours`, and no abort signal.
2. On success: write the workfile section (inside the lock, the same protected pattern as existing checkpoint artifact writes) and advance exactly one stage.
3. On mismatch: commit nothing; notify; stop the pipeline. A late child after pause/remove/rename commits and writes nothing, so no orphan workfile is created.

The critique gate follows the same shape with its own CAS generation: `stage_complete(critique)` first mints a fresh gate token in a locked mutation, then runs the gate child lock-free, and every post-gate mutation revalidates that token. All agent-owned mutations (checkpoint, every `stage_complete` variant, the gate-token mint, `/kanban complete`) include `state === "active"` and the expected stage in their locked predicate, so a paused session refuses to advance, arm/run a gate, or archive.

Runner backends: the in-process runner (extension-free child session built on `DefaultResourceLoader` + `createAgentSession`) is the default; the subprocess runner (`pi -p` print mode, prompt via stdin, full `--no-*` flag parity) is the escape hatch and the `runner: "subprocess"` config choice. Both honor the resolved per-stage model. Known limitation L1: a child runtime builds auth/models from `~/.pi/agent` files, so providers registered dynamically via `pi.registerProvider` may not authenticate in a child; the runner classifies this as `errorKind: "model"` and the manual-fallback path reports it.

Cross-process pause takes effect at stage boundaries: the orchestrator reloads state between stages, so a `blocked`/missing session only stops the pipeline between children, never mid-child.

## Session lifecycle

1. `/kanban create <prompt>` asks the current model for a short title. A local summary fallback makes creation independent of model availability.
2. The new v4 state record and initial plan are written. The global `handoff.md` is created only if absent, so existing continuity text is preserved.
3. `create` and `/kanban open` (no argument means the selected session; blocked sessions are refused with a notify) hand the session to the orchestrator when it is in pipeline mode. Pipeline child stages (refine, research, grill, compose) run in internal child sessions, one output section per stage in the workfile; a fast-path refine `simple` verdict can skip research and grill.
4. After the compose commit the pipeline ends with a notify — it never switches conversations itself. User-initiated `/kanban open` (or dashboard Enter) opens a fresh Pi conversation seeded with handoff + plan + workfile spec + one implement kickoff (init-start if configured, external-tools line). Manual-mode entries into implement deliver the same kickoff.
5. `stage_complete(implement)` makes the single implement→critique transition. Final `stage_complete(critique)` runs the critique gate (pipeline mode) or the manual summary path (manual mode, or pipeline mode after a durable gate-child failure): PASS or the accepted summary writes the plan with `status: "complete"` and a bounded `completion` record, deletes the workfile, and removes the session from `state.json`; it replaces `handoff.md` with standby text only when no active session remains. See agent-workflow.md for the gate contract and its enforced attempts cap.
6. `/kanban complete` is the escape hatch for a critiqued session while `plan.pendingCompletion` exists; it converts that record into the plan's `completion` field through the same locked completion.
7. `pause`/`remove`/`rename` abort any live pipeline run via the title-keyed registry, unregister it, and clear the session's `pipelineToken` before mutating; `unpause` restarts nothing (a later `/kanban open` mints a new token). A recreated same-title session can never match a stale token.

Because completed sessions are deliberately absent from state, dashboard management and current-session commands operate only on unfinished sessions. `remove` permanently deletes its confirmed selected session, plan, and workfile (aborting a live run first). Historical review is file-based through `.kanban/plans/`.

## Extension seams and safe changes

When changing a feature, preserve these seams:

- Add a display field only when it can be derived from live Pi data or v4 core state. Do not make UI requirements expand the durable schema by default.
- Add plan detail only when it helps a later agent make a decision. Plans must remain readable without identifiers or verbose evidence arrays.
- Treat a checkpoint payload as a complete replacement for supplied plan sections. Do not add per-item mutation actions just to avoid sending one small array.
- If adding an external agent status, keep the primary agent special: its working count comes from `ctx.isIdle()`, while external agents are checkpointed.
- Any new state shape requires migration coverage, init validation updates, README/development documentation updates, and a review of the private-branch versus user-checkout Git boundary.

## Non-goals

- Kanban is not a general project-management database.
- It is not a multi-conversation ownership coordinator: it runs internal child sessions for pipeline stages, but the user's main conversation and Pi conversation switches stay out of its control (the pipeline ends with a notify and `/kanban open` does the only switch).
- It is not a source-file tracker, evidence archive, or model-capacity catalog. The critique gate is a workflow gate, not an archive: the one bounded archive-time `completion` record is the only review data a plan may carry.
- It is not allowed to commit user work automatically.
