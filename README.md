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

The prompt is the session brief. Kanban asks the current authenticated Pi model for a short title, then falls back to a safe local prompt summary if title generation is unavailable. It creates and selects a pipeline-mode session, runs the pipeline, and notifies when the spec is composed.

The staged workflow is fixed:

```text
refine → research → grill → compose → implement → critique
```

Refine, research, grill, and compose run in Kanban's own internal child sessions, one output section per stage (`.kanban/work/<base>.md`). The pipeline never switches your conversation: after compose it stops and tells you to run `/kanban open` (or press Enter on the session in `/kanban`) to start implementation in a fresh Pi conversation. If child sessions fail (no runner, model/auth problem), the session durably falls back to manual mode: you run every stage yourself in the main conversation.

Grill asks up to three high-impact questions, with 2–4 concrete alternatives per question.
Each option includes a short explanation of its trade-off, the recommendation is first, and
**Answer differently…** is last. **Skip (record assumption)** or Escape records the recommendation
as an assumption; headless runs do the same. Legacy children that emit only a recommendation
still work. A stage with `Questions: none` proceeds without a question dialog.

The pipeline status line refreshes every second with the current/next stage, elapsed time,
running and finished child counts, failures, and each active child's latest activity and its age.
An ETA range uses up to five successful runs of the same stage/model/settings in the current Pi
process; without history it says `ETA unknown`. Human answer time is excluded from timing
samples. Long-running stages report that the estimate is uncertain. A child wait is limited to
five minutes by default (`pipeline.childTimeoutMs`); timeout requests cancellation and follows
the normal child-failure path, keeping the current stage and falling back to manual mode.
Partial research failure retains the successful workers' findings and reports missing coverage.

If the repository has an executable `./init.sh`, the implement kickoff, final completion text, and handoff rules carry the auto-detected init commands (`init: { start: "auto", check: "auto" }` in config; set `null` to disable). Stage prompts and tool guidance never mention init commands.

## Commands

| Command | Behavior |
| --- | --- |
| `/kanban` | Opens the keyboard-driven Kanban dashboard. ↑/↓ or `j`/`k` previews a session's status; Enter selects a session and routes to `/kanban open`; Tab opens management mode, where Enter opens, `r` renames, and `x` permanently deletes after confirmation. Rename/delete return to the refreshed dashboard; only opening a session leaves it. |
| `/kanban create <prompt>` | Generates a title, creates/selects the durable pipeline-mode session, and starts the pipeline. |
| `/kanban open [title]` | Opens the selected plan in a clean Pi conversation. A live implement coordinator keeps running; the new chat is its control surface. Pipeline-owned planning stages re-run their current child. Blocked sessions must be unpaused. |
| `/kanban implement` | At implement, starts/resumes the persistent iteration coordinator when `loop.enabled`; otherwise opens the normal agent-owned conversation. `stop` explicitly cancels managed jobs before stopping; unconfirmed cancellation retains the owner and recovery data. |
| `/kanban steer <message>` / `/kanban goal <message>` | Sends direction to the coordinator, or queues a goal revision that blocks new dispatch and final acceptance until applied. |
| `/kanban status [summary\|output\|results\|plan]` | Reads one snapshot without opening a dashboard, joining the background task, or changing state. Defaults to summary. |
| `/kanban progress` / `/kanban experiments` | Opens the selected session's implement dashboard: goal, current activity, public child/measurement output, baseline/latest/best/target metric, recent metric trend, keep/revert history, validation, commits, and comments. ↑/↓ browses attempts; PgUp/PgDn scrolls the retained output; Escape closes the panel without stopping the loop. Agent-owned implementation shows saved checkpoints and its roster. |
| `/kanban plan` | Opens a read-only, scrollable preview of the composed Markdown implementation plan without switching conversations. ↑/↓ scrolls; PgUp/PgDn pages; Escape closes. |
| `/kanban config` | Opens `.kanban/config.json`. Valid loop changes queue a revision for the current campaign; disabling the loop affects future starts and does not silently cancel jobs. |
| `/kanban pause` / `/kanban unpause` | Marks the currently selected session `blocked` or `active` without changing its stage. Pausing also aborts a live pipeline run and clears its token; unpausing restarts nothing. |
| `/kanban remove` | Permanently deletes the currently selected session, its plan, and its workfile after confirmation (a live run is aborted first). |
| `/kanban complete` | Escape hatch for the critique step: valid only while the plan carries a `pendingCompletion` record (a tool confirm path directed the session there). Confirms with the user, then archives like a normal critique completion. |

The dashboard is rendered as a bordered editor-area panel, not a floating transcript overlay. Escape closes it. It never exposes internal identifiers because active sessions are selected by title.

## Configuration

`.kanban/config.json` (created by `/kanban config`) overrides the global `~/.pi/agent/extensions/kanban.json`; defaults apply before both. Unknown keys warn and are ignored.

```jsonc
{
  "models": { "refine": null, "research": null, "grill": null, "compose": null,
              "critique": null },          // "provider:model-id" or null → parent model
  "research": { "workers": 2, "depth": "focused" }, // workers: 1–3; depth: focused | deep
  "compose": { "detail": "plan" },         // plan | concise | detailed
  "pipeline": { "childTimeoutMs": 300000 }, // per refine/research/grill/compose child, 1s–1h
  "fastPath": true,                        // refine "simple" verdict skips research + grill
  "critique": true,                        // false ⇒ critique completes without a gate
  "runner": "auto",                       // auto | inprocess | subprocess
  "piBin": "pi",                          // subprocess backend binary (PATH lookup)
  "init": { "start": "auto", "check": "auto" },  // auto: ./init.sh iff executable; string; null
  "loop": {                                // the implement loop; opt-in, off by default
    "enabled": false,
    "validate": "npm test",                // exit 0 ⇒ the iteration validated (fitness)
    "direction": "higher",                 // higher | lower is better
    "decisionPolicy": "agent-with-validation", // strict-metric | agent-with-validation
    "maxIterations": 50,
    "noImprovementStreak": 8,              // stop after this many consecutive reverts
    "measureTimeoutMs": 300000,            // per command; covers the whole wait, so size it
                                           // for the slowest measurement, not the fast path
    "hooks": false,                        // run .kanban/hooks/{before,after}-iteration
    "audit": false,                        // one kanban-audit/<base> commit per attempt
    "autoResume": false                    // resume a paused experiment on /kanban open
    // optional, omit rather than null (the loop block rejects null):
    //   "metric": "…prints METRIC <name>=<value>", "metric_name": "score", "target": 100,
    //   "baselineMetric": 0,               // trust this instead of measuring the baseline
    //   "auditPaths": ["evidence"]         // force-added into each audit commit
  }
}
```

`models.implement` is used by the coordinator, workers, and reviewers. Kanban executes only configured `loop.validate`, `loop.metric`, named `loop.jobs` adapter commands, and opt-in iteration hooks. Commands run inside private worktrees and are never derived from `init.*`. Managed sessions use Pi's in-process SDK regardless of the planning `runner` setting; the frozen planning/critique runners are unchanged. See [managed jobs](docs/managed-jobs.md) for configuration and the adapter protocol.

Both commands inherit the environment of the shell that started Pi — that is how a site profile, module paths or credentials reach them — and Kanban adds `KANBAN_ITERATION`, `KANBAN_MAX_ITERATIONS`, `KANBAN_BASE` and, once known, `KANBAN_BEST_METRIC`. Note that `loop.metric` runs even when `loop.validate` failed: a check whose only job is to stop an expensive measurement has to live inside the measuring command.

Each stage (and research worker) uses its configured model when set; otherwise the parent session model. Installed external subagent/background-task tools are detected and named in the implement kickoff — they are never invoked by Kanban.

Research always covers repository conventions, affected code facts, and validation. With one
worker it combines all three; with two, one covers conventions/code and the other validation;
with three, each has one angle. `focused` aims for six targeted tool calls and 35 output lines
per angle; `deep` also traces relevant dependencies and edge cases, within 70 lines per angle.
These are prompt budgets, not enforced tool-call quotas. Grill reuses those findings and aims
for at most three targeted reads. Compose defaults to a reviewable Markdown implementation plan
with summary, goals/non-goals, proposed approach, ordered implementation steps, validation and
acceptance, and risks/assumptions. It uses the user's language, preserves settled decisions, and
connects each step to relevant paths, dependencies and verification. The **entire compose section,
including its heading, must fit within 300 physical lines**. Substantial requests usually need
120–240 lines; small requests should stay shorter. `concise` retains a 100-line prompt budget and
`detailed` a 220-line budget, with the same plan structure. An oversized compose result stays at
compose and falls back to manual mode; it is never published as a truncated implementation plan.
Use `/kanban plan` to review it before `/kanban open`. Explicit existing settings are preserved;
new defaults do not override repository/global choices.

## The implement loop (opt-in)

With `loop.enabled`, `/kanban implement` hands the implement stage to the orchestrator as an
iterative experiment loop instead of running it in your conversation:

In interactive and RPC modes it returns after preflight and task registration. Baseline measurement
also runs in the background. Each iteration owns one persistent coordinator session and multiple
independent worker/reviewer sessions and jobs. Child results, failures, questions, job transitions,
and user control requests are recorded before waking that same coordinator. It repairs affected
work while useful siblings continue. Quiet scheduler status changes do not consume model turns;
the host alone polls configured status adapters. Main-chat queries do not monitor or join the task.
`loop.enabled: false` retains normal agent-owned implementation.

1. **Preflight.** It refuses without a fitness signal (`loop.validate`, `loop.metric`, or named jobs), with
   modified tracked files in your working tree (commit or stash first; untracked files are left
   alone), or while another Kanban run is live. It records `baseCommit = HEAD` and measures a
   baseline in a throwaway worktree — unless `loop.baselineMetric` supplies it, which is the
   right choice when one measurement costs hours or a scheduler allocation and its current
   value is already recorded evidence.
2. **Work lanes.** Workers get isolated, detached snapshots with `read/grep/find/ls/edit/write`
   and no shell. Reviewers and the coordinator are read-only outside private control tools.
   A worker's final answer is a candidate; a separate reviewer must pass that exact candidate
   before integration. Failed lanes can be retried from partial source in the same iteration.
3. **Validation and acceptance.** Commands run on separate source snapshots, so build debris
   cannot enter accepted commits. Named jobs provide independent completion and acceptance
   receipts; legacy validate/metric remains one opaque measurement. The coordinator explicitly
   finishes an iteration only after reconciling its lanes, jobs, goal revision, and final-source
   validation. The host still enforces validation, metric availability, decision policy and target.
   Repairs consume campaign child/submission budgets, not a new iteration or a fixed retry count.
   Accepted source changes are committed only to `kanban-autoresearch/<base>`; validated
   evidence-only work can finish without an empty commit.
4. **Termination.** An explicitly complete, accepted iteration that meets `loop.target`, if set,
   is a SUCCESS: the patch lands and the session advances to critique. Out
   of iterations or out of improvements is EXHAUSTED: the partial best lands but the stage stays at
   implement, and you continue with `/kanban open`. Nothing kept at all is a FAILURE: nothing
   lands, and the lessons stay in `.kanban/loop/<base>.md`.

### Keeping evidence a discarded iteration produced

Coordinator-owned worker/job snapshots and internal Pi sessions are retained under `.kanban/`
for recovery and evidence inspection, including discarded work. They are not swept just because
Pi exited. They can occupy substantial disk space; `/kanban remove` is the explicit destructive
cleanup path for an unfinished session, after scheduler ownership is resolved. Completed-session
evidence remains for deliberate operator cleanup. External artifact storage has its own lifetime.

`loop.audit` writes one commit per attempt — kept **and** discarded — to the separate
`kanban-audit/<base>` ref, holding that attempt's tree. `loop.auditPaths` pathspecs are
force-added, so evidence under a gitignored path reaches the audit ref while staying out of the
accepted commit and out of the landed patch. Each `.kanban/loop/<base>.jsonl` record carries its
`auditCommit`, so a long-swept iteration is still `git show`-able. The audit ref is never the
accepted-experiment branch, it is never checked out, and Kanban never deletes it — `git
branch -D kanban-audit/<base>` is yours to run when the trail has served its purpose.

### Landing

The loop uses a **private committed experiment branch** and a saved patch. Only accepted
candidates are published to `kanban-autoresearch/<base>`. Detached source snapshots use private
Git commits too, but never advance that branch. Its final accepted diff lands with
`git apply` into your working tree, still uncommitted. At final completion Kanban stages only the
accepted experiment paths and suggests the commit message; it never commits the user checkout.
Kanban cannot lock your git working tree, so landing re-checks HEAD, cleanliness and the session
token immediately before applying; a patch that no longer applies leaves your tree untouched.

While a loop runs, a separate implement progress widget appears above the editor, alongside the
unchanged four-row board widget. It displays the goal, iteration budget, actual running child
count, elapsed time, baseline/latest/best/target, current activity, the latest decision comment,
and the last output line. It hides when a different session is selected and clears after the
run ends. Iterations are an attempt budget, not a claim about percentage of the goal completed.

`/kanban progress` (also `/kanban experiments`) opens the larger event-driven dashboard.
Public assistant text streams during the child run; validation and metric stdout/stderr stream
during measurement. Counts distinguish active children from outstanding jobs. The output tail is capped
at 8,000 characters in memory, with terminal control sequences stripped; it is neither a full
transcript nor a reasoning trace. Another Pi process, or a restarted one, sees the durable
iteration records and saved validation tails but has no live telemetry for the previous process.
With `loop.enabled: false`, implementation runs in the main Pi conversation: the dashboard
shows checkpoint summaries/agents, and third-party child output remains in its own scheduler.

The implement widget and usage display subscribe to task events. The dashboard redraws live data
when output/usage changes and reloads saved records at iteration boundaries; it does no periodic
file polling. Quiet periods schedule no observer work, so elapsed/last-activity labels update on
the next event, interaction or query. Press `r` to reload saved records manually, including changes
made by another Pi process. Closing the dashboard removes its subscriptions and leaves the task running.

You can ask the main agent "what is it doing?" or "why was iteration 3 discarded?". The read-only
`kanban_status` tool supplies a bounded `summary`, `output`, `results`, or `plan` snapshot, with an
optional completed iteration number. It neither waits for completion nor advances, resumes, or
restarts work. The tool instructs the agent to query on demand and answer, without a monitoring
loop. `/kanban status`, `/kanban status output`, and `/kanban status results` offer the same views
directly. Live output remains a bounded process-local tail; saved results are not full transcripts.

Use `kanban_control` in the main chat for `steer`, `retry`, `reply`, or `revise`, including an
explicit loop-settings/scope patch. A goal revision updates the selected plan and composed spec
under the repository lock; old evidence needs explicit revalidation. Pending revisions prevent
new dispatch and stale final acceptance. Useful running jobs keep their original source/config.
No third-party worker should be launched to compete with a live coordinator.

`/kanban open` and Pi new/resume/fork keep live implementation running. Pause or Pi quit/reload
suspends local sessions and command observers, preserves managed scheduler jobs, and lands nothing.
Resume with `/kanban implement` (or `autoResume` plus `/kanban open`); it reconciles saved job keys
before dispatch. Explicit `stop`/`remove` requests cancellation. Unknown cancellation or missing
scheduler history blocks replacement and deletion; it is not treated as proof that a job vanished.
Local CPU commands are interrupted on shutdown and need a fresh attempt. This is not a daemon:
while Pi is down, jobs may run, but no model coordinates their completion.

`pipeline.childTimeoutMs` applies only to planning children. It does not shorten implement
iterations or the explicitly configured `loop.measureTimeoutMs` for expensive measurements.

## Unattended runs

Pi's single-shot modes (`--print`, `--mode json`) execute extension commands, so the loop has a
headless entry point:

```sh
cd /path/to/repo
nohup pi -p "/kanban implement" > loop.log 2>&1 &
```

In those modes `/kanban implement` and `/kanban create` **block until the run finishes**, because
print mode disposes the runtime as soon as the command returns and would otherwise kill a loop it
had only armed. In `tui` and `rpc` mode both commands stay non-blocking, exactly as before.

`/kanban implement` is valid only at the implement stage, so an unattended campaign is two steps:
run the pipeline first (interactively, or `pi -p "/kanban create <brief>"`), then start the loop.
`.kanban/loop/<base>.run.json`, `.coordinator.json`, and `.sessions/` hold recovery state.
`loop.autoResume` picks it up on the next `/kanban open`. A hard kill can interrupt an adapter
operation; safe recovery depends on its stable-key reconciliation contract. Missing/corrupt
worktrees or mismatched Git refs require operator repair and are never silently recreated over jobs.

## Low-noise checkpoints

`kanban_update` works only on the selected session. There are no session, task, or todo IDs and no task-level actions.

| Action | Use |
| --- | --- |
| `checkpoint` | Record one material update to scope, agent roster, compact work summary, or handoff. |
| `stage_complete` | Record an optional checkpoint and explicitly move to the next stage, or complete the final stage. In critique it accepts the gate parameters `rerunCritique`, `acceptRemainingIssues`, and `critiqueSummary`. |

A checkpoint may supply `inScope`, `outOfScope`, a complete `agents` roster (`name`, `role`, `status`), `work` (`done`, `current`, `next`), and a replacement `handoff` supplement. Use it at stage boundaries or when the plan materially changes—not after each tool call or todo.

Stage transitions ride in the tool result text; no followUp kickoff message is injected. Pipeline-owned stages reject `stage_complete` until implementation opens in your conversation. The critique gate (PASS/FAIL bullets, enforced attempts cap, `acceptRemainingIssues` with human confirm when a UI is present, `/kanban complete` escape hatch) is described in [docs/agent-workflow.md](docs/agent-workflow.md).

## Selected-session widget

The task-style widget above Pi's editor intentionally shows only four things:

```text
☐ Refresh durable persistence
  ◉ Stage 5/6 · implement
  Current Pi context  [██████████░░] 211k / 272k · 77% remaining
  ● Agents working 2
```

Context follows the executor. During a live internal stage (including the implement loop and
critique gate), this row names the stage and shows that child's remaining context. Parallel
research workers have independent windows: the compact row shows the lowest remaining percentage
among workers with usage data, marking any workers still awaiting usage. `/kanban progress`
lists each child's model, capacity, remaining tokens and reported cost. After the internal run
ends, or during agent-owned work, the row returns to **Current Pi context** for the main conversation.

Capacity comes from each child's resolved Pi model; in-process context comes from Pi's context
API, while subprocess context uses the latest assistant usage report including cache tokens.
These are estimates, not a per-token meter. The widget refreshes when usage changes;
provider token/cost reports usually arrive at response boundaries. A new child says
`awaiting usage` until data arrives. After child compaction it marks retained usage as last known
until the next sample. There are no user-maintained model limits and no `unavailable` label.

Pi's native cost footer still accounts for its main conversation only. Kanban adds a separate
**Child cost estimate** status line showing current-stage cost and the tracked child total for
the selected title in this Pi process. Repeated SDK snapshots do not double-count requests;
cached tokens count toward cumulative usage, not a combined context window. These figures come
from Pi/provider usage and pricing, not an invoice or subscription balance. Missing reports are
marked explicitly; zero reported cost can reflect provider pricing configuration. Totals exclude
main-conversation work, title generation and third-party children, survive stage/iteration changes,
and reset on Pi reload/restart (up to sixteen recently tracked titles are retained in memory).

## Durable files

`.kanban/` stays untracked and contains:

- `state.json` — schema v4 canonical core state: selected unfinished session, stage, `mode`, agent names/roles/statuses, and timestamps. It never stores Pi conversation paths.
- `plans/YYYY-MM-DD-safe-title.json` — compact, reviewable session detail: prompt, scope boundaries, agents, work summary, status, and timestamps. Completed session plans remain here; the only review data a plan carries is the bounded archive-time `completion` record.
- `work/<base>.md` — the workfile: one `## <stage>` section per pipeline stage (each capped at 300 lines), written only by the orchestrator/critique tool inside the locked commit; resume authority is `state.json`'s stage only. Deleted at completion and `/kanban remove`; orphans are swept at startup.
- `loop/<base>.{run.json,jsonl,md,patch,landed}` — durable autoresearch record: the branch/base/best-commit recovery point (plus the audit ref and its tip when `loop.audit` is on), append-only per-iteration metric/decision/audit-commit history, bounded living summary injected into each new agent, best patch, and landed marker. It survives completion, abort, exhaustion, and restart; `/kanban remove` deletes it. The Git refs it names — `kanban-autoresearch/<base>` and `kanban-audit/<base>` — are not deleted with it.
- `worktrees/<base>/` — disposable iteration worktrees plus a `manifest.json` recording each worktree's owner PID. Startup removes only the worktrees whose owner process is gone, so a second Pi process never sweeps a live loop's worktrees.
- `hooks/{before,after}-iteration` — optional, executable, off unless `loop.hooks`; JSON on stdin, ≤8KB of stdout injected into the next prompt, 30s timeout, exit 10 stops the loop.
- `config.json` — repository config override (see above).
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

- Pipeline child sessions are Kanban-internal; third-party subagent/background-task tools are only detected and named in the implement kickoff, never launched.
- Child sessions (both runner backends) build models/auth from `~/.pi/agent` files; providers registered dynamically via `pi.registerProvider` may not work in children (L1). A child model failure falls back per-stage: refine/grill/compose failure (or no runner, or ALL research workers failing) durably flips the session to manual mode with a notify; a critique-gate child failure records `plan.gateFailure` and offers the manual summary path. Partial research-worker failures are noted and the pipeline continues with the workers that succeeded.
- Pausing from another process takes effect at stage boundaries, not mid-child: the orchestrator reloads state between stages.
- One live pipeline OR implement loop per process; starting a second is refused until the first is stopped or finishes.
- The implement loop's worktree is *experiment* isolation, not a filesystem sandbox: Kanban cannot sandbox an in-process child, so a child could in principle write an absolute path outside its worktree — the same latitude the agent-owned implement stage already has. Dropping the shell tool removes the git/`cd` escape; the rest is the trust boundary Kanban already assumes for its own agents.
- Session selection is repository-wide; do not use multiple active Pi conversations against the same board concurrently.
- The cooperative lock has no stale-lock owner-liveness recovery.
- Kanban cannot prevent Pi itself from opening or continuing a native Pi conversation; it simply does not bind that conversation to a Kanban session. The context widget reports the conversation Pi currently has open.
- The model-generated title is a short independent completion. It can incur the current model's normal request cost and falls back locally on failure.
