# Kanban repository guide

## Purpose

Develop `kanban`, a local Pi extension for durable, low-noise Kanban sessions. The package entry point is `src/index.ts`; Pi loads it directly from `package.json`.

## Start here

1. Read `README.md` for supported user behavior and limitations.
2. Read `docs/development.md` before changing persistence, workflows, UI, `kanban_update`, or `init.sh`; then use the linked architecture/workflow/state reference for the subsystem being changed.
3. Inspect the relevant source module before editing it.
4. Run `./init.sh` before beginning a session; run `./init.sh --check` before handoff.

## Repository map

- `src/index.ts` – Pi commands (`/kanban`, create, `/kanban open`, `/kanban implement`, `/kanban config`, `/kanban complete`), the `kanban_update` tool and critique gate, lifecycle hooks, resume, and title generation.
- `src/store.ts` – compact v4 state, migrations, lock, mutations, selection, agents, session modes, and stage progression.
- `src/artifacts.ts` – compact plan snapshots (including the bounded archive-time completion record) and the one bounded handoff.
- `src/orchestrator.ts` – the internal pipeline engine: child-session runs, research fan-out, grill Q&A, the title-keyed abort registry, the model-resolving critique-gate seam, and the implement-loop run handle (run identity, locked commits, child plumbing).
- `src/implementloop.ts` – the orchestrator-owned implement experiment loop: per-iteration worktrees, fitness decision, lessons, termination, and detect-and-defer landing.
- `src/worktree.ts` – plain-git worktree and patch primitives. Normal landing uses `git apply` without `--index`; the autoresearch loop may stage/commit accepted candidates only inside private experiment worktrees.
- `src/measure.ts` – runs the opt-in `loop.validate`/`loop.metric` commands in their own process group, merges the iteration identity into their inherited environment, and parses `METRIC <name>=<value>`.
- `src/looplog.ts` – `.kanban/loop/<base>.*` breadcrumbs, the living lesson summary, and the owner-PID worktree manifest.
- `src/runner.ts` – in-process and subprocess child-session backends (frozen `RunChild` seam).
- `src/prompts.ts` – per-stage prompts, output grammar, implement kickoff, and completion text (frozen).
- `src/config.ts` – merged global + repository config: per-stage models (including `implement`), research workers, fastPath, runner backend, auto-detected init commands, and the opt-in `loop` block.
- `src/capabilities.ts` – detection of installed external subagent/background-task tools for the implement kickoff, and the `isSingleShot` run-mode predicate.
- `src/workfile.ts` – the `.kanban/work/<base>.md` section artifact.
- `src/ui.ts` – themed selected-session widget and keyboard title picker.
- `init.sh` – start report and completion checks.
- `test/store.test.ts` – state, migration, lock, plan, and handoff tests.
- `test/extension.integration.test.ts` – command, checkpoint, UI, resume, pipeline-mode, critique-gate, and `/kanban implement` tests.
- `test/implementloop.test.ts` – the implement loop end to end against real git worktrees.

## Core invariants

- `.kanban/state.json` is canonical repository-local control state; `.kanban/` stays untracked.
- Use the repository lock and mutation helpers for state changes. Do not hand-edit durable state in normal flows.
- State holds only unfinished sessions, selection, stage, mode, pipeline token, and agent name/role/status; completed sessions never remain in it.
- Plans use date-plus-safe-title filenames and contain progressive work detail without UUIDs, task/todo IDs, evidence, reviews, or source-file lists. The one sanctioned exception is the bounded archive-time `completion` record on a finished plan (`pass` | `accepted-issues` | `manual` | `skipped`, with an optional note capped at 10 lines); plans never accumulate progressive review/evidence archives.
- `handoff.md` is the only handoff, stays within 200 physical lines, supplements rather than repeats state, and resets to the latest completed plan on final completion.
- Render only the selected session and only its title, current stage, context remaining bar, and number of agents working.
- Obtain context capacity from Pi's model/context APIs; never require a user-maintained model limit or render `unavailable`.
- Stage order is `refine → research → grill → compose → implement → critique`. Only an explicit `kanban_update` `stage_complete` (implement/critique) or an orchestrator locked commit (pipeline child stages, one stage per commit) advances a stage; never advance implicitly.
- `kanban_update` is a low-frequency selected-session checkpoint: do not restore task/todo-level actions or identifier parameters.
- Kanban runs its own internal child sessions for the pipeline stages: refine, research, grill, and compose are orchestrator-owned child sessions; critique is agent-owned in the main conversation. Implement ownership is SPLIT by config: with `config.loop.enabled` it is ORCHESTRATOR-owned (the implement loop, whose locked commit advances implement→critique after landing), and with the default `loop.enabled: false` it is AGENT-owned in the main conversation exactly as before. External scheduling tools remain external: Kanban only names installed subagent/background-task tools in the implement kickoff and never launches them.
- The implement loop is Kanban's durable autoresearch/goal engine. Each accepted candidate is committed only inside a private `kanban-autoresearch/<base>` branch; a rejected candidate is discarded with its record and lesson retained. Iterations run in detached worktrees under gitignored `.kanban/worktrees/`; the final accepted branch diff lands in the user checkout with `git apply --binary` WITHOUT `--index`, then final completion stages only experiment-owned paths and suggests a commit message. The extension never auto-commits the user checkout. Iteration children get `read/grep/find/ls/edit/write` and deliberately NO `bash`, so a child cannot run git or leave its worktree by `cd`; the worktree is cooperative experiment isolation, not a filesystem sandbox.
- `loop.validate` and `loop.metric` are the only commands Kanban executes from its own config, plus the `.kanban/hooks/{before,after}-iteration` scripts when `loop.hooks` is enabled. All of them are explicit and opt-in, run only inside an iteration worktree, and are NEVER aliased from `config.init.*`. Loop progress is reported through `ctx.ui.setStatus`, never as a fifth widget row.
- Measurement is allowed to be expensive and slow: `loop.measureTimeoutMs` bounds one command's whole wait, `loop.baselineMetric` replaces the baseline measurement with recorded evidence, and both commands inherit Pi's environment plus `KANBAN_ITERATION`/`KANBAN_MAX_ITERATIONS`/`KANBAN_BASE`/`KANBAN_BEST_METRIC`. `loop.validate` failing does NOT skip `loop.metric`; do not add a short circuit that reorders them.
- `loop.audit` writes one commit per attempt — kept AND discarded — to `kanban-audit/<base>` via `git commit-tree`, so it never moves HEAD, never moves the experiment branch, and restores the worktree index afterwards. `loop.auditPaths` are force-added, which is the only way gitignored measurement evidence enters Git; it must stay out of the accepted commit and the landed patch. A failed audit write is reported and ignored: the evidence trail must never fail an experiment.
- Single-shot Pi modes (`print`, `json`) dispose the runtime when a command returns, so `/kanban implement` and `startPipeline` await their run there (`isSingleShot`) and stay non-blocking in `tui`/`rpc`. Do not key this on `hasUI`.
- `stage_complete(implement)` is refused only while a LIVE in-memory run exists for the title; a stale durable `pipelineToken` (left by the compose pipeline or a crash) must never block a manual implement advance.
- Every session carries an optional `mode` (`"pipeline"` | `"manual"`; missing ⇒ `"manual"`) and a `pipelineToken` CAS identity for the live pipeline run or armed critique gate, minted per run and cleared on pause/remove/rename. The implement loop reuses the same two fields — it adds NO Session field, and every breadcrumb it keeps lives in `.kanban/`. One pipeline or implement loop runs per process; a second is refused.
- `.kanban/work/<base>.md` is the workfile: the orchestrator or critique tool is its sole writer, always inside the locked commit; one `## <stage>` section per stage, each capped at 300 lines; resume authority is `state.json`'s stage only (sections are prompt inputs); it is deleted at final completion and `/kanban remove`; orphans are swept at startup.
- Init commands come from config (auto-detected executable `./init.sh`) and are never hardcoded; they appear only in the implement kickoff, the final completion text, and the handoff's operating-rules header (rendered only when configured) — never in stage prompts or tool guidance.
- Stage-transition instructions ride in `kanban_update` tool results; there is no `sendUserMessage(…, followUp)` kickoff injection.
- The pipeline never auto-switches conversations: after compose the pipeline notifies and ends; the user runs `/kanban open` (or presses Enter on the session in `/kanban`) to start implementation.
- The critique gate is enforced: one stage per `stage_complete(critique)`, a 2-attempt cap (a plain call at the cap must pass `rerunCritique` or `acceptRemainingIssues`; early accept before the cap is refused), durable `plan.gateFailure` on gate-child failure (which is the only thing that authorizes a pipeline-mode `critiqueSummary`), and `/kanban complete` as the escape hatch, valid only while `plan.pendingCompletion` exists. There is no `skipRemaining`.
- The blocked-state guard: every agent-owned mutation (checkpoint, `stage_complete` variants, gate-token mint, `/kanban complete`) requires `state === "active"` and the expected stage in its locked predicate.
- Resume a saved Pi conversation when available; otherwise seed a new one from the single handoff and selected plan.

## Change guidelines

- Keep the TUI separate from persistence and plan/handoff artifact control; the widget may report running pipeline children from `session.agents`, never from the runner itself.
- Preserve rehydration on `session_start`, durable handoffs across Pi conversations, and legacy v1/v2 migration.
- Lifecycle refreshes must not write state on every tool execution.
- Document behavior and limitations accurately; do not promise orchestration the code does not perform.
- Update tests with behavior changes, especially migration, locking, stages, session modes, pipeline tokens, resume, selection, checkpoint payloads, gate records, workfile lifecycle, handoff bounds, init checks, and the implement loop's fitness/landing/recovery behavior.
- The implement loop's design record is `docs/plans/loop-driver-v2.md`; read it before changing fitness, patch capture, landing, or worktree lifecycle.
- Keep `README.md` and `docs/development.md` consistent with implementation.

## Validation

Run before handing off:

```sh
npm run typecheck
npm test
./init.sh --check
```

For manual Pi verification, install from the local package path with `pi install /absolute/path/to/kanban`, then restart Pi or use `/reload`.
