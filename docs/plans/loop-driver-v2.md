# Kanban implement-experiment loop — plan v2.5 (patch-based worktree-experiment model)

Status: **APPROVED** — dual adversarial review passed. codex round 6: APPROVE (0 findings) on
v2.5; independent reviewer: APPROVE (verified code + git behavior empirically; 3 non-blocking
MINORs, all folded in). Convergence trend 14→12→6→4→2→0, none architectural. All load-bearing git
claims empirically verified in a real repo; child tool ids (`edit`/`write`/…) verified as Pi
built-ins. Ready for implementation (W0–W4). Revision log §11. The loop is commit-free and stage-free (best-so-far is a saved PATCH,
capturing new files without `git add`); the implement child gets no `bash` and the worktree is
documented as cooperative experiment isolation (not an FS sandbox — accepted R); the child's
`Status: complete` verdict GATES the advance (SUCCESS advances, EXHAUSTED lands-partial-and-stays,
FAILURE no-land); landing is detect-and-defer with per-session-base artifacts. Implement→
orchestrator-owned is an explicit documented AGENTS.md:41 change with the `loop.enabled=false`
agent-owned path preserved. Supersedes `loop-driver-v1.md`. Revision log §11. Pending review round 5.

## 1. Context & why this design

Today implement is agent-owned in the main conversation (pipeline stops at compose; `/kanban
open` → `openImplementConversation`). v1 tried to automate that in-conversation and hit an
intractable class of teardown/cross-process races. This design makes implement an
**orchestrator-owned iterative experiment loop** (same shape as the refine/research/grill/compose
child stages) with write tools, each iteration isolated in a git worktree, gated by fitness
(validation + optional metric), recording lessons and injecting them forward — inspired by
`pi-autoresearch`, but **patch-based** (no commits) and using per-iteration worktrees. Because
implement leaves the main conversation and the loop never archives the session, v1's arm-flag /
transactional-guard / drain-race class does not exist here.

## 2. User-confirmed decisions (2026-09-02)

1. Fitness = validation command primary + optional scalar metric. KEEP iff validation passes AND
   (no metric OR metric strictly improved); DISCARD on validation fail / metric regress /
   metric-configured-but-unmeasured / child-error.
2. Winning result lands as UNCOMMITTED, UNSTAGED working-tree changes (never a commit or staging).
3. Fully orchestrator-driven; iterations run via the **in-process** RunChild backend
   (cwd = worktree), forced regardless of `config.runner` (never `pi -p`).
4. Serial iterations; keep advances the best, discard reverts to the prior best.

## 3. Hard invariants (from AGENTS.md / architecture.md) and how v2.2 complies

- **Never `git add`/`git commit`/stage automatically (AGENTS.md:50, architecture.md:18):** the
  loop is COMMIT-FREE and STAGE-FREE. Best-so-far is a patch file (`git diff --binary` captures
  it — a read-only op, no staging); iterations apply it to a fresh worktree with `git apply` (no
  `--index` ⇒ working tree only); landing is `git apply --binary` into the user's tree, unstaged.
  No `git add`, no `git commit`, no index mutation anywhere (fixes round-2 CRITICAL).
- **Implement ownership (AGENTS.md:41) — EXPLICIT CHANGE:** this plan changes the contract. When
  `config.loop.enabled`, implement is ORCHESTRATOR-owned (the loop), and the orchestrator's locked
  commit advances implement→critique after landing — consistent with "an orchestrator locked
  commit advances a stage" (AGENTS.md:39). When `loop.enabled=false` (default), implement stays
  AGENT-owned exactly as today (`openImplementConversation` + `stage_complete(implement)`,
  unchanged). AGENTS.md:41 is updated to state this split (fixes round-2 CRITICAL). The pipeline
  still stops at compose and the user starts implement explicitly (`/kanban implement` or
  `/kanban open`), so "pipeline never auto-switches conversations" (AGENTS.md:46) holds.
- **State minimalism (AGENTS.md:34):** NO new Session fields; the run reuses `mode:"pipeline"` +
  `pipelineToken`; all breadcrumbs live in `.kanban/` (§7).
- **Init commands never executed (AGENTS.md:44):** `loop.validate`/`loop.metric` are separate,
  explicit, opt-in keys the loop executes; never aliased from `config.init.*`.
- **Plan compactness (architecture.md:26):** lessons only in `.kanban/loop/`.
- **Widget = 4 rows only (AGENTS.md:37):** loop progress uses `ctx.ui.setStatus` (the status
  line, separate from the widget), never a 5th widget row (fixes round-2 UI finding).
- **External-tools boundary (AGENTS.md:41):** in-process runner is `noExtensions` ⇒ implement
  children get only built-in write tools, no detected external tools.

## 4. The loop (orchestrator-driven, serial, patch-based)

**Arming.** `/kanban implement` starts ONE orchestrator run (abort registry under the title,
`mode:"pipeline"`, a freshly minted `pipelineToken`, `stage:"implement"`). `mintPipelineToken`'s
predicate is extended to permit `stage:"implement"` for the loop (today it rejects non-CHILD
stages — fixes round-2 arming finding). Refused unless `config.loop.enabled` AND a fitness signal
exists (`loop.validate` or `loop.metric`). One loop per process (a live in-memory registry entry
for any title ⇒ refuse a second). When `loop.enabled=false`, `/kanban implement`/`/kanban open`
fall back to the existing agent-owned `openImplementConversation` (preserved).

**Preflight (fixes round-2 landing-safety, metric-semantics):** require no MODIFIED tracked files
in the main working tree (else refuse: "commit or stash first"); untracked files are permitted and
left untouched (they are not part of `baseCommit`, so worktrees off `baseCommit` ignore them, and
a landing `git apply` that would collide with an existing untracked path fails safely and defers
— round-5 MINOR clean-semantics). `baseCommit = git rev-parse HEAD`. Baseline fitness:
create a throwaway baseline worktree exactly like an iteration worktree (§4.1) off `baseCommit`,
`measure` it, remove it (§4.5). If `loop.metric` is set but the baseline metric is unmeasurable,
refuse to arm ("baseline metric could not be measured"). `bestPatch ← ""` (empty; base is best),
`bestFitness ← baseline`. `validationPass` is defined as `true` when `loop.validate` is unset
(metric-only fitness). **The baseline is NEVER treated as success** (fixes round-3 CRITICAL
baseline-termination): success requires the implement child's own `complete` verdict (below), so
at least one real iteration always runs even when baseline validation is already green. The
baseline measure is used ONLY as the metric-comparison reference, not as a success test.

**Each iteration `n`:**
1. **Worktree** (`§4.1`): `git worktree add --detach <wtPath> <baseCommit>` under gitignored
   `.kanban/worktrees/<base>/<n>`; record it in the manifest (§7). Detached — NO branch (fixes
   round-2 branch-churn). Apply the current best: `git -C <wtPath> apply <bestPatch>` (no
   `--index` ⇒ working-tree-only, unstaged) when `bestPatch` non-empty.
2. **Implement child**: in-process RunChild (FORCED in-process, not `selectRunner` — fixes round-2
   runner-selection), `cwd = wtPath`, with the WRITE tool set `IMPLEMENT_CHILD_TOOLS =
   ["read","grep","find","ls","edit","write"]` — **NO `bash`** (round-4 CRITICAL isolation): a
   child with `bash` could `cd` out of the worktree or run `git add`/`commit` in the real repo,
   escaping the experiment isolation and the never-git-add invariant; dropping `bash` removes that
   specific escape (running commands is the orchestrator's job — the measure step, §4.4). The
   tools are passed via a NEW `tools` override on `runStageChild` (today it hardcodes
   `tools:[...CHILD_TOOLS]` read-only, orchestrator.ts:249 — fixes round-3 tool-plumbing; W3 adds
   the override param), `models.implement` model, prompt =
   `## compose` spec + injected living lessons (§7) + "make the smallest change advancing the
   spec; when the spec is fully implemented end with `Status: complete`, else `Status: continue`."
   The child's `Status:` verdict is parsed like refine's verdict (prompts.ts:231-239).
3. **Capture the candidate patch BEFORE measuring** (fixes round-2 contamination) — a COMPLETE,
   git-add-free capture including NEW files (fixes round-3 CRITICAL untracked-capture): tracked
   changes via `git -C <wtPath> diff --binary <baseCommit>`, PLUS, for each untracked path from
   `git -C <wtPath> ls-files --others --exclude-standard -z` (NUL-safe), a synthesized new-file
   patch `git -C <wtPath> diff --no-index --binary -- /dev/null <file>` — the `--` terminator (and
   NOT a `./` prefix, which would emit `a/./…` headers `git apply` rejects) makes a leading-dash
   filename a path, not an option. **VERIFIED** (git 2.x, temp-repo test): this yields clean
   `a/<path> b/<path>` headers, and the concatenated candidate (tracked `diff --binary <base>` +
   per-untracked hunks) re-applies cleanly into a fresh worktree for subdirectory files,
   leading-dash names, and tracked modifications (fixes round-4/round-5 untracked findings). exit
   1 = "differs" (expected). No `git add`/index anywhere. Measurement debris is not in it.
4. **Measure** (`§4.5`): run `loop.validate` and (if set) `loop.metric` in `<wtPath>`,
   shell-backed and in a new **process group**: `spawn("bash", ["-c", cmd], {cwd, detached:true})`
   (Node `spawn` does not shell-parse a string, so `npm test` needs `bash -c` — fixes round-3
   command-execution), killed via `process.kill(-pid)` (the whole group) on timeout
   `loop.measureTimeoutMs` or the run's abort signal. `validationPass = (loop.validate unset) ?
   true : exit===0`. `metric = parseMetric(stdout, loop.metric_name)`; `loop.metric` set but no
   finite `METRIC` this run ⇒ `metricUnmeasured`.
5. **Decide** (deterministic, orchestrator-side):
   - **KEEP** iff `validationPass && (loop.metric unset OR (metric measured AND strictly better
     than bestFitness by `direction`))`. On keep: `bestPatch ← candidatePatch`, `bestFitness ←
     metric`; record `{decision:"keep", changed, validation, metric}`.
   - **DISCARD** otherwise: record `{decision:"discard", changed, validationTail, metric?,
     failureReason, lesson}`; `bestPatch`/`bestFitness` unchanged. `changed` = `git diff --stat`
     of `candidatePatch` + the child's one-line rationale; `lesson` = hypothesis + why it failed.
6. **Remove the worktree**: `git worktree remove --force <wtPath>` — loop worktrees are
   **disposable scaffolding** (we already captured any patch we wanted), so `--force` is the
   correct, safe discard of throwaway content; unregister from the manifest. (This differs from
   teamux's "never --force" rule, which guards worktrees whose contents matter; here contents are
   deliberately disposable — fixes round-2 dirty/ignored-remove.)
7. **Record & inject**: append to `.kanban/loop/<base>.jsonl`; update the bounded living
   `.kanban/loop/<base>.md` injected forward. Optional orchestrator-run hook (opt-in
   `config.loop.hooks`): `.kanban/hooks/{before,after}-iteration`, JSON stdin, ≤8KB stdout →
   next prompt, 30s timeout, exit 10 = stop.
8. **Terminate?** Three outcomes, and the `Status: complete` verdict actually GATES the advance
   (fixes round-4 verdict-gating):
   - **SUCCESS**: a KEPT iteration whose child emitted `Status: complete` AND `validationPass` AND
     (`loop.metric` unset OR metric at `loop.target`). → land + advance to critique.
   - **EXHAUSTED**: `n >= loop.maxIterations` or no keep in the last `loop.noImprovementStreak`,
     with a nonempty `bestPatch` but SUCCESS never reached (no `complete`, or metric short of
     target). → land the partial best BUT do NOT advance; stay at implement, notify the user to
     review/continue. Continuing after EXHAUSTED is via `/kanban open` (agent-owned, works on the
     now-dirty tree); re-arming `/kanban implement` on the loop would require committing/stashing
     the landed partial first, since the loop preflight needs a clean tracked tree (round-5 MINOR).
   - **FAILURE**: `bestPatch == ""` (no iteration kept). → land nothing, do NOT advance.
   Plus user abort at any point (no land, stay at implement). Else `n++`.

**On termination — landing (SUCCESS and EXHAUSTED) is detect-and-defer, NOT a hard guarantee**
(fixes round-3/4 landing-safety + atomicity): kanban CANNOT lock the user's git working tree (the
`.kanban/lock` protects only `state.json`, store.ts:197-217), so there is an irreducible TOCTOU.
Landing is made SAFE by detection and per-session-base identity (fixes round-4 marker/global-patch
finding):
- Artifacts are **per base**: `.kanban/loop/<base>.patch` and a `.kanban/loop/<base>.landed`
  marker (`<base>` = workfileBase), never a shared global path — so concurrent/failed runs of
  different sessions cannot overwrite each other.
- Write ordering: (1) write `bestPatch` to `.kanban/loop/<base>.patch` (always recoverable);
  (2) re-check main HEAD `== baseCommit` + clean + token-live; (3) `git -C <mainCwd> apply
  --binary <patch>` (no `--index` ⇒ unstaged; git apply is atomic per invocation — a failed apply
  rolls back, leaving the tree untouched); (4) on apply success, write `.kanban/loop/<base>.landed`
  = `{base, patchSha}` atomically (tmp+rename); (5) the locked mutate advances (SUCCESS only) +
  cleans up.
- **FAILURE / EXHAUSTED-no-advance / apply-FAILS** ⇒ session stays at implement; notify (EXHAUSTED:
  "N iterations, best landed but not marked complete — review/continue via `/kanban open`";
  FAILURE: "none improved; lessons in `.kanban/loop/<base>.md`"; apply-fail: "couldn't land — apply
  `.kanban/loop/<base>.patch` yourself").
- **apply SUCCEEDS but step 5 mutate fails** (lock lost/crash): the changes are in the user's tree
  (the deliverable) and stage stays implement; the `<base>.landed` marker (written at step 4, before
  the mutate) makes a re-run detect the patch already landed and NOT re-apply; recovery is the user
  advancing manually (the loop is no longer live, so `stage_complete(implement)` is allowed).
- **Advance & hand off (SUCCESS only):** the orchestrator's locked commit advances
  implement→critique, then NOTIFIES the user to run `/kanban open`; the EXISTING agent-owned
  critique gate (`completeCritique`, unchanged) runs on the landed working-tree diff
  (`computeDiff`'s `git diff` sees the unstaged landing). EXHAUSTED does NOT advance (stays at
  implement). The loop never auto-runs critique and never archives.
- **Concurrency note:** if another process's agent advances implement→critique concurrently, the
  loop's next `revalidate`/pre-land CAS sees stage≠implement or a token mismatch and stops
  harmlessly (no landing) — the manual advance wins; no corruption. The `stage_complete(implement)`
  refusal (below) is a UX nicety keyed on a LIVE in-memory registry entry, not the durable token.

**`stage_complete(implement)` refusal** (fixes round-2 transition-race): refuse iff a LIVE
in-memory loop run exists for the title (`pipelineRunFor(title)` present) — NOT merely a durable
`pipelineToken` (which is stale after a crash / left by the compose pipeline). A stale token with
no live run ⇒ manual implement advance allowed (the `loop.enabled=false` path is unaffected).

## 5. New seams to build

- **`src/worktree.ts`**: `createDetachedWorktree(cwd, base, path)`, `applyPatch(cwd, patchOrFile,
  {index:false})`, `capturePatch(wtCwd, base)` (tracked `git diff --binary` + untracked
  `ls-files --others --exclude-standard -z` → per-file `git diff --no-index --binary /dev/null` —
  §4.3, no `git add`), `removeWorktreeForce(path)` (+ `git worktree prune` to clear the
  `.git/worktrees/` admin entry), `landPatch(mainCwd, patch)` (`git apply --binary`, no index),
  `sweepOrphanWorktrees(cwd, manifest)`. Plain git via `execFileAsync`; no add/commit/index ever.
- **`src/measure.ts`**: `measure(cwd, loopConfig, signal)` → `{validationPass, tail, metric?,
  metricUnmeasured}`; `spawn("bash",["-c",cmd],{cwd,detached:true})` + `process.kill(-pid)`
  group-kill on timeout/abort; `parseMetric` (regex `^METRIC\s+<name>=<value>$`, last-dup,
  finite-only). Commands are user-configured, opt-in, shell-backed — same trust as the loop hooks.
- **`src/looplog.ts`**: per-base `.kanban/loop/<base>.jsonl` + `.md` + `<base>.patch` +
  `<base>.landed` marker; the worktree manifest with owner PID (§7); `appendLoopLog`,
  `renderLivingSummary`, `deleteLoopArtifacts`.
- **Loop driver** (`src/implementloop.ts`): `driveImplementLoop(ctx, run, config, deps)` reusing
  `runStageChild` extended with `cwd` AND `tools` override params (orchestrator.ts:249 hardcodes
  both today — the loop passes the worktree cwd + `IMPLEMENT_CHILD_TOOLS`) and a FORCED in-process
  runChild, plus `guardedMutate`/`revalidate`/`commitStage`, the abort registry, `resolveModel`,
  and `Status:`-verdict parsing.
- **Config** (`src/config.ts`, 8 touchpoints + `StageModelKey += "implement"`): `loop: { enabled:
  false, validate?: string, metric?: string, metric_name?: string, direction: "higher"|"lower" =
  "higher", target?: number, maxIterations: 10, noImprovementStreak: 3, measureTimeoutMs: 300000,
  hooks: false }`. Model = `models.implement` (no `loop.model`). No aliasing of `config.init.*`.
- **Command**: `/kanban implement` (start), `/kanban implement stop`; progress via `setStatus`.

## 6. Lifecycle, abort, safety

- One loop per process, abort registry under the title; open/rename/remove/pause/session_shutdown
  abort it for free.
- Abort mid-iteration: child `signal` stops the in-process session; the worktree is force-removed;
  `bestPatch` preserved (in memory + `.kanban/loop/<base>.patch` once first kept); no landing.
- Never `git add`/`git commit`/stage (§3). Worktrees under gitignored `.kanban/worktrees/`;
  removed with `--force` (disposable). No loop branches at all (detached worktrees).
- **Cooperative worktree isolation, NOT a sandbox (round-4 CRITICAL, accepted R):** a `cwd` is
  only an initial directory; kanban cannot filesystem-sandbox an in-process agent (neither could a
  subprocess — real FS isolation needs containers/namespaces, out of scope). The implement child
  runs at the SAME filesystem-trust level as today's agent-owned implement, which already has full
  repo access. The worktree gives git-level EXPERIMENT isolation for cooperative iterations (the
  normal case). Dropping `bash` (§4.2) removes the specific escape into `git add`/commit and
  `cd`-out; a child still could, in principle, `edit`/`write` an absolute/`../` path outside the
  worktree — the same latitude today's implement has, and not a new risk. This is a documented,
  accepted trust boundary, consistent with how kanban already trusts its agents.
- Cost: opt-in, explicit start, bounded (`maxIterations` + `noImprovementStreak`), abortable.
  Measurement runs in a worktree (never the user's tree); debris excluded from the captured patch.

## 7. Durable state & progress store (no new Session fields)

- Run identity: `mode:"pipeline"` + `pipelineToken` (existing fields). No breadcrumbs in
  `state.json`.
- `.kanban/loop/<base>.jsonl` (per-iteration records), `.kanban/loop/<base>.md` (living summary
  injected forward), `.kanban/loop/<base>.patch` (the current best, for recoverable landing) +
  `.kanban/loop/<base>.landed` marker (per session base — never a shared global path).
- `.kanban/worktrees/<base>/manifest.json`: active worktree paths + **owner PID + start time**.
  `session_start` sweep removes a worktree only when its owner PID is NOT alive (fixes round-2
  recovery-safety: a second Pi process cannot sweep a live loop's worktrees; worst case a stale
  worktree lingers until its owner dies). All artifacts deleted at success/failure/`/kanban
  remove`; `.kanban/` stays untracked.

## 8. What v1 is superseded by

Removed: the followUp dispatch loop (`agent_settled`/`input`/`before_agent_start`), the `loop`/
`loopToken` arm flag, the transactional archive guard, the disarm matrix, `disarmPending`, the
delivery timer, marker CAS, no-progress fingerprint, dispatch counter. The critique gate is
unchanged. `loop-driver-v1.md` is kept only as the review-history record.

## 9. Test plan (outline)

- Worktree/patch: create detached worktree; `applyPatch` (no index) gives unstaged changes;
  `capturePatch --binary` round-trips (text/binary/rename/delete); `landPatch` lands unstaged into
  a clean main; force-remove of a dirty worktree; NO `git add`/`commit` ever issued (assert on a
  fake git shim).
- Measure: validation pass/fail; `parseMetric` present/absent/last-dup/non-finite;
  `metricUnmeasured`; timeout kills the whole process group (a child `sleep &` is reaped); abort
  signal kills it.
- Decision: keep on pass+improve / pass+no-metric / (metric-only) improve; discard on fail /
  regress / metricUnmeasured; `bestPatch` advances on keep, holds on discard; debris excluded
  (candidate captured before measure); `validationPass≡true` when no validate.
- Termination & outcomes: SUCCESS lands + advances; FAILURE (bestPatch=="") lands nothing, does
  NOT advance, notifies; maxIterations; streak; abort.
- Landing safety: pre-land CAS refuses when main moved/dirtied/token-stale (notifies, writes
  `<base>.patch`); a fake `computeDiff` sees the unstaged landing; `stage_complete(implement)` refused
  only while a LIVE run exists (stale token ⇒ allowed).
- Arming: refused when disabled / no fitness signal / dirty tree / baseline-metric-unmeasurable /
  a second live loop; `loop.enabled=false` falls back to `openImplementConversation`.
- Orchestrator integration: forced in-process runner (fake asserts `spec.cwd===wtPath`, no
  subprocess); abort registry kills it on open/rename/remove/pause/shutdown; mint permits
  implement stage.
- Recovery: manifest sweep removes only dead-owner worktrees; a live-owner manifest is left.
- Config: defaults/precedence/validation; `models.implement`; no init.check aliasing.
- Store: no new Session fields; run uses pipelineToken; breadcrumbs in `.kanban/`.

## 10. Workstreams & review

Review (codex; pi only if usable — CLIs with `< /dev/null` + `perl -e 'alarm N; exec @ARGV'`) →
APPROVE → W0 stubs → W1 config+measure (codex) / W2 worktree+looplog (opus subagent) / W3 loop
driver + orchestrator wiring + stage_complete refusal + mint extension (opus subagent) → W4
coordinator wires `/kanban implement` + setStatus + AGENTS.md/docs, runs typecheck/test/init.sh
--check. Never `git add`/`commit`; end with a suggested commit.

## 10a. Accepted implementation deviations (recorded during W0–W4, 2026-09-02)

The implementation is faithful to §1–§9 except for these four deliberate departures, each found
by the post-implementation adversarial review and accepted rather than "fixed" back:

1. **Artifact retention (§7 vs §6).** §7 says all artifacts are deleted at success/failure; §6
   says an aborted run PRESERVES `bestPatch`. The code follows §6 and generalizes it: artifacts
   are deleted after a SUCCESSFUL advance and at `/kanban remove`/final completion, and KEPT
   after EXHAUSTED, FAILURE and abort — because those three notifications tell the user to read
   `.kanban/loop/<base>.md` or to apply `.kanban/loop/<base>.patch` by hand. Deleting them would
   make the message a lie. §7 should be read as "deleted at success and `/kanban remove`".
2. **Unresolvable implement model fails fast (§2.1/§4.8).** §2.1 lists child-error as a DISCARD.
   The code discards a child error, EXCEPT `errorKind === "model"`, which stops the run with a
   FAILURE naming `models.implement`. A model that does not resolve will not resolve on the next
   iteration either; burning `maxIterations` identical failures produces no lesson and no
   candidate. A partial best already kept is still landed.
3. **`measure` treats a dead metric command as a validation failure (§4.4).** §4.4 defines
   `validationPass = (validate unset) ? true : exit === 0`. The implementation additionally forces
   it false when the METRIC command spawn-errors, times out or is aborted. This is decision-neutral
   (a metric that cannot be measured is already a DISCARD) and strictly conservative: it also
   refuses to keep a candidate whose metric printed a value and then timed out.
4. **The git helpers throw; the loop converts.** `src/worktree.ts` throws when git itself fails
   rather than returning an outcome for every function. The driver converts those throws into a
   clean arming refusal, an iteration DISCARD, or a deferred landing, so no git failure escapes as
   an unhandled error and none of them can advance a stage.

## 11. Revision log

### v2.4 → v2.5 (codex review round 5: 0 CRITICAL + 2 MAJOR)

- MAJOR untracked-`--` (again) → §4.3: removed the `./` prefix (it emitted `a/./…` headers git
  apply rejects); the tested-correct command is `git diff --no-index --binary -- /dev/null <file>`,
  verified end-to-end in a temp repo (subdir + leading-dash + tracked mod all re-apply cleanly).
- MAJOR landing-marker consistency → §7 (and §6/§9): all references are now per-session-base
  `<base>.patch`/`<base>.landed`; no shared global `best.patch` remains.

### v2.3 → v2.4 (codex review round 4: 1 CRITICAL + 3 MAJOR)

- CRITICAL worktree-isolation → §4.2/§6: drop `bash` from the child (no `cd`-out / git escape);
  document cooperative worktree isolation (kanban can't FS-sandbox an in-process agent — same trust
  as today's implement) as accepted R.
- MAJOR untracked-`--` → §4.3: `git diff --no-index --binary -- /dev/null "./<file>"` (`--` + `./`
  guard leading-dash filenames).
- MAJOR verdict-gating → §4.8: three outcomes — SUCCESS (`complete` verdict) advances; EXHAUSTED
  lands the partial but does NOT advance (stays at implement); FAILURE no-land. The verdict now
  actually gates the advance.
- MAJOR landing-marker/identity → §4/§7: per-session-base `.kanban/loop/<base>.patch` +
  `<base>.landed` (atomic tmp+rename, `{base,patchSha}`), defined write ordering; no shared global
  path, so concurrent/failed runs cannot collide or double-apply.

### v2.2 → v2.3 (codex review round 3: 2 CRITICAL + 4 MAJOR)

- CRITICAL untracked-capture → §4.3: `capturePatch` now captures NEW files too (tracked
  `diff --binary` + per-untracked `diff --no-index --binary /dev/null`), still no `git add`.
- CRITICAL baseline-termination → §4 preflight/§4.8: baseline is never success; SUCCESS requires
  the implement child's `Status: complete` verdict, so the loop always implements ≥1 iteration.
- MAJOR tool-plumbing → §4.2/§5: `runStageChild` gains a `tools` override; children get the write set.
- MAJOR command-execution → §4.4/§5: measure uses `spawn("bash",["-c",cmd])` (shell-backed).
- MAJOR pre-land TOCTOU → §4: landing is detect-and-defer (kanban can't lock the user's git tree);
  apply-fail ⇒ don't advance + best.patch + notify.
- MAJOR landing atomicity → §4: post-apply state-write failure degrades to "changes in your tree,
  advance manually"; a `landed` marker prevents double-apply.

### v2.1 → v2.2 (codex review round 2: 2 CRITICAL + 10 MAJOR)

- CRITICAL no-auto-commit/stage → §3/§4: the loop is now COMMIT-FREE and STAGE-FREE (patch-based;
  best-so-far is a `git diff --binary` patch; landing is `git apply --binary` unstaged; no
  `git add`/`commit`/index ever).
- CRITICAL implement-ownership → §3: made an EXPLICIT AGENTS.md:41 change (orchestrator-owned when
  `loop.enabled`, agent-owned otherwise); the advance is an orchestrator locked commit (AGENTS.md:39).
- MAJOR loop-arming → §4: `mintPipelineToken` extended to permit `stage:"implement"`.
- MAJOR implement-transition-race → §4: refusal keyed on a LIVE in-memory run, not a stale durable token.
- MAJOR cancellation/timeout → §4.4/§5: measure runs in a process group, killed as a group on timeout/abort.
- MAJOR worktree-cleanup → §4.6: loop worktrees are disposable scaffolding, removed with `--force`.
- MAJOR baseline-contamination → §4 preflight: baseline measured in a throwaway worktree with the
  full iteration lifecycle (create/measure/force-remove/manifest).
- MAJOR landing-safety → §4: pre-land CAS re-checks main==base, clean, token-live before applying.
- MAJOR recovery-safety → §7: manifest records owner PID; sweep removes only dead-owner worktrees.
- MAJOR runner-selection → §4.2/§5: the loop FORCES the in-process runner, not `selectRunner`.
- MAJOR metric-semantics → §4: `validationPass≡true` when no `loop.validate`; refuse to arm if a
  configured metric's baseline is unmeasurable.
- MAJOR UI-invariant → §3: loop progress via `setStatus`, not a widget row.

### v2 → v2.1 (round 1: 2 CRITICAL + 12 MAJOR) — superseded by v2.2 where noted; see git history.
