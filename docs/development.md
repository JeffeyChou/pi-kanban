# Kanban development guide

Kanban is a local Pi extension. `package.json` points Pi at `src/index.ts`; there is no build output or standalone server.

Before changing an unfamiliar subsystem, read the matching agent reference: [architecture](architecture.md), [operating workflow](agent-workflow.md), [state/artifacts](state-and-artifacts.md), or [troubleshooting](troubleshooting.md).

## Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Commands, low-noise `kanban_update`, title generation, lifecycle refreshes, resume, and stage kickoff. |
| `src/store.ts` | Schema v3, legacy migration, repository lock, atomic state writes, compact session selection, agent roster updates, and stage advancement. |
| `src/artifacts.ts` | Plan JSON and the single bounded `handoff.md`. |
| `src/ui.ts` | Themed four-line selected-session widget and title-based keyboard picker. |
| `init.sh` | Fast session-start report and `--check` completion validation. |
| `test/store.test.ts` | Schema, migration, lock, agent, filename, and handoff persistence tests. |
| `test/extension.integration.test.ts` | Command, checkpoint, stage, UI, title, picker, and resume integration tests. |

## Local development

```sh
npm install
npm run typecheck
npm test
./init.sh --check
```

For a manual Pi test, install from an absolute local path and restart Pi or use `/reload`:

```sh
pi install /absolute/path/to/kanban
```

## Durable model

`KanbanState` is schema version 3:

```ts
{
  schemaVersion: 3,
  selectedSessionTitle?: string,
  sessions: Array<{
    title: string,
    stage: "refine" | "research" | "grill" | "compose" | "implement" | "critique",
    state: "active" | "blocked",
    planPath: string,
    piConversationPath?: string,
    agents: Array<{ name: string, role: string, status: "working" | "idle" | "blocked" }>,
    createdAt: string,
    updatedAt: string
  }>,
  updatedAt: string
}
```

Only unfinished sessions live in state. Titles must be unique while active and serve as the user-facing selector; UUIDs are neither needed nor exposed. Keep `state.json` restricted to current control state. Work details belong in plans, and supplemental continuation information belongs in the single handoff.

Every mutation uses `.kanban/lock/` and atomically replaces `state.json`. The lock is cooperative, retries contention 100 times, and has no stale-lock recovery. Preserve this behavior unless a separately designed liveness mechanism replaces it.

### Plans and handoff

Plans live at `plans/YYYY-MM-DD-safe-title.json`; collisions use `-2`, `-3`, and so on. A plan has only `title`, `prompt`, `stage`, `status`, `inScope`, `outOfScope`, `agents`, `work` (`done`, `current`, `next`), and timestamps. Do not add UUIDs, task/todo IDs, evidence, reviews, or source-file lists back into this artifact.

`handoff.md` has fixed operating rules followed by a replacement-style supplement. It must stay at or below 200 physical lines. It must not duplicate title, stage, or agent roster from state. When the final critique stage completes, it is reset to standby with only the latest completed title and plan path.

Version-1 and version-2 data migrates under the repository lock. The migration writes compact plans for all legacy sessions, keeps only unfinished ones in v3 state, creates a suitable active/standby handoff, then removes legacy UUID artifacts. Keep this ordering so a failed migration does not discard reviewable history.

## Workflow and lifecycle

Stage order is fixed:

```text
refine → research → grill → compose → implement → critique
```

`stage_complete` is the only advancement mechanism. It may include a checkpoint payload. The final call writes the plan as `complete`, removes the session from state, resets the handoff, and asks the agent to run `./init.sh --check`; it does not commit.

`session_start` and `model_select` only persist a changed Pi conversation path. `agent_start`, `agent_end`, and `tool_execution_end` refresh the widget from durable state and Pi live data without writing state. Do not reintroduce a per-tool activity log or per-tool mutation: low write frequency and low prompt noise are core requirements.

The current Pi model creates a short title when `/kanban create <prompt>` is issued. That private completion must have a local fallback and must not inject an extra title-generation turn into the user conversation.

## `kanban_update` contract

The tool implicitly targets `selectedSession(state)`. It accepts no session, task, todo, dependency, or source IDs.

| Action | Required behavior |
| --- | --- |
| `checkpoint` | Requires at least one change to scope, agents, work, or handoff. Replaces supplied plan fields and optionally replaces the handoff supplement. |
| `stage_complete` | Optionally records the same checkpoint fields, then advances exactly one stage; final completion archives and removes the core session. |

The shared fields are `inScope?: string[]`, `outOfScope?: string[]`, `agents?: { name, role, status }[]`, `work?: { done?, current?, next? }`, and `handoff?: string`. An agents payload is a complete external roster; the primary coordinator remains represented even when omitted. Tool results must stay concise and must not return whole state or internal IDs.

Kanban does not launch background work. It records externally scheduled agents and displays the live primary-agent activity plus externally checkpointed `working` agents.

## UI and resume

The selected-session widget is exactly four logical lines: task title, current stage, context remaining bar, and number of agents working. It uses `ctx.getContextUsage().contextWindow/tokens` and `ctx.model.contextWindow`, never `modelContextLimits`. When tokens are transiently null after compaction, retain the last observed token count and fall back to zero; do not render `unavailable`.

The title picker is the only interactive multi-session control. `resume` switches to an existing saved Pi conversation when its path exists. Otherwise it creates a new conversation seeded with `handoff.md` and the selected plan, then sends one kickoff. It does not resume completed sessions because they are intentionally absent from state.

## `init.sh` and release checks

`./init.sh` is read-only and reports session context, branch, recent commits, and working tree. `./init.sh --check` validates v3 state selection and active plans, checks the physical handoff line cap, runs `git diff --check`, `npm run typecheck`, and `npm test`, then prints an unexecuted suggested commit.

The script, kickoff, tool guidance, and final handoff must all preserve the no-auto-commit rule. Never add `git add` or `git commit` to extension or script automation.

Before submitting changes, run:

```sh
npm run typecheck
npm test
./init.sh --check
```

Manual Pi verification should cover generated and fallback titles; all six stages; material checkpoints; title picker navigation; context on more than one model; primary/external agent counts; resume via both existing and missing conversation paths; v1/v2 migration; final plan retention with state cleanup; and the no-auto-commit final output.
