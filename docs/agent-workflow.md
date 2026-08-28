# Agent operating guide

Use this guide when you are the agent executing work in a repository with Kanban enabled. It describes the expected operating cadence; it is not a substitute for the repository's own `AGENTS.md` or user instructions.

## 1. Start with durable context

After a Kanban kickoff or resume, run:

```sh
./init.sh
```

Read the selected plan named by the output. It contains the original prompt, scope boundaries, agent roster, and compact `done` / `current` / `next` work summary. The active title, stage, and agents in `.kanban/state.json` are authoritative; do not infer them from an old plan or handoff.

For a new session, the user invokes:

```text
/kanban create <prompt>
```

Do not ask the user to supply a separate title unless title generation or local fallback produced an unsuitable result. Kanban has already generated one.

## 2. Work at material checkpoints

`kanban_update` always targets the selected session. It has exactly two actions:

- `checkpoint` for a meaningful change in scope, agent roster, work summary, or continuation information.
- `stage_complete` when the entire current stage is complete; it may include the same checkpoint data.

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

Stages are a communication and review structure:

| Stage | Agent outcome before completion |
| --- | --- |
| `refine` | Clear goal, audience, scope, constraints, and success criteria. |
| `research` | Verify repository facts, relevant APIs, and external constraints. |
| `grill` | Challenge assumptions, failure modes, compatibility, and safety. |
| `compose` | Produce a decision-complete implementation plan. |
| `implement` | Make and validate the agreed change. |
| `critique` | Independently inspect the result and final validation evidence. |

Only use `stage_complete` after the current outcome is actually met. Kanban does not independently prove that tests passed, required reviews happened, or external agents finished; that remains the active agent's responsibility.

At the final stage, Kanban archives the plan and removes the completed core session. Its response reminds you to run the completion check. Do not create a replacement session merely to retain historical detail—the completed plan is the history.

## 4. Write a useful handoff

The single handoff already contains operating rules. Its supplement should be concise and contain only what state and plan do not:

- material design decisions and the reason for them;
- blockers, uncertainties, and the next safe action;
- exact validation already run and failures that remain;
- local implementation clues a replacement conversation cannot cheaply rediscover.

Do not repeat the title, current stage, full agent roster, source-file list, task database, UUIDs, or a prose copy of the plan. Keep the supplied supplement well below the 200-line total-file cap; Kanban rejects oversized handoffs.

## 5. Resume safely

`/kanban resume` first selects an unfinished session by title. If the saved Pi conversation file still exists, Pi switches to it. Otherwise Kanban seeds a new conversation with the one handoff plus selected plan and sends one kickoff.

On any resumed conversation, run `./init.sh` again. The plan is durable, but repository code, branch state, and uncommitted changes may have moved since the last handoff.

## 6. Finish without committing

Before announcing completion:

```sh
./init.sh --check
```

This validates the durable structure and runs `git diff --check`, type checking, and the test suite. It prints a suggested commit message and changed files. Do not run `git add` or `git commit` unless the user separately asks for that action.

In your final response, state the validation result and provide a **Suggested commit** section with the proposed message and relevant files. The user decides whether to commit.
