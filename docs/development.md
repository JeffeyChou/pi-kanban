# Kanban development guide

Kanban is a local Pi extension. `package.json` points Pi at `src/index.ts`; there is no build output or standalone server.

Before changing an unfamiliar subsystem, read the matching agent reference: [architecture](architecture.md), [operating workflow](agent-workflow.md), [state/artifacts](state-and-artifacts.md), or [troubleshooting](troubleshooting.md).

## Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Commands (`create`, `open`, `config`, `complete`, `pause`, `unpause`, `remove`), the `kanban_update` tool with the critique gate, title generation, lifecycle refreshes, and resume. |
| `src/store.ts` | Schema v4 (+ optional `mode`/`pipelineToken`), legacy migration, repository lock, atomic state writes, compact session selection, agent roster updates, and stage advancement. |
| `src/orchestrator.ts` | The pipeline engine: child-stage commits, research fan-out, grill Q&A, the title-keyed abort registry, and the model-resolving critique-gate seam. |
| `src/runner.ts` | In-process and subprocess child-session backends behind the frozen `RunChild` seam. |
| `src/prompts.ts` | Per-stage prompts, the output grammar (`parseStageOutput`), the implement kickoff, and the completion text. |
| `src/config.ts` | Merged global + repository config with auto-detected init commands. |
| `src/capabilities.ts` | Active external-tool detection for the implement kickoff. |
| `src/implementloop.ts` | The opt-in orchestrator-owned implement loop: iteration worktrees, fitness, lessons, termination, landing. Read `docs/plans/loop-driver-v2.md` first. |
| `src/worktree.ts` | Plain-git worktree/patch primitives. Never `git add`/`git commit`; `git apply` never gets `--index`. |
| `src/measure.ts` | Runs the opt-in `loop.validate`/`loop.metric` commands in their own process group; parses `METRIC <name>=<value>`. |
| `src/looplog.ts` | `.kanban/loop/<base>.*` breadcrumbs and the owner-PID worktree manifest. |
| `src/workfile.ts` | The `.kanban/work/<base>.md` section artifact. |
| `src/artifacts.ts` | Plan JSON (including the bounded archive-time `completion` record) and the single bounded `handoff.md`. |
| `src/ui.ts` | Themed four-line selected-session widget and title-based keyboard picker. |
| `src/pipelineprogress.ts` | Ephemeral stage heartbeat, child activity/counts, and bounded process-local timing samples. |
| `src/liveprogress.ts` | Bounded process-local implement activity/output shared by runner, measurement, and UI; no durable writes. |
| `src/usage.ts` | Signal-keyed child context estimates and cumulative reported token/cost totals; no durable writes. |
| `src/progressevents.ts` | Process-local, microtask-coalesced progress notifications; no timers or polling. |
| `src/status.ts` | Bounded on-demand status/output/results/plan queries for the command and read-only tool. |
| `init.sh` | Fast session-start report and `--check` completion validation. |
| `test/store.test.ts` | Schema, migration, lock, agent, filename, and handoff persistence tests. |
| `test/*.test.ts` | Unit tests per module plus command, checkpoint, stage, gate, UI, title, picker, and resume integration tests. |

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

`KanbanState` is schema version 4:

```ts
{
  schemaVersion: 4,
  selectedSessionTitle?: string,
  sessions: Array<{
    title: string,
    stage: "refine" | "research" | "grill" | "compose" | "implement" | "critique",
    state: "active" | "blocked",
    mode?: "pipeline" | "manual",      // missing ⇒ manual (legacy)
    pipelineToken?: string,            // CAS identity of the live run / armed gate
    planPath: string,
    agents: Array<{ name: string, role: string, status: "working" | "idle" | "blocked" }>,
    createdAt: string,
    updatedAt: string
  }>,
  updatedAt: string
}
```

Only unfinished sessions live in state. Titles must be unique while active and serve as the user-facing selector; UUIDs are neither needed nor exposed. Keep `state.json` restricted to current control state: it must never store a Pi conversation path. Work details belong in plans, and supplemental continuation information belongs in the single global handoff.

Every mutation uses `.kanban/lock/` and atomically replaces `state.json`. The lock is cooperative, retries contention 100 times, and has no stale-lock recovery. Preserve this behavior unless a separately designed liveness mechanism replaces it.

### Plans and handoff

Plans live at `plans/YYYY-MM-DD-safe-title.json`; collisions use `-2`, `-3`, and so on. A plan has `title`, `prompt`, `stage`, `status`, `inScope`, `outOfScope`, `agents`, `work` (`done`, `current`, `next`), timestamps, and the optional pipeline fields `complexity`, `critiqueAttempts`, `pendingCompletion`, `gateFailure`, and the archive-time `completion` record (the one sanctioned exception to the no-review-records rule; its note is capped at 10 lines). Do not add UUIDs, task/todo IDs, evidence archives, or source-file lists back into this artifact.

`handoff.md` has fixed operating rules followed by a replacement-style supplement. It must stay at or below 200 physical lines. It must not duplicate title, stage, or agent roster from state. When the final critique stage completes, it is reset to standby with only the latest completed title and plan path.

Version-1 and version-2 data migrates under the repository lock. The migration writes compact plans for all legacy sessions, keeps only unfinished ones in v4 state, creates a suitable active/standby handoff, then removes legacy UUID artifacts. Version-3 migration preserves unfinished sessions while dropping saved Pi conversation paths. Keep this ordering so a failed migration does not discard reviewable history.

## Workflow and lifecycle

Stage order is fixed:

```text
refine → research → grill → compose → implement → critique
```

In pipeline mode the orchestrator advances the child-owned stages (refine → compose), one stage per locked commit; `stage_complete` advances the agent-owned stages (implement, critique) and every stage in manual mode. When `config.loop.enabled`, `/kanban implement` makes implement orchestrator-owned too: it is the durable autoresearch loop. Kept candidates are committed only to `kanban-autoresearch/<base>` and a manifest plus JSONL history rehydrates a later fresh child; its final branch diff lands as unstaged working-tree changes and its locked state commit advances implement→critique. Final completion stages only accepted experiment paths and suggests a user commit message; it never commits the user checkout. Transition instructions ride in the tool result — there is no queued kickoff injection.

`session_start` and `model_select` load the durable board and refresh its widget, but never persist or switch Pi conversation paths. `agent_start`, `agent_end`, and `tool_execution_end` refresh the widget from durable state and Pi live data without writing state. Do not reintroduce a per-tool activity log or per-tool mutation: low write frequency and low prompt noise are core requirements.

The current Pi model creates a short title when `/kanban create <prompt>` is issued. That private completion must have a local fallback and must not inject an extra title-generation turn into the user conversation.

## `kanban_update` contract

The tool implicitly targets `selectedSession(state)`. It accepts no session, task, todo, dependency, or source IDs.

| Action | Required behavior |
| --- | --- |
| `checkpoint` | Requires at least one change to scope, agents, work, or handoff. Replaces supplied plan fields and optionally replaces the handoff supplement. |
| `stage_complete` | Optionally records the same checkpoint fields, then advances exactly one stage; final completion archives and removes the core session. |

The shared fields are `inScope?: string[]`, `outOfScope?: string[]`, `agents?: { name, role, status }[]`, `work?: { done?, current?, next? }`, and `handoff?: string`. An agents payload is a complete external roster; the primary coordinator remains represented even when omitted. Tool results must stay concise and must not return whole state or internal IDs.

Kanban launches its own internal child sessions for the pipeline stages and the critique gate (see `src/orchestrator.ts` and `src/runner.ts`); those children appear in the roster with a `Kanban ` prefix while they run. External scheduling tools remain external: they are only named in the implement kickoff when detected. `stage_complete` at critique accepts `rerunCritique` / `acceptRemainingIssues` / `critiqueSummary` per the gate contract in agent-workflow.md.

Planning defaults are `research: { workers: 2, depth: "focused" }`,
`compose: { detail: "plan" }`, and `pipeline: { childTimeoutMs: 300000 }`.
Worker groups must cover all three research angles even with fewer workers. Depth/detail limits
are prompt budgets; only the per-child wait timeout is enforced. Timeout aborts the child signal
and uses the existing stage failure/manual fallback; successful partial research can still commit.
The timeout never applies to implement or critique children, or to measurement commands.

Compose uses a Markdown plan with level-3 summary, goals/non-goals, approach, implementation
steps, validation/acceptance, and risks/assumptions sections (headings may be translated; the
outer `## compose` stays fixed). `plan` targets 120–240 lines for substantial tasks; small tasks
stay shorter. `concise` and `detailed` remain compatible with 100-/220-line prompt budgets.
Before commit, reject a compose body over 299 lines so the heading plus plan fits within 300.
Use the existing manual fallback without publishing an automatically truncated plan.
`/kanban plan` is a read-only preview of the recorded compose section and never opens a new conversation.

Grill output adds `Option: label | description` lines to the legacy `Q:`/`Recommended:` grammar.
The recommended label is reordered first, option descriptions render on a second line, and free
text is last. Record the selected label and description in the workfile. `Questions: none` is
intentional; other unparseable output still warns. Questions, options and budgets do not add
Session fields or additional child turns. Headless/skip/Escape preserve explicit ASSUMED answers.

Child start/finish are roster milestones written under the existing lock. Tool/stream activity
and the planning-stage heartbeat never write state. In-process children subscribe to Pi session events;
subprocess children use print mode with JSON events and extract the final assistant message.
Keep `RunChild`, `ChildSpec`, and `ChildResult` unchanged. Late callbacks and timer cleanup must
respect abort/run identity so an old run cannot overwrite a new run's status.

## UI and resume

The selected-session widget is exactly four logical lines: task title, stage, executor context
remaining, and agents working. During internal runs the context row names the stage and uses
child model/usage data. Parallel workers' windows must never be summed: show the lowest remaining
percentage and identify workers awaiting data, with individual values in `/kanban progress`.
Otherwise show **Current Pi context**, using `ctx.getContextUsage()` and `ctx.model.contextWindow`.
The parent context cache remains keyed by Pi conversation. Child caches are signal-keyed; a fresh
child starts without a token value, and null after compaction retains a marked last-known value.
Never render `unavailable` or require `modelContextLimits`.

`usage.ts` tracks SDK cumulative cost/token snapshots per child and adds only their deltas.
Context occupancy is separate from cumulative billed tokens (which include input/output/cache).
In-process samples come from `getContextUsage()` / `getSessionStats()` at events and completion;
subprocess samples come from JSON message usage and recorded compaction/summary usage. Repeated
agent_end messages must not recount message_end usage. The separate `kanban-usage` status line
and dashboard show estimates from reported pricing, never a promised bill. Missing reports remain
explicit. Totals cover internal children for this title in the current Pi process, not main-chat
or title-generation cost. Nothing is injected into native Pi conversation entries to affect its footer.
Usage events refresh cached UI state. Abort/end cleans up observers and late
events cannot alter the next run. Up to sixteen titles' totals survive stage changes in memory.

An implement loop additionally shows a separate `kanban-progress` widget while selected and live.
It is not a fifth board row. `/kanban progress` and `/kanban experiments` open the same detailed
dashboard, with goal, iteration budget, activity, metrics/trend, decision comments and output.
↑/↓ browses saved attempts; PgUp/PgDn scrolls the retained output. The live tail is bounded to
8,000 characters per session and sixteen recent sessions per process, stripped of terminal control
sequences, never persisted, and contains public assistant text plus measurement output only.
No chain-of-thought or raw tool-result stream is collected. Signal-keyed observation leaves
the frozen runner seam unchanged. End/abort freezes the snapshot and removes widget subscriptions;
closing the expanded dashboard removes its subscriptions without aborting the experiment.

The implement task registers before background preparation and baseline measurement. TUI/RPC
commands return that handle immediately after preflight; print/json still await its run promise.
Background failures clean up the handle and report a terminal result. The JavaScript controller
awaits child/process events; it never runs a model turn or polling loop to monitor work.
`progressevents.ts` coalesces event types within a microtask, scoped by repository. Live/usage events
redraw cached data; record events reload the open dashboard's durable snapshot. Idle implement
observers have no intervals or scheduled callbacks. `r` explicitly refreshes cross-process results.
`kanban_status` and `/kanban status` query once using `store.readSnapshot`, which never acquires a
lock, creates a board or migrates state. Queries return bounded summaries/output/results/plans
without touching the run identity, stage or main conversation. Keep external schedulers external.

`/kanban` opens the shared interactive multi-session dashboard. It must be a non-overlay, bordered editor-area component; do not cover transcript content with an experimental floating overlay. Browse mode previews the highlighted session's status; Enter opens it in a fresh Pi conversation, and Tab enters management mode. Management mode supports Enter to open, `r` to rename, and `x` to permanently delete after confirmation. Rename and delete must reopen the refreshed dashboard; opening a session is the only dashboard action that exits into a new Pi conversation. The fresh-conversation seed states that the global handoff may describe previously selected work and that the selected plan is authoritative. `/kanban pause`, `/kanban unpause`, and `/kanban remove` act only on the current durable selection; remove is permanent and asks for confirmation.

## `init.sh` and release checks

`./init.sh` is read-only and reports session context, branch, recent commits, and working tree. `./init.sh --check` validates v4 state selection, the absence of saved Pi conversation paths, and active plans; checks the physical handoff line cap; runs `git diff --check`, `npm run typecheck`, and `npm test`; then prints an unexecuted suggested commit.

`loop.validate` and `loop.metric` are the only commands Kanban itself executes, plus the opt-in `.kanban/hooks/{before,after}-iteration` scripts when `loop.hooks` is set. All of them run only inside a disposable iteration worktree and are never derived from `init.*`.

Measurement may be arbitrarily slow, which shapes three behaviors worth keeping in mind when changing this area: `loop.measureTimeoutMs` bounds one command's entire wait (queue time included, for a scheduler-backed measurement); `loop.baselineMetric` replaces the baseline measurement with a value the operator already has; and `loop.audit` snapshots every attempt onto `kanban-audit/<base>` because a disposable worktree is not a place to leave evidence. Single-shot Pi modes await the run through `isSingleShot`, so `pi -p "/kanban implement"` does not exit out from under an armed loop.

Init commands come from config (`.kanban/config.json`, `"auto"` resolves to an executable `./init.sh`) and appear only in the implement kickoff, the completion text, and the handoff header when configured. Only the autoresearch worktree may run `git add`/`git commit`, and only for a validated, accepted candidate on its private branch. Final completion may stage experiment-owned paths, but no extension code commits the user's checkout.

Before submitting changes, run:

```sh
npm run typecheck
npm test
./init.sh --check
```

Manual Pi verification should cover generated and fallback titles; all six stages; material checkpoints; dashboard navigation, status preview, management mode, and borders; the live `/kanban experiments` table; context on more than one model and Pi conversation; dashboard open without an old-chat switch; rename/pause/unpause/remove confirmations; v1/v2/v3 migration; private experiment branch commits/reverts and resume; final plan retention with state cleanup; and experiment-path-only final staging.
