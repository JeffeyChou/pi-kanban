# Agent operating guide

Use this guide when you are the agent executing work in a repository with Kanban enabled. It describes the expected operating cadence; it is not a substitute for the repository's own `AGENTS.md` or user instructions.

## 1. Start with durable context

When the repository has an executable `./init.sh`, the implement kickoff, final completion text, and the handoff's operating-rules header carry the configured commands (`init.start` / `init.check` from `.kanban/config.json`; `"auto"` resolves to `./init.sh`). Stage prompts and tool guidance never mention init commands.

At implement start, run the configured init command:

```sh
./init.sh
```

Read the selected plan named by the output. It contains the original prompt, scope boundaries, agent roster, and compact `done` / `current` / `next` work summary. The active title, stage, mode, and agents in `.kanban/state.json` are authoritative; do not infer them from an old plan or handoff. The `.kanban/work/<base>.md` workfile holds the pipeline's per-stage output sections; they are prompt inputs, while `state.json`'s stage alone decides what to do next.

For a new session, the user invokes:

```text
/kanban create <prompt>
```

Do not ask the user to supply a separate title unless title generation or local fallback produced an unsuitable result. Kanban has already generated one.

### Pipeline mode vs manual mode

New sessions are `pipeline` mode: refine, research, grill, and compose run in orchestrator-owned child sessions before your conversation starts, and the pipeline notifies when compose is done. You then enter at implement via user-initiated `/kanban open` (or dashboard Enter) — the pipeline never switches conversations itself. In pipeline mode you own only implement and critique via `kanban_update`; `stage_complete` during a pipeline-owned child stage is rejected and tells you to use `/kanban open`.

Sessions fall back to durable `manual` mode (locked, revalidated, notified) when the runner backend is unavailable, a refine/grill/compose child fails, or ALL research workers fail. In manual mode every stage is agent-owned again: each `stage_complete` result carries the next stage's single-responsibility prompt, and entering implement always delivers the implement kickoff (configured init-start plus detected external tools). Manual mode is durable for the session; only a fresh pipeline-mode run mints a new pipeline token.

## 2. Work at material checkpoints

`kanban_update` always targets the selected session. It has exactly two actions, plus critique-gate parameters on `stage_complete`:

- `checkpoint` for a meaningful change in scope, agent roster, work summary, or continuation information.
- `stage_complete` when the entire current stage is complete; it may include the same checkpoint data. In critique it also accepts `rerunCritique` / `acceptRemainingIssues` / `critiqueSummary`, described in the critique-gate section below.

Do **not** call it after every shell command, file edit, test, todo, or subagent message. That produces prompt noise without adding durable value.

Use this decision guide:

| Situation | Update? | Recommended payload |
| --- | --- | --- |
| You read a file or run a normal command | No | Continue working. |
| A task-sized implementation step ends but plan/continuation did not change | No | Continue working. |
| Scope is clarified or a boundary is added | Yes | `inScope` and/or `outOfScope`. |
| External agents are created, finish, block, or change roles | Yes | Complete `agents` roster. |
| A meaningful phase of work becomes done/current/next | Yes | Compact `work` replacement. |
| The next conversation would need a decision, blocker, or verification note | Yes | Replacement `handoff` supplement. |
| The fixed stage is genuinely complete | Yes | `stage_complete`, plus any changed fields. |

Example checkpoint:

```json
{
  "action": "checkpoint",
  "inScope": ["Schema v3 migration", "four-line selected-session widget"],
  "outOfScope": ["Launching Pi subagents", "automatic git commits"],
  "agents": [
    { "name": "Reviewer", "role": "API and migration review", "status": "working" }
  ],
  "work": {
    "done": ["Mapped v2 fields to compact plans"],
    "current": ["Implement artifact migration"],
    "next": ["Run full regression suite"]
  },
  "handoff": "Legacy plans must be written before state cleanup. The migration test covers this ordering."
}
```

No session ID, task ID, todo ID, or source-file field belongs in this call. The agent roster is a full external roster, not a patch list. The primary coordinator remains present automatically even when omitted.

## 3. Advance stages deliberately

Stages are a communication and review structure. In pipeline mode, stages `refine`–`compose` are the orchestrator's; the following table applies to the agent-owned stages (`implement`, `critique`) and to manual mode's full sequence:

| Stage | Owner | Agent outcome before completion |
| --- | --- | --- |
| `refine` | pipeline child | Clear goal, audience, scope, constraints, and success criteria, plus a `Verdict: simple|standard` (fast path). |
| `research` | pipeline (N parallel child workers) | Verify repository facts, relevant APIs, and external constraints; one angle per worker. |
| `grill` | pipeline child + orchestrator Q&A | Challenge assumptions, failure modes, compatibility, and safety; open questions answered or assumed. |
| `compose` | pipeline child | Produce a decision-complete implementation spec (`## compose`). |
| `implement` | main conversation | Execute the spec and validate the agreed change; the workfile spec and plan are the authority. |
| `critique` | main conversation + gate child | Independently inspect the result and final validation evidence against the spec; see the critique gate below. |

Only use `stage_complete` after the current outcome is actually met. Kanban does not independently prove that tests passed, required reviews happened, or external agents finished; that remains the active agent's responsibility.

A `stage_complete` result carries the next stage's transition prompt in its result text; never expect a queued kickoff message afterward. A blocked (`state: "blocked"`) session refuses every agent-owned mutation until unpaused.

### Fast path

When the refine child returns a `simple` verdict and `fastPath` is enabled, the pipeline runs refine → compose directly and skips research and grill; the justification is recorded in `plan.work.done` and the `## refine` section. With `fastPath: false` (or any non-simple verdict) no stage is skipped. There is no `skipRemaining` parameter anywhere.

### The critique gate

The gate runs a child (`read/grep/find/ls` plus the tool-computed diff) inside `stage_complete(critique)`. Its contract: end with `## critique`, first line `Gate: PASS` or `Gate: FAIL`, then `- ` issue bullets. Unparseable output counts as FAIL.

- PASS → the session archives with `plan.completion = { critique: "pass" }`; the workfile is deleted; the result carries the completion text (init-check command if configured, suggested commit).
- FAIL → the stage stays critique, `plan.critiqueAttempts++`, the issues land in the result (and the `## critique` workfile section); fix the issues and call `stage_complete` again. Fixes during critique are allowed; the gate re-reads the working tree on every run.
- Attempts cap: once `critiqueAttempts >= 2`, a plain `stage_complete` will NOT re-run the gate; the result requires exactly one of `rerunCritique: true` (explicit re-run, attempts keep counting) or `acceptRemainingIssues: true`. Early accept before the cap is refused ("fix or re-run the gate first"), and passing both flags together is an error.
- Accept path: with a UI, the tool asks the human to confirm (120 s timeout; timeout or refusal counts as refusal); on refusal it writes `plan.pendingCompletion` and points you at `/kanban complete`. Headless, accept completes immediately with the issues recorded durably in `plan.completion.note`. A later PASS or an explicit `rerunCritique` clears `pendingCompletion`.
- Gate-child failure (spawn/model/other) never loops, never flips the session to manual, and never silently archives: the failure is recorded durably as `plan.gateFailure`, and the only completion offered is the manual summary path (see below). A plain `stage_complete(critique)` retries the gate while `gateFailure` exists; a success clears it.
- Manual-mode critique (and the pipeline-mode child-failure path) requires `critiqueSummary` (what was reviewed, verdict, remaining issues); missing ⇒ error result carrying the critique-stage prompt. With a UI the human confirms; headless completes. Either way the bounded summary is recorded as `plan.completion = { critique: "manual", note }`. In pipeline mode the `critiqueSummary` path is authorized only while `plan.gateFailure` exists — a healthy gate cannot be bypassed with a summary.
- `/kanban complete` is the escape hatch: valid only while `plan.pendingCompletion` exists (a tool path directed you here), takes no free-form inputs, confirms with the user, and converts the pending record into `plan.completion`. Otherwise it just notifies you.

At the final stage, Kanban archives the plan and removes the completed core session. Do not create a replacement session merely to retain historical detail—the completed plan is the history.

## 4. Write a useful handoff

The single handoff already contains operating rules. Its supplement should be concise and contain only what state and plan do not:

- material design decisions and the reason for them;
- blockers, uncertainties, and the next safe action;
- exact validation already run and failures that remain;
- local implementation clues a replacement conversation cannot cheaply rediscover.

Do not repeat the title, current stage, full agent roster, source-file list, task database, UUIDs, or a prose copy of the plan. Keep the supplied supplement well below the 200-line total-file cap; Kanban rejects oversized handoffs.

## 5. Open work safely

In `/kanban`, highlight an unfinished session and press Enter, or run `/kanban open [title]` (no title means the currently selected session). A blocked session is refused with a notify and must be unpaused first. At implement/critique this starts a fresh Pi conversation seeded with the one global handoff, the selected plan, and the workfile spec (a missing workfile is tolerated: the seed notes "spec unavailable" and you proceed from the plan JSON). On a pipeline-owned child stage it instead re-runs that stage's child. `/kanban open` also aborts any live pipeline run for that title before minting a fresh token, so two duplicate runs can never coexist.

Kanban never saves or restores a Pi conversation file.

The seed says that the global handoff may describe a previously selected session. Read the selected plan as the authoritative source, then run the configured init command again. The plan is durable, but repository code, branch state, and uncommitted changes may have moved since the last handoff.

## 6. Finish without committing

Before announcing completion, run the configured completion check. With the default `"auto"` detection this is:

```sh
./init.sh --check
```

This validates the durable structure and runs `git diff --check`, type checking, and the test suite. It prints a suggested commit message and changed files. Do not run `git add` or `git commit` unless the user separately asks for that action.

In your final response, state the validation result and provide a **Suggested commit** section with the proposed message and relevant files. The user decides whether to commit.
