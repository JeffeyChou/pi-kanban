# Kanban troubleshooting and verification

Use this page after checking the selected plan and handoff. Prefer the smallest safe repair; do not delete `.kanban/` wholesale, reset Git state, or commit automatically.

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| `kanban repository lock is busy` | Another Pi process is writing state, or a process crashed while holding the cooperative lock. | Wait and retry. If it remains stale, confirm no Pi process is using the repository, remove only `.kanban/lock`, then run `./init.sh --check`. |
| No session appears in the widget or picker | All sessions completed, or no session was created. | Review `.kanban/plans/` for history; create a new session with `/kanban create <prompt>` if new work is needed. |
| A completed session is still in `state.json` | Legacy/manual state or incomplete migration. | Do not hand-edit first. Start Pi to trigger migration, then run `./init.sh --check`; preserve a copy and make a minimal repair only if migration cannot run. |
| `handoff.md` exceeds 200 lines | A checkpoint supplied too much continuation prose. | Condense the supplement to decisions, blockers, next steps, and validation; keep detailed work in the plan. |
| Resume starts a new conversation unexpectedly | The saved Pi conversation path no longer exists. | This is expected fallback behavior. Read the seeded handoff and plan, then run `./init.sh` before work. |
| Resume cannot load an existing conversation | The existence check passed but Pi could not read the session file. | Keep the plan and handoff; start or resume a new Pi conversation and let Kanban seed it from durable artifacts. |
| The title is generic or based on the prompt | The private title completion failed or no model was selected. | This is the designed fallback. Continue unless the title would collide with another active session; then create a distinct session after resolving scope. |
| Context bar is full just after compaction | Pi temporarily reports no token total. | Kanban uses the last known total, or zero for a new session. Wait for the next model response for a refreshed value. |
| External agent count is wrong | The checkpointed roster is stale, or a primary agent is idle/working differently than expected. | Send one material checkpoint with the complete current external roster. Do not add per-tool status calls. |
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

1. state JSON parses as schema v3 and has a valid selected active session, if any;
2. no state session has `state: "complete"`;
3. each active plan path is safe, exists under `.kanban/plans/`, and is valid JSON;
4. `handoff.md` exists and has at most 200 physical lines;
5. `git diff --check` and `git diff --cached --check` report no whitespace errors;
6. `npm run typecheck` succeeds;
7. `npm test` succeeds.

After success, report the suggested commit emitted by the script. Do not execute it unless the user explicitly asks to commit.
