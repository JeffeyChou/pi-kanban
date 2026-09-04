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

If the repository has an executable `./init.sh`, the implement kickoff, final completion text, and handoff rules carry the auto-detected init commands (`init: { start: "auto", check: "auto" }` in config; set `null` to disable). Stage prompts and tool guidance never mention init commands.

## Commands

| Command | Behavior |
| --- | --- |
| `/kanban` | Opens the keyboard-driven Kanban dashboard. ↑/↓ or `j`/`k` previews a session's status; Enter selects a session and routes to `/kanban open`; Tab opens management mode, where Enter opens, `r` renames, and `x` permanently deletes after confirmation. Rename/delete return to the refreshed dashboard; only opening a session leaves it. |
| `/kanban create <prompt>` | Generates a title, creates/selects the durable pipeline-mode session, and starts the pipeline. |
| `/kanban open [title]` | No title means the selected session. At implement/critique it opens a clean Pi conversation seeded with plan, handoff, and workfile spec; on a pipeline-owned stage it re-runs that stage's child (blocked sessions are refused with a notify). Also aborts any live pipeline run for that title before minting a fresh token. |
| `/kanban implement` | Valid only at the implement stage. With `loop.enabled` it starts the orchestrator-owned implement loop (below); with the default `loop.enabled: false` it opens the agent-owned implement conversation exactly like `/kanban open`. `/kanban implement stop` aborts a live loop without landing anything. |
| `/kanban experiments` | Opens the selected session's live autoresearch table: branch, baseline/best metric, keep/revert history, validation state, commits, and rationales. |
| `/kanban config` | Opens `.kanban/config.json` in the editor (created if missing). |
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
  "research": { "workers": 3 },           // 1–3 parallel research workers
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

`models.implement` is used by the implement loop's iteration children. `loop.validate` and `loop.metric` are the only commands Kanban executes on your behalf — plus `.kanban/hooks/{before,after}-iteration` when you set `loop.hooks`. All of them are opt-in, they run only inside a disposable iteration worktree, and they are never aliased from `init.*`: Kanban never runs an init command itself.

Both commands inherit the environment of the shell that started Pi — that is how a site profile, module paths or credentials reach them — and Kanban adds `KANBAN_ITERATION`, `KANBAN_MAX_ITERATIONS`, `KANBAN_BASE` and, once known, `KANBAN_BEST_METRIC`. Note that `loop.metric` runs even when `loop.validate` failed: a check whose only job is to stop an expensive measurement has to live inside the measuring command.

Each stage (and research worker) uses its configured model when set; otherwise the parent session model. Installed external subagent/background-task tools are detected and named in the implement kickoff — they are never invoked by Kanban.

## The implement loop (opt-in)

With `loop.enabled`, `/kanban implement` hands the implement stage to the orchestrator as an
iterative experiment loop instead of running it in your conversation:

1. **Preflight.** It refuses without a fitness signal (`loop.validate` or `loop.metric`), with
   modified tracked files in your working tree (commit or stash first; untracked files are left
   alone), or while another Kanban run is live. It records `baseCommit = HEAD` and measures a
   baseline in a throwaway worktree — unless `loop.baselineMetric` supplies it, which is the
   right choice when one measurement costs hours or a scheduler allocation and its current
   value is already recorded evidence.
2. **Each iteration** runs in its own detached `git worktree` under `.kanban/worktrees/<base>/`,
   seeded with the best result so far. An implement child session works there with
   `read/grep/find/ls/edit/write` — deliberately **no shell**, so it cannot run commands or git.
3. **Every iteration is a durable experiment.** The candidate patch is captured *before*
   measuring (so build debris never enters it), then `loop.validate` and `loop.metric` run in the
   worktree in their own process group, killed as a group on timeout or abort. The child emits
   `Decision: keep|revert`; Kanban always rejects failed validation or an unmeasured configured
   metric, then either enforces strict improvement (`strict-metric`) or honors the agent's decision
   (`agent-with-validation`). Keeps are committed to `kanban-autoresearch/<base>`; reverts retain
   only their metric, rationale, and lesson in the durable log.
4. **Termination.** A kept iteration whose child ends with `Status: complete` (and, with a metric,
   reaches `loop.target`) is a SUCCESS: the patch lands and the session advances to critique. Out
   of iterations or out of improvements is EXHAUSTED: the partial best lands but the stage stays at
   implement, and you continue with `/kanban open`. Nothing kept at all is a FAILURE: nothing
   lands, and the lessons stay in `.kanban/loop/<base>.md`.

### Keeping evidence a discarded iteration produced

Iteration worktrees are disposable, so anything a measurement writes into one is gone when the
iteration ends — and for a measurement you cannot cheaply repeat (a scheduler job log, a
captured run directory), the discarded attempts are usually the ones worth keeping.

`loop.audit` writes one commit per attempt — kept **and** discarded — to the separate
`kanban-audit/<base>` ref, holding that attempt's tree. `loop.auditPaths` pathspecs are
force-added, so evidence under a gitignored path reaches the audit ref while staying out of the
accepted commit and out of the landed patch. Each `.kanban/loop/<base>.jsonl` record carries its
`auditCommit`, so a long-swept iteration is still `git show`-able. The audit ref is never the
accepted-experiment branch, it is never checked out, and Kanban never deletes it — `git
branch -D kanban-audit/<base>` is yours to run when the trail has served its purpose.

### Landing

The loop uses a **private committed experiment branch** and a saved patch. Only accepted
candidates are committed, and only in `kanban-autoresearch/<base>`. Its final diff lands with
`git apply` into your working tree, still uncommitted. At final completion Kanban stages only the
accepted experiment paths and suggests the commit message; it never commits the user checkout.
Kanban cannot lock your git working tree, so landing re-checks HEAD, cleanliness and the session
token immediately before applying; a patch that no longer applies leaves your tree untouched.

Progress appears on the status line; `/kanban experiments` opens a live, auto-refreshing iteration
table without expanding the compact selected-session widget. `/kanban implement stop`,
`/kanban pause`, `/kanban remove`, `/kanban open` and Pi shutdown all abort a live loop, and an
aborted loop lands nothing.

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
A killed Pi loses nothing durable: `.kanban/loop/<base>.run.json` holds the recovery point and
`loop.autoResume` picks it up on the next `/kanban open`.

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

Context capacity comes directly from Pi's active model and context-usage APIs. This row belongs to the **current Pi conversation**, not the selected Kanban session. It no longer requires a manually configured model limit and does not display `unavailable`; immediately after compaction it uses the last known token usage for that Pi conversation, or zero if none exists yet.

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
