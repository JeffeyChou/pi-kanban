# State and artifact reference

This is the compact persistence contract for agents and maintainers. `.kanban/` is ignored by Git and repository-local; it may include local paths and workflow notes, so do not treat it as shareable project metadata.

## `state.json`: current control state

Schema version 4 stores only unfinished sessions:

```json
{
  "schemaVersion": 4,
  "selectedSessionTitle": "Refresh durable persistence",
  "sessions": [
    {
      "title": "Refresh durable persistence",
      "stage": "implement",
      "state": "active",
      "mode": "pipeline",
      "pipelineToken": "d3f1a9…",
      "planPath": "plans/2026-08-27-refresh-durable-persistence.json",
      "agents": [
        { "name": "Primary agent", "role": "Coordinator", "status": "idle" },
        { "name": "Reviewer", "role": "API review", "status": "working" }
      ],
      "createdAt": "2026-08-27T12:00:00.000Z",
      "updatedAt": "2026-08-27T12:10:00.000Z"
    }
  ],
  "updatedAt": "2026-08-27T12:10:00.000Z"
}
```

The only valid session states are `active` and `blocked`; `complete` is intentionally invalid in v4 state. A completed session is represented by its completed plan and the standby handoff, not a historical entry here. Pi conversation paths are intentionally absent: Kanban sessions do not claim, save, or restore Pi chats.

`mode` is optional: `"pipeline"` (new sessions) or `"manual"`; a missing or unknown value means `"manual"` (the legacy safe default). `pipelineToken` is the CAS identity of the live pipeline run or armed critique gate: minted per run, revalidated by every locked pipeline/gate commit, and cleared on pause/remove/rename (which also abort the live run via the title-keyed registry). At most one pipeline runs per process.

Session titles are unique while active. `selectedSessionTitle` must name an element of `sessions` when present. `init.sh --check` validates these rules.

## Plans: progressive detail

Each session gets one compact plan in `.kanban/plans/` named:

```text
YYYY-MM-DD-safe-title.json
```

The date is the local creation date. `safe-title` is a lowercase ASCII slug, with unsafe characters removed. Filename collisions use `-2`, `-3`, and so forth; the original readable title remains in the JSON. The creation path stays stable after a title rename.

```json
{
  "title": "Refresh durable persistence",
  "prompt": "refresh persistence and improve the session UI",
  "stage": "implement",
  "status": "active",
  "inScope": ["Schema v3 migration"],
  "outOfScope": ["Automatic subagent launch"],
  "agents": [
    { "name": "Primary agent", "role": "Coordinator", "status": "idle" },
    { "name": "Reviewer", "role": "API review", "status": "working" }
  ],
  "work": {
    "done": ["Defined compact state"],
    "current": ["Implement checkpoint persistence"],
    "next": ["Run validation"]
  },
  "createdAt": "2026-08-27T12:00:00.000Z",
  "updatedAt": "2026-08-27T12:10:00.000Z"
}
```

Plans must not contain UUIDs, task/todo IDs, evidence arrays, review records, source-file fields, or a copy of Pi context usage. A plan is a compact decision aid, not an event log. The single exception is the bounded archive-time `completion` record described below: plans never accumulate progressive review/evidence archives — the transient per-stage sections live in the workfile instead.

In addition to the fields above, a plan may carry these optional additive fields (pipeline/gate control data, never task/todo detail):

- `complexity` — the refine stage's `simple`/`standard` verdict (drives the fast path).
- `critiqueAttempts` — gate runs so far; enforces the critique attempts cap.
- `pendingCompletion` — `{ critique: "accepted-issues" | "manual"; note: string }`; written by a tool confirm-refusal/timeout path with a bounded note, and the only authority (consumed by `/kanban complete`) for the escape-hatch archive. Cleared by a later gate PASS or an explicit `rerunCritique`.
- `gateFailure` — `{ errorKind: "spawn" | "model" | "other"; error?: string }`; written when a critique-gate child fails, and the only thing that authorizes the pipeline-mode `critiqueSummary` path. Cleared by a successful gate run.
- `completion` — `{ critique: "pass" | "accepted-issues" | "manual" | "skipped"; note?: string }`; written exactly once at archive time, note bounded to 10 lines. **This bounded archive-time completion record is the ONE sanctioned exception to the no-review-records invariant**: it is the durable trail because the workfile is deleted at completion. `critique: "skipped"` records the `critique: false` config path.

Plans stay compact otherwise: UUIDs, task/todo IDs, evidence arrays, review records, and source-file lists never return.

## `work/<base>.md`: the workfile

The workfile is the pipeline's transient per-stage output artifact, one file per session under `.kanban/work/`, named by plan basename (`plans/2026-09-01-title.json` → `2026-09-01-title.md`). It is a separate artifact class; plans keep their compact contract untouched.

- **Sole writer**: the orchestrator (child stages) or the critique tool, always inside the same locked commit that advances the stage. Section bodies never include the `## <stage>` heading — the writer owns those heading lines and a read returns bodies without them.
- **Sections**: one `## <stage>` section per stage, each capped at 300 lines at write time (truncated with a note); writes atomically replace one section and preserve the others.
### `.kanban/loop/<base>.*` and `.kanban/worktrees/<base>/` (implement loop, opt-in)

Per session base, never a shared global path, so a second session or a crashed run can never
overwrite another's:

| Path | Contents |
| --- | --- |
| `loop/<base>.jsonl` | One JSON record per iteration: decision, changed summary, validation, metric, failure reason, lesson, verdict. |
| `loop/<base>.md` | The bounded living summary injected into the next iteration's prompt. |
| `loop/<base>.patch` | The best-so-far patch, always written before landing so a failed `git apply` is recoverable by hand. |
| `loop/<base>.landed` | Atomic `{ base, patchSha }` marker written after a successful apply and BEFORE the advancing mutate, so a re-run never applies the same patch twice. |
| `worktrees/<base>/<n>` | The disposable iteration worktree (detached, no branch), force-removed after the iteration. |
| `worktrees/<base>/manifest.json` | Active worktree paths with their owner PID and start time. Startup removes only dead-owner worktrees. |

The loop adds NO `state.json` field: its run identity is the existing `mode: "pipeline"` plus
`pipelineToken`. Artifacts are deleted after a successful advance and at `/kanban remove`, and are
deliberately KEPT after EXHAUSTED or FAILURE so the lessons and the patch survive for the user.

- **Resume authority is `state.json`'s stage ONLY**: sections are prompt inputs. `/kanban open` on a child-run stage re-runs the CURRENT stage (a stale section for it is overwritten). At implement/critique it opens the conversation; a missing workfile there is tolerated — the seed notes "spec unavailable" and the agent proceeds from the plan JSON.
- **Lifecycle**: created on the first section write; deleted at final completion and at `/kanban remove`; never created by migration; orphans (base matching no session in ANY state, active or blocked) are swept at startup — a paused session keeps its workfile.

The workfile is not a review archive: the critique FAIL body lands in `## critique` to explain the current issues, and completion is recorded durably in the plan's bounded `completion` field.

## `handoff.md`: supplemental continuation data

`handoff.md` is exactly one global Markdown file. Its operating-rules header is maintained by Kanban. The supplement is replacement-style text supplied by a material checkpoint.

Use the supplement for decisions, blockers, next steps, and validation observations. Never use it to duplicate state title/stage/roster or an entire plan. The complete file is capped at 200 physical lines.

Selecting, opening, renaming, pausing, or removing a session preserves the global handoff. New Pi conversations receive an explicit notice that its text can describe previously selected work; their selected plan remains authoritative. After final completion, when no active session remains, Kanban rewrites the handoff to a standby page that contains only the latest completed plan's title and relative plan path. That path remains available for human review, even though the session disappears from state.

## Migration from v1/v2/v3

When Kanban first initializes a v1 or v2 board, it:

1. creates compact date/title plans for every legacy session;
2. condenses legacy task/todo state into `work.done`, `work.current`, and `work.next` text;
3. preserves only unfinished sessions in v4 state;
4. creates an active or standby single handoff;
5. removes legacy `.kanban/handoffs/` and UUID-named plan files after the new artifacts are written.

Version-3 migration preserves its unfinished sessions and plans, but strips `piConversationPath` from durable state. Migration intentionally drops evidence, review data, source lists, model-limit maps, integration-availability maps, and durable internal IDs. They were either high-noise operational data or no longer influence the v4 outcome.

## Lock and manual recovery

Kanban uses `.kanban/lock/` as a cooperative lock. It is safe to let normal mutations retry. If a crashed process leaves a stale lock, first verify that no Pi process is still operating on this repository; only then remove that specific `.kanban/lock` directory manually and rerun `./init.sh --check`.

Do not hand-edit `state.json`, plans, or the handoff during a normal agent flow. If recovery requires manual editing, preserve a copy outside `.kanban/`, make the smallest repair possible, and immediately run the completion check.
