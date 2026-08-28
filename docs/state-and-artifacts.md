# State and artifact reference

This is the compact persistence contract for agents and maintainers. `.kanban/` is ignored by Git and repository-local; it may include local paths and workflow notes, so do not treat it as shareable project metadata.

## `state.json`: current control state

Schema version 3 stores only unfinished sessions:

```json
{
  "schemaVersion": 3,
  "selectedSessionTitle": "Refresh durable persistence",
  "sessions": [
    {
      "title": "Refresh durable persistence",
      "stage": "implement",
      "state": "active",
      "planPath": "plans/2026-08-27-refresh-durable-persistence.json",
      "piConversationPath": "/local/pi/session.jsonl",
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

The only valid session states are `active` and `blocked`; `complete` is intentionally invalid in v3 state. A completed session is represented by its completed plan and the standby handoff, not a historical entry here.

Session titles are unique while active. `selectedSessionTitle` must name an element of `sessions` when present. `init.sh --check` validates these rules.

## Plans: progressive detail

Each session gets one compact plan in `.kanban/plans/` named:

```text
YYYY-MM-DD-safe-title.json
```

The date is the local creation date. `safe-title` is a lowercase ASCII slug, with unsafe characters removed. Filename collisions use `-2`, `-3`, and so forth; the original readable title remains in the JSON.

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

Plans must not contain UUIDs, task/todo IDs, evidence arrays, review records, source-file fields, or a copy of Pi context usage. A plan is a compact decision aid, not an event log.

## `handoff.md`: supplemental continuation data

`handoff.md` is exactly one Markdown file. Its operating-rules header is maintained by Kanban. The supplement is replacement-style text supplied by a material checkpoint.

Use the supplement for decisions, blockers, next steps, and validation observations. Never use it to duplicate state title/stage/roster or an entire plan. The complete file is capped at 200 physical lines.

After final completion, Kanban rewrites the handoff to a standby page that contains only the latest completed plan's title and relative plan path. That path remains available for human review, even though the session disappears from state.

## Migration from v1/v2

When Kanban first initializes a v1 or v2 board, it:

1. creates compact date/title plans for every legacy session;
2. condenses legacy task/todo state into `work.done`, `work.current`, and `work.next` text;
3. preserves only unfinished sessions in v3 state;
4. creates an active or standby single handoff;
5. removes legacy `.kanban/handoffs/` and UUID-named plan files after the new artifacts are written.

The migration intentionally drops evidence, review data, source lists, model-limit maps, integration-availability maps, and durable internal IDs. They were either high-noise operational data or no longer influence the v3 outcome.

## Lock and manual recovery

Kanban uses `.kanban/lock/` as a cooperative lock. It is safe to let normal mutations retry. If a crashed process leaves a stale lock, first verify that no Pi process is still operating on this repository; only then remove that specific `.kanban/lock` directory manually and rerun `./init.sh --check`.

Do not hand-edit `state.json`, plans, or the handoff during a normal agent flow. If recovery requires manual editing, preserve a copy outside `.kanban/`, make the smallest repair possible, and immediately run the completion check.
