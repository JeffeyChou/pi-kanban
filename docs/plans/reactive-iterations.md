# Reactive implement iterations

Implemented design, 2026-09-04. This supersedes the single implement-child lifecycle in
[loop-driver-v2.md](loop-driver-v2.md); accepted-branch, audit, fitness and detect-and-defer
landing rules remain in force where not explicitly refined here.

## Problem and ownership

The FINCCL session exposed split ownership: some batch work remained hidden inside a legacy
measurement while main-chat workers repaired other parts. One iteration now has one durable
coordinator session, private worker/reviewer sessions, and independent configured local/scheduled
operations. This is the enabled-loop default, not an alternative mode. Disabled loops and the
planning/critique APIs are unchanged. Main chat queries or sends user intent, without competing
repairs. A coordinator response boundary yields; only its private finish tool closes an iteration.

## Modules and authority

- `iterationsession.ts`: extension-free Pi SDK sessions persisted under `.kanban/loop/`.
  `sendCustomMessage(..., { triggerTurn: true })` resumes the same conversation. Public text and
  usage are observed separately; restored lifetime usage is not counted into current totals twice.
- `coordinationstore.ts`: versioned atomic control snapshot plus durable inbox in
  `<base>.coordinator.json`, protected by board lock/title/stage/token. No new v4 Session fields;
  internal lane/job identities never become checkpoint task IDs.
- `coordinator.ts`: single event consumer/model session, concurrent lanes/jobs, exact-candidate
  review, locked integration, approved goal revisions and explicit completion guards.
- `jobs.ts`: configured commands, stable-key reconciliation, finite deadlines, separate
  execution/acceptance states, cancellation confirmation and host status polling.
- `implementloop.ts`: campaign boundaries, host fitness, private accepted commits, lessons/audit,
  final landing and the sole locked implement→critique transition.

Command strings originate in explicit config or a recorded user settings revision. Models have
no shell; they supply named operations and JSON parameters. Adapters must validate parameters
and enforce site resource policy. Worktrees are cooperative isolation, not a filesystem sandbox.
No production Slurm/PBS adapter or implicit third-party-extension adoption is claimed.

## Event and recovery protocol

1. Reserve a lane/job under the repository lock; scheduled attempts reserve budget before an
   external submission. Atomically record operation identity and pending delivery.
2. Execute outside the lock on private source snapshots. Jobs freeze adapter, parameters,
   source, revision and lifetime deadline. Reusing a name returns its original receipt.
3. Persist results/failures/questions before delivering events to the coordinator. Mark only
   delivered IDs handled after its response; newly arriving events remain pending.
4. The coordinator repairs affected work and yields while future work or a concrete decision is
   pending. Repeated empty responses with no work or blocker stop with a visible stall.
   Model errors/budget exhaustion preserve recovery state rather than claiming completion.
5. Restart retokens the current iteration, opens saved coordinator/child conversations, preserves
   partial source and reconciles scheduler keys before replacement. Interrupted local commands
   need a fresh attempt; partial output is not acceptance.

Only changed scheduler status generates durable events/model work. UI observers do not poll.
Delivery is at-least-once across a crash. Named receipts protect ordinary duplicate tool calls;
authoritative adapter key lookup supplies idempotency across the external submission gap.
`unknown`/`blocked` scheduler ownership prevents new submissions and finalization. A missing
recorded scheduler ID never authorizes replacement. The host cannot make an unreliable adapter's
`missing` verdict safe; adapter correctness is part of the trust boundary.

Pi new/resume/fork preserves the live owner and rebinds its UI. Quit/reload or pause suspends
local sessions/observers without cancelling scheduler work. Explicit stop/remove cancels first
and refuses destructive cleanup while ownership is uncertain. Retained worktree entries survive
dead-PID sweeping. There is one run per process, not a daemon or distributed cross-process lease.

## Source, evidence and acceptance

Workers have private snapshots and declared path claims. Read-only reviewers pass/fail an exact
candidate identity (original integration baseline plus patch). Partial-work retries carry that
baseline so inherited fixes are included. Integration is locked and serial; conflicting patches
require repair against current source. No model directly writes the integration worktree.

Validation runs on separate source snapshots. Command-generated changes, build debris and
evidence cannot leak into accepted source commits. Candidate validation binds the reviewed
fingerprint; final validation binds integrated source and current goal. Execution failure and
dataset acceptance are separate: configured collection can validate useful capture from a failed
postprocessing job. Final named-job acceptance requires a collected `resultJob`; evidence-only
success needs retained artifacts or a metric, not an empty commit.

Only accepted source deltas advance `kanban-autoresearch/<base>`, from a clean private worktree.
Detached snapshot commits provide immutable source identities without publishing to that branch.
Audit remains best effort, separate, and allowed to include force-added ignored evidence.

## Live revisions and budgets

`kanban_control` accepts `steer`, `retry`, `reply`, or `revise`. Revision requests durably record
user intent/settings/scope; consecutive pending requests are combined. Scope checkpoints queue
the same revision under their lock. Pending revisions block dispatch, integration and finishing;
running jobs keep frozen config/source. Applying a revision updates the plan prompt/scope,
bounded compose section and control snapshot under one lock without changing stage. Only
recorded user requests change settings. Measurements are invalidated; metric-definition/direction
changes reset comparisons to a supplied new baseline or none. Older evidence needs explicit
revalidation. Affected workers can be cancelled/retried or retired; useful siblings continue.
Final successful landing checks token, revision, pending control and final-source validation in
the same locked commit as implement→critique.

One iteration can contain many repair cycles. Existing iteration/no-improvement limits apply at
iteration boundaries. Optional cumulative submission, child-attempt and coordinator activation
limits bound campaigns; job deadlines survive resume. There is no fixed repair count. An explicit
user revision can extend budgets without restarting successful siblings.

## Known boundaries and validation

Legacy validate/metric is opaque; independent recovery requires [managed adapters](../managed-jobs.md).
Persistent implement sessions use the in-process SDK and installed Pi auth/providers, with no
subprocess fallback. Snapshots/internal transcripts consume disk and remain under `.kanban/`;
completed-session cleanup is deliberate operator work and refs are never automatically deleted.
Individual artifact replacements are atomic, not a transaction spanning Git and the scheduler.
Hard-kill gaps, stale locks, corrupt records or external ref changes can require manual repair.

Fake SDK/scheduler tests cover MoE repair with TP/DP live, offline DP acceptance, revisions,
questions, no idle model turns, persisted session recovery, ambiguous submission/cancellation,
immutable source acceptance and retained worktrees. Git integration tests cover private commits,
audit separation, unstaged landing and stage/token guards. Tests do not submit cluster work or
bill real models; production behavior requires a site-adapter smoke test.
