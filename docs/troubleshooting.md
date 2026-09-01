# Kanban troubleshooting and verification

Use this page after checking the selected plan and handoff. Prefer the smallest safe repair; do not delete `.kanban/` wholesale, reset Git state, or commit automatically.

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| `kanban repository lock is busy` | Another Pi process is writing state, or a process crashed while holding the cooperative lock. | Wait and retry. If it remains stale, confirm no Pi process is using the repository, remove only `.kanban/lock`, then run `./init.sh --check`. |
| No session appears in the widget or picker | All sessions completed, or no session was created. | Review `.kanban/plans/` for history; create a new session with `/kanban create <prompt>` if new work is needed. |
| A completed session is still in `state.json` | Legacy/manual state or incomplete migration. | Do not hand-edit first. Start Pi to trigger migration, then run `./init.sh --check`; preserve a copy and make a minimal repair only if migration cannot run. |
| `handoff.md` exceeds 200 lines | A checkpoint supplied too much continuation prose. | Condense the supplement to decisions, blockers, next steps, and validation; keep detailed work in the plan. |
| `/kanban open` starts a new conversation | Kanban sessions are intentionally independent from Pi conversation files; at implement/critique the open path seeds a fresh conversation, and on a pipeline-owned stage it re-runs that stage instead. | This is expected. Read the selected plan, which is authoritative over the global handoff, then run the configured init command before work. |
| The handoff seems to discuss another session | `handoff.md` is global and has been deliberately preserved across session selection. | Use the selected plan for the target session; the seeded Pi conversation includes the same precedence reminder. |
| Pi opens an old chat when the application starts | Pi's own native startup/resume behavior selected that conversation. | Kanban does not bind it to a board session. Its widget only reports the current Pi context. Use `/kanban`, then Enter on a session, for a clean work conversation. |
| The title is generic or based on the prompt | The private title completion failed or no model was selected. | This is the designed fallback. Continue unless the title would collide with another active session; then create a distinct session after resolving scope. |
| Current Pi context bar is full just after compaction | Pi temporarily reports no token total. | Kanban uses the last known total for this Pi conversation, or zero for a new one. Wait for the next model response for a refreshed value. |
| External agent count is wrong | The checkpointed roster is stale, or a primary agent is idle/working differently than expected. | Send one material checkpoint with the complete current external roster. Do not add per-tool status calls. |
| A pipeline stage fails (`runner unavailable` or a manual-mode flip notify) | The runner backend is unavailable, a refine/grill/compose child failed, or ALL research workers failed (spawn/model/other). | This is the designed fallback. The session is durably `manual`; run `/kanban open` to continue the current stage in the main conversation. Manual is durable for the session: it never flips back automatically. |
| Children fail even though the parent model works | Child auth/models come from `~/.pi/agent` files, so providers registered dynamically via `pi.registerProvider` may not authenticate in a child (L1). | Configure a child-capable model in `.kanban/config.json` (`models.<stage>` as `"provider:model-id"`) or `~/.pi/agent/extensions/kanban.json`; or accept the manual fallback. A critique-gate child failure instead records `plan.gateFailure` and offers the manual `critiqueSummary` path. |
| Child failure says `spawn` | The subprocess backend binary could not start (ENOENT etc.). | Set `runner: "inprocess"` in config, or fix `piBin` (default `"pi"` on PATH). Exit ≠ 0 that names model/provider resolution is `model`; anything else is `other`. |
| Critique gate child fails repeatedly | Gate children are subject to the same L1 model-auth limits. | Recorded durably in `plan.gateFailure`; no loop, no manual flip, no silent archive. Retry with a plain `stage_complete` or complete via the manual `critiqueSummary` path (authorized while `gateFailure` exists). |
| Orphaned `.kanban/work/*.md` files | A crash between a completion mutation and the workfile delete. | Startup cleanup removes any workfile whose base matches no session (active or blocked) in `state.json`; a paused session keeps its workfile. You can also delete them by hand outside a running session. |
| How do I get back to pipeline mode after a fallback? | Manual mode is durable for the session by design. | Only a new pipeline-mode session (or a recreated session) runs the pipeline: `/kanban open` mints a fresh `pipelineToken` only for pipeline-mode sessions; it does not convert a manual session. |
| Two pipelines at once? | At most one live pipeline run per process. | Pause or let the current run finish; only then start another (`/kanban create`/`/kanban open` refuse otherwise). |
| `./init.sh --check` fails plan/state validation | A session selection, plan path, JSON artifact, or handoff constraint is invalid. | Read the exact failure, restore the missing artifact or repair the smallest inconsistent record, then rerun the check. |
| `npm test` cannot start in a restricted execution sandbox | The runner cannot create its local IPC pipe. | Run the same test command in a normal local shell or an approved environment; do not treat this as a project assertion failure without rerunning it. |

## Verification sequence

At the start of a session:

```sh
./init.sh
```

Before final handoff:

```sh
./init.sh --check
```

The completion command performs these checks in order:

1. state JSON parses as schema v4, has no saved Pi conversation path, and has a valid selected active session, if any;
2. no state session has `state: "complete"`;
3. each active plan path is safe, exists under `.kanban/plans/`, and is valid JSON;
4. `handoff.md` exists and has at most 200 physical lines;
5. `git diff --check` and `git diff --cached --check` report no whitespace errors;
6. `npm run typecheck` succeeds;
7. `npm test` succeeds.

After success, report the suggested commit emitted by the script. Do not execute it unless the user explicitly asks to commit.
