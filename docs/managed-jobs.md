# Managed iteration jobs

With `loop.enabled`, each iteration is a persistent supervisor session. It owns its worker and
reviewer sessions, configured jobs, review/integration, repair, and final acceptance. A final
assistant response yields; only its private `iteration_finish` tool ends an iteration.
Main Pi chat is available for questions and user-requested changes through `kanban_status` and
`kanban_control`. No external subagent extension is required.

## Configuration

This example uses site-owned scripts; Kanban does not ship a production Slurm/PBS adapter.
Commit scripts that must exist in experiment worktrees, or use an explicitly configured absolute
path for a trusted site adapter. Never depend on untracked files in the main checkout.

```json
{
  "loop": {
    "enabled": true,
    "maxIterations": 10,
    "maxConcurrentChildren": 3,
    "maxChildRuns": 60,
    "maxCoordinatorTurns": 200,
    "maxSubmissions": 12,
    "measureTimeoutMs": 86400000,
    "autoResume": true,
    "jobs": {
      "cpu": { "kind": "local", "command": "python3 tools/research_jobs.py local", "timeoutMs": 600000 },
      "capture": {
        "kind": "scheduled",
        "submit": "python3 tools/research_jobs.py submit",
        "status": "python3 tools/research_jobs.py status",
        "cancel": "python3 tools/research_jobs.py cancel",
        "collect": "python3 tools/research_jobs.py collect",
        "pollIntervalMs": 30000,
        "operationTimeoutMs": 30000,
        "timeoutMs": 86400000
      }
    }
  }
}
```

`maxConcurrentChildren` defaults to 3. Optional campaign limits are cumulative across iterations
and restart: `maxChildRuns` counts delegated attempts; `maxSubmissions` reserves one slot before
each new scheduled operation (including attempts whose submission becomes uncertain).
`maxCoordinatorTurns` counts event-delivery activations, not individual LLM requests/tool calls
within an activation or billed tokens. These limits default to unset and accept zero. An explicit
user revision can change them. No fixed per-lane repair-attempt limit is imposed. Local jobs do
not consume scheduled-submission slots; `maxSubmissions: 0` allows CPU-only recovery.

Each command has a finite timeout. A scheduled job's `timeoutMs` covers its lifetime, including
queue time, from reservation; it defaults to `measureTimeoutMs` and does not reset on reconnect.
`operationTimeoutMs` limits each submit/status/cancel/collect operation (default 30 seconds).
The host polls status at `pollIntervalMs` (default 30 seconds); unchanged status neither writes
state nor wakes a model. Configure site limits in the adapter; Kanban does not enforce GPU-hours
or inspect arbitrary shell commands for resource use.

## Adapter protocol

Commands are trusted, explicitly configured strings executed by Bash in a private source
snapshot. Model parameters are JSON on stdin, never interpolated into command text:

```json
{
  "operation": "status",
  "key": "stable-submission-key",
  "externalId": "scheduler-job-id-if-known",
  "params": { "profile": "TP", "retainedRun": "/site/results/run" },
  "revision": 2,
  "sourceCommit": "immutable-source-sha"
}
```

The environment inherits Pi's shell and adds `KANBAN_ITERATION`, `KANBAN_MAX_ITERATIONS`,
`KANBAN_BASE`, `KANBAN_BEST_METRIC` when known, `KANBAN_JOB_KEY`, `KANBAN_JOB_NAME`,
`KANBAN_GOAL_REVISION`, and `KANBAN_JOB_ID` when known. Existing jobs retain their adapter,
parameters, source, original revision and deadline through goal changes.

Exit zero and put a JSON object on the final stdout line; preceding public logs are allowed.
Stdout parsing is bounded to 65,536 characters and public/durable command tails to 8,000.

| Operation | Required result and behavior |
| --- | --- |
| `submit` | Return `externalId` and a known state, normally `queued` or `running`. Use the stable `key` as an idempotency identity in scheduler metadata and durable receipts. |
| `status` | Return `queued`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`, `blocked`, or `missing`, with the original ID when found. Must work by key even when submission lost its response. |
| `cancel` | Return a confirmed terminal state, or `unknown`. A successful cancel-request exit code alone is not cancellation confirmation. |
| `collect` | Return `accepted: true` only after domain validation, plus nonempty `artifacts` (up to 64 references), optional finite numeric `metric`, and optional `message`. |
| local `command` | Return explicit `accepted: true/false`, optional artifacts, metric, and message. Exit zero alone does not accept a malformed/missing JSON result. |

`missing` must mean an authoritative search by the submission key found no job, including
accounting/history and any adapter receipt. A temporary scheduler outage or delayed visibility
is `unknown`, never `missing`. An existing recorded ID that disappears becomes unknown regardless.
Kanban reconciles before submitting, reserves budget durably, and preserves ambiguous attempts.
Exactly-once external submission depends on a correct adapter: Kanban cannot make a non-idempotent
scheduler API transactional. Never generate a new key to bypass uncertainty.

Collection runs after failed and cancelled jobs too: a training/postprocessing failure can leave
valid captured data. Execution state and evidence acceptance are separate. An adapter must check
the required files, profile coverage, sample counts, schema and validity; Kanban trusts that
configured validator and retains its references, rather than pretending arbitrary paths prove
scientific validity. Use a separate named CPU operation to repair/revalidate retained output when
collection failed. Reusing a job name returns its original receipt; deliberate retries use a new
name, after resolving the old job. Any unknown scheduler work prevents new scheduled submissions.

## Migrating an opaque research batch

Legacy `loop.validate`/`loop.metric` still work through `iteration_measure`: validation failure
does not skip metric. Kanban sees only the whole command, not TP/DP/MoE jobs hidden inside it.
The host cannot reconnect to jobs launched by a legacy command, hook, or third-party extension.
Do not run the old batch submitter and managed adapters as competing owners.

For the FINCCL-style workflow:

1. Expose TP, DP, and MoE capture as independent named operations through the site adapter.
   Record existing retained runs in parameters; do not resubmit already useful data.
2. Put compilation, CPU correctness checks, offline DP postprocessing and census validation
   behind local adapters. Leave GPU allocation and cancellation with the scheduled adapter.
3. Define acceptance per profile in the composed plan. The coordinator gets every completion
   and failure event, delegates a repair/reviewer for a failed lane, validates the repaired
   snapshot, and retries only the affected capture. Siblings keep their identities and worktrees.
4. Require a final integrated-source validation/aggregation job as `resultJob` before finishing.
   An evidence-only CPU recovery can finish without a new source commit or GPU submission.
5. Send changed goals via `/kanban goal …` or `kanban_control` with `action: "revise"` and explicit
   settings/scope changes. Pending revisions stop new dispatch/acceptance; the coordinator updates
   the plan, preserves useful work and explicitly revalidates old evidence for the new criteria.

[validate-results.mjs](../examples/managed-jobs/validate-results.mjs) is a runnable CPU adapter
example for a small demonstration result schema. It is not a substitute for FINCCL domain checks.
The fake-scheduler integration tests exercise MoE repair with TP/DP still live and DP evidence-only
recovery without launching real cluster work.

## Lifetime and recovery

Pi new/resume/fork and `/kanban open` do not stop a live coordinator. Pi quit/reload or Kanban
pause aborts local sessions/commands and observation, but does not cancel managed scheduler jobs.
`/kanban implement` restores the coordinator and child conversation files and reconnects job keys;
interrupted local commands are failed and require a fresh attempt. There is no daemon while Pi
is down. Run only one Pi owner for a campaign; another process's control file changes do not
deliver an in-process wake to the original owner.

`/kanban implement stop` and confirmed `/kanban remove` explicitly cancel managed jobs first.
Unconfirmed cancellation refuses stopping/removal and preserves the recovery record and snapshots.
A dormant unresolved job must be resumed to reconcile/cancel it. Hard-kill gaps, unavailable
scheduler accounting, corrupt manifests, externally modified source/refs, or a stale repository
lock can require operator intervention. Nothing promises recovery of unrecorded model output.

All snapshots referenced by coordinator history are retained, even after an iteration finishes.
The four-row board stays compact; the separate dashboard and status results show lanes, jobs,
questions, revisions and evidence. Use deliberate cleanup for completed-session evidence; never
delete a worktree that a scheduler job may still read.
