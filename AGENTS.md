# Kanban repository guide

## Purpose

Develop `kanban`, a local Pi extension for durable, low-noise Kanban sessions. The package entry point is `src/index.ts`; Pi loads it directly from `package.json`.

## Start here

1. Read `README.md` for supported user behavior and limitations.
2. Read `docs/development.md` before changing persistence, workflows, UI, `kanban_update`, or `init.sh`; then use the linked architecture/workflow/state reference for the subsystem being changed.
3. Inspect the relevant source module before editing it.
4. Run `./init.sh` before beginning a session; run `./init.sh --check` before handoff.

## Repository map

- `src/index.ts` – Pi commands (`/kanban`, create, `/kanban open`, `/kanban config`, `/kanban complete`), the `kanban_update` tool and critique gate, lifecycle hooks, resume, and title generation.
- `src/store.ts` – compact v4 state, migrations, lock, mutations, selection, agents, session modes, and stage progression.
- `src/artifacts.ts` – compact plan snapshots (including the bounded archive-time completion record) and the one bounded handoff.
- `src/orchestrator.ts` – the internal pipeline engine: child-session runs, research fan-out, grill Q&A, the title-keyed abort registry, and the model-resolving critique-gate seam.
- `src/runner.ts` – in-process and subprocess child-session backends (frozen `RunChild` seam).
- `src/prompts.ts` – per-stage prompts, output grammar, implement kickoff, and completion text (frozen).
- `src/config.ts` – merged global + repository config: per-stage models, research workers, fastPath, runner backend, and auto-detected init commands.
- `src/capabilities.ts` – detection of installed external subagent/background-task tools for the implement kickoff.
- `src/workfile.ts` – the `.kanban/work/<base>.md` section artifact.
- `src/ui.ts` – themed selected-session widget and keyboard title picker.
- `init.sh` – start report and completion checks.
- `test/store.test.ts` – state, migration, lock, plan, and handoff tests.
- `test/extension.integration.test.ts` – command, checkpoint, UI, resume, pipeline-mode, and critique-gate tests.

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
- Kanban runs its own internal child sessions for the pipeline stages: refine, research, grill, and compose are orchestrator-owned child sessions; implement and critique are agent-owned in the main conversation. External scheduling tools remain external: Kanban only names installed subagent/background-task tools in the implement kickoff and never launches them.
- Every session carries an optional `mode` (`"pipeline"` | `"manual"`; missing ⇒ `"manual"`) and a `pipelineToken` CAS identity for the live pipeline run or armed critique gate, minted per run and cleared on pause/remove/rename. One pipeline runs per process; a second is refused.
- `.kanban/work/<base>.md` is the workfile: the orchestrator or critique tool is its sole writer, always inside the locked commit; one `## <stage>` section per stage, each capped at 300 lines; resume authority is `state.json`'s stage only (sections are prompt inputs); it is deleted at final completion and `/kanban remove`; orphans are swept at startup.
- Init commands come from config (auto-detected executable `./init.sh`) and are never hardcoded; they appear only in the implement kickoff, the final completion text, and the handoff's operating-rules header (rendered only when configured) — never in stage prompts or tool guidance.
- Stage-transition instructions ride in `kanban_update` tool results; there is no `sendUserMessage(…, followUp)` kickoff injection.
- The pipeline never auto-switches conversations: after compose the pipeline notifies and ends; the user runs `/kanban open` (or presses Enter on the session in `/kanban`) to start implementation.
- The critique gate is enforced: one stage per `stage_complete(critique)`, a 2-attempt cap (a plain call at the cap must pass `rerunCritique` or `acceptRemainingIssues`; early accept before the cap is refused), durable `plan.gateFailure` on gate-child failure (which is the only thing that authorizes a pipeline-mode `critiqueSummary`), and `/kanban complete` as the escape hatch, valid only while `plan.pendingCompletion` exists. There is no `skipRemaining`.
- The blocked-state guard: every agent-owned mutation (checkpoint, `stage_complete` variants, gate-token mint, `/kanban complete`) requires `state === "active"` and the expected stage in its locked predicate.
- Resume a saved Pi conversation when available; otherwise seed a new one from the single handoff and selected plan.
- Never run `git add` or `git commit` automatically. After validation, output a suggested commit and let the user decide.

## Change guidelines

- Keep the TUI separate from persistence and plan/handoff artifact control; the widget may report running pipeline children from `session.agents`, never from the runner itself.
- Preserve rehydration on `session_start`, durable handoffs across Pi conversations, and legacy v1/v2 migration.
- Lifecycle refreshes must not write state on every tool execution.
- Document behavior and limitations accurately; do not promise orchestration the code does not perform.
- Update tests with behavior changes, especially migration, locking, stages, session modes, pipeline tokens, resume, selection, checkpoint payloads, gate records, workfile lifecycle, handoff bounds, and init checks.
- Keep `README.md` and `docs/development.md` consistent with implementation.

## Validation

Run before handing off:

```sh
npm run typecheck
npm test
./init.sh --check
```

For manual Pi verification, install from the local package path with `pi install /absolute/path/to/kanban`, then restart Pi or use `/reload`.
