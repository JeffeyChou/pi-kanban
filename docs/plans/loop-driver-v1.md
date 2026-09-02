# Kanban loop driver (implement↔critique) — implementation plan v8

Status: REVISED after adversarial review round 7 (subagent: APPROVE; codex: 3 CRITICAL + 1
MINOR — all in the disarm/teardown sequencing, the core transactional guard confirmed sound by
both). v8 hardens deferred-disarm to be genuinely atomic against the platform's async ordering:
(1) when `disarmPending` is set, the `agent_end` handler suppresses EVERY durable clear —
including the abort→STOPPED("interrupted") and guard-chain STOPPED paths — so the arm survives
until `agent_settled` (the loop-off's own `ctx.abort()` no longer defeats the deferral);
(2) loop-off/pause take the "clear immediately" path ONLY when idle AND no `dispatched`/intent/
active delivery timer — a dispatched-but-unstarted continuation forces the deferred path;
(3) the `session_start` sweep NO LONGER clears loop fields — a stale arm is left in place,
keeping the transactional guard conservatively ON (fail-safe) until an explicit disarm, which
removes the cross-process guard-stripping hazard. Prior fixes retained. Revision log §8.
Pending round 8.

## 1. Problem

The v7 orchestrated pipeline (docs/plans/orchestrated-pipeline-v1.md) ends at compose: the
user runs `/kanban open`, and implement/critique are agent-owned in the main conversation.
Finishing a session requires the user to keep nudging the agent — "continue", "run the gate",
"fix the issues" — although every decision is already durable in state.json, the plan
snapshot, and the workfile. v7 named the fix and deferred it (line 39): a pi-goal-style loop
driver. This plan implements it.

## 2. Goals

- G1: A kanban-native loop driver ("loop mode") that, once explicitly armed, automatically
  continues implement each turn until the agent calls `kanban_update stage_complete`, then
  drives the critique gate (run → fix recorded issues → rerun at the cap) until PASS archives
  or a safety stop hands back to the user.
- G2 (**central safety invariant, durably enforced**): while a session is loop-armed
  (`session.loop === "armed"`), `kanban_update` refuses every archive-completing critique
  action — `critiqueSummary`, `acceptRemainingIssues`, and the `config.critique === false`
  skipped-completion — with an instruction to disarm first (§4.5). Because the arm flag is
  durable, this holds for automatic turns, queued-then-drained continuations, and interleaved
  runs alike. The loop therefore can never cause an unconfirmed archive; the worst outcome of
  any ordering race is one extra turn of implement or gate work.
- G3: Double-gated arming: `config.loop.enabled` (default false) AND a per-session explicit
  `/kanban loop` arm. A transient config *parse failure* never counts as "disabled" (§4.8).
- G4: Opt-in per-iteration shell hooks (`config.loop.hooks`, default false)
  `.kanban/hooks/before-iteration` / `after-iteration` (pi-autoresearch contract): JSON stdin,
  stdout ≤ 8 KB steered into the next continuation, 30 s timeout, failures reported but never
  fatal, exit 10 = graceful stop. Hooks are the first execution of ARBITRARY USER-AUTHORED
  shell by the extension (it already spawns fixed/known binaries — `git`, and `piBin` in
  subprocess-runner mode — but `config.init.start` is only rendered as instruction text, never
  executed); they are therefore a deliberate new capability, off by default and opt-in (R7).
- G5: Safety bounded by the **dispatch counter** (not by run classification): every cycle
  requires one dispatched continuation and dispatches are capped, so the loop is finite even
  if classification fails entirely. Interactive input resets the counter (a present human is
  the escape hatch, §4.1/R8).
- G6: No new dependencies; no conversation switching; plan snapshots stay compact; schema
  stays v4 (additive optional Session fields only).
- Out of scope: manual-mode sessions, pi-goal managed-run RPC delegation, driving
  refine..compose, provider-error classification beyond the settled-deferred stop,
  cross-process handover, winning every emit-ordering race (bounded instead by G2/G5).

## 3. Platform facts

Verified against pi-coding-agent 0.84.3 dist (`types.d.ts`, `agent-session.js`, `runner.js`):

- `agent_settled` (types :561, reg :911) fires in `_runAgentPrompt`'s `finally` (:758) AFTER
  `_handlePostAgentRun` (:761-780) exhausts retries + compaction AND after the queued-message
  drain loop `while (await _handlePostAgentRun()) await agent.continue()` (:750-753). So Pi
  may retry or drain a queued followUp AFTER `agent_end` and BEFORE `agent_settled`; a drained
  followUp gets NO second `input`/`before_agent_start` event (:782-784). The loop classifies
  errors and dispatches only at `agent_settled`, and its terminal-action guard is durable so
  it does not depend on a drained turn re-emitting any event.
- Extension `agent_end` = `{ type, messages }` (:566), no top-level stopReason — step 2a scans
  `event.messages` for the final assistant `stopReason`/`errorMessage`.
- `pi.sendUserMessage` is a void wrapper that `.catch()`es rejections into an extension-error
  event (:1945-1952) — no throw to recover; delivery is confirmed by `before_agent_start`
  (the run actually starting) plus a bounded timer (§4.3), and a lost delivery can at worst
  stall the loop (timer → notify), never complete work.
- `prompt()` runs extension commands for any text starting with `/` BEFORE input handlers,
  even for extension sends (:987-995); then awaits `emitInput` (:815-818); `source` is
  `"extension"` for `sendUserMessage` (:1136). `emitInput` short-circuits on the first handler
  returning `{action:"handled"}` (runner.js:945-947). `before_agent_start` (:540, carries
  `prompt`) fires inside `prompt()` when a run actually starts — the authoritative
  delivery/run-start signal (agent-session.js:887).
- `isIdle()` = `!_isAgentRunActive` (:595); `abort()` (:238); `hasPendingMessages()` (:240);
  `ui.setStatus` (:80). `loadConfig` returns `{ config, warnings }` (config.ts:31-35) — the
  loop calls it directly to distinguish a clean disable from a parse failure (§4.8).
- `session_compact` (:455) fires with no subsequent `agent_settled` for manual compaction.
- References: `refs/pi-goal` v0.54.3; installed `pi-autoresearch` v1.7.0 hooks.ts.

## 4. Design

### 4.1 Core principle

Two independent safety nets that do NOT depend on winning any race:
- (a) **Dispatch counter** bounds total automatic continuations regardless of classification.
- (b) **Durable-arm terminal guard** (§4.5) makes the only irreversible action — an archive —
  impossible while armed, regardless of event ordering.

Everything else (epoch, timers, run classification) is best-effort convergence, not a safety
dependency. Pipeline-mode sessions only. One loop per process. The loop lives in the
conversation it was armed in and never switches conversations. The loop's continuation text is
composed by the extension and always begins with a fixed non-`/` prefix, and hook-steered
content is embedded only inside a fenced block, so a continuation can never be parsed as a
slash command (§3, §4.4).

### 4.2 Durable vs ephemeral state

Durable — three additive optional `Session` fields (src/store.ts:31-43; schema v4;
`normalizeState` sanitizes like `mode` at :154 — invalid `loop` drops iteration/token;
`loopIteration` a non-negative safe integer, `loopToken` a non-empty string). Every disarm
deletes all three:

```ts
loop?: "armed";          // per-session arm; the DURABLE terminal-action guard key (§4.5)
loopIteration?: number;  // dispatched continuations, cumulative
loopToken?: string;      // CAS identity of this armed episode
```

Ephemeral — module singleton in `src/loop.ts`:

```ts
interface LoopDriver {
  title: string; token: string; enabledAtArm: boolean; // hooks read LIVE per iteration, not captured
  epoch: number;                     // bumped by interactive input and disarm
  mintTask?: Promise<void>; mintRerequested: boolean;
  intent?: { prompt, marker, iteration, stage, epoch };
  dispatched?: { prompt, marker, iteration };  // in-flight sent prompt, until the run STARTS
  deliveryTimer?; deliveryAttempts: number;
  disarmPending: boolean;            // set by loop-off/pause when not idle; the locked field-clear runs at the next agent_settled (after the queue drains), not at agent_end
  dispatching: boolean;              // single-flight latch; cleared in finally on EVERY exit
  runIsAutomatic: boolean;           // ACCOUNTING ONLY (no-progress/gate-stall/pause-abort); NOT the terminal guard
  runToolAttempted: boolean;
  dispatchCount: number;             // authoritative cap = config.loop.maxTurns
  noProgress: { count, fingerprint? }; gateStall: { attempts, repeats };
  errorPending?: string;
}
```

`runIsAutomatic` is used only for soft accounting and the pause-abort decision; it is NEVER
the terminal-action guard (round 3 proved an in-memory flag cannot cover drained turns). The
terminal guard reads `session.loop` from durable state (§4.5). No ring buffer. Intents,
counters, and fingerprints are never persisted; a restart never revives a loop; re-arm is
explicit. Marker `<!-- kanban-loop:<loopToken>:<iteration>:<uuid> -->` aids legibility;
classification authenticates the FULL prompt text + `source === "extension"`.

### 4.3 State machine

States: `UNARMED → ARMED_IDLE → INTENT → DISPATCHED → RUNNING → STOPPED(cause)`. STOPPED is
transient: cancel timers + discard runtime + one locked mutate deleting the three fields + one
notify + status update → UNARMED. A STOPPED mutate that loses the lock still discards the
runtime; durable cleanup falls to the next boundary's locked mutate or an explicit
`/kanban loop off` (session_start no longer force-clears loop fields — §4.6).

1. **Arm** — `/kanban loop` in the opened conversation. Guards in one `mutateAsync`: a cleanly
   loaded `config.loop.enabled` (a parse-failed config refuses to arm, with a clear message);
   selected session exists, `state === "active"`, `mode === "pipeline"`,
   `stage ∈ {implement, critique}`; if critique, `config.critique !== false` (a disabled gate
   makes completion a human judgment — refuse to arm); no live pipeline run
   (`hasLivePipelineRun()`); no other loop runtime. Mint `loopToken`, set `loop:"armed"`,
   `loopIteration:0`; build runtime (`enabledAtArm=true`, `hooksEnabled=config.loop.hooks`,
   epoch 0). If `ctx.isIdle()`, schedule the mint task.
2. **Mint** — split so hooks never block Pi's lifecycle.

   **2a `agent_end` (fast; extends src/index.ts:669, shares its state load):** **FIRST, if
   `disarmPending` is set, do NOTHING durable and return (round-7 CRITICAL 1)** — discard any
   intent, but perform NO STOPPED transition and NO durable field clear here, because loop-off/
   pause has aborted the run and a queued continuation may still drain via `agent.continue()`
   after this `agent_end`; the arm must stay set until `agent_settled` performs the clear (step
   3). This is why loop-off's `ctx.abort()` (whose `agent_end` carries `stopReason:"aborted"`)
   does not defeat the deferral. Otherwise (no `disarmPending`): snapshot
   `wasAutomatic = driver.runIsAutomatic` and `toolUsed = driver.runToolAttempted`, THEN clear
   `runIsAutomatic` (round 3 c#9 ordering fix — accounting reads the snapshot, not the cleared
   field). Derive final `stopReason`/`errorMessage` from `event.messages`. `stopReason ===
   "aborted"` ⇒ STOPPED("interrupted") (any origin — matches the matrix). `stopReason ===
   "error"` ⇒ set `errorPending`, return (Pi may retry; classified at settled). Else clear
   `errorPending`. No-progress fingerprint updates only when `wasAutomatic && !toolUsed`;
   reaching `noProgressTurns` ⇒ STOPPED("no-progress"). Gate-stall uses `wasAutomatic`+`toolUsed`
   (§4.4). Then the guard chain; on pass, if a mint task is running set `mintRerequested=true`
   and return (drain-safe, round 4 minor: on completion 2b re-checks `mintRerequested` in a
   `while` loop and re-runs only 2a's TAIL — epoch capture + schedule — until the bit is clear,
   so a re-request arriving while the bit is being cleared is not lost;
   `dispatchCount`/no-progress/gate-stall run only at agent_end/commit and are never
   double-counted); else capture `epochAtMint` and schedule 2b.

   **Guard chain** (each step vs fresh durable state; config via a direct
   `loadConfig(ctx.cwd)` call — see §4.8 — wrapped in try/catch so a lock-busy/throwing load
   skips this boundary and retries next, never an unhandled handler exception):
   `loadConfig().readOk === true && config.loop.enabled === false` ⇒ STOPPED("disabled") (a
   hard read/JSON-parse failure of ANY layer sets `readOk=false` and preserves the loop —
   round-5 config finding; §4.8) → token vs `session.loopToken` mismatch ⇒ silent discard →
   session
   missing ⇒ STOPPED("finished") (success wording only for `completion.critique === "pass"`,
   else neutral) → `state !== "active"` ⇒ STOPPED("paused/blocked") → `plan.pendingCompletion`
   ⇒ STOPPED (names `/kanban complete`) → `plan.gateFailure` ⇒ STOPPED (names manual
   `critiqueSummary`) → stage ∉ {implement, critique} ⇒ STOPPED("stage") → critique stage with
   `config.critique === false` ⇒ STOPPED("no-gate") → `dispatchCount >= maxTurns` ⇒
   STOPPED("turn-cap").

   **2b detached mint task** (async, epoch-bound, never in a lock): if the LIVE
   `config.loop.hooks === true` (re-read this boundary, not the arm-time value — round-5 MAJOR
   hook-revocation), run after-iteration then before-iteration hooks + append a loop-log line;
   exit 10 ⇒ STOPPED("hook-stop"). Check `driver.epoch === epochAtMint` and re-run the full
   guard chain.
   Compose the continuation + fresh marker; store `intent`; if `ctx.isIdle() &&
   !ctx.hasPendingMessages()` enter the dispatcher via `setTimeout(0)`. On finish, if
   `mintRerequested`, clear it and re-run 2a's tail. Epoch mismatch ⇒ discard silently.
3. **Dispatch** — `agent_settled` → single dispatcher; `dispatching` latch set synchronously,
   cleared in `finally` on EVERY path. **First, the deferred-disarm clear (round-6 CRITICAL):**
   if `disarmPending` is set, run the locked mutate deleting the three loop fields (the queue is
   now guaranteed drained by `agent_settled`'s contract) + discard the runtime, then return.
   Then **settled error classification**: if
   `errorPending`, re-run the guard chain; if still armed-and-owned ⇒ STOPPED("agent-error");
   if disarmed/paused meanwhile the guard stops with the right cause. Then guards: driver
   exists, not aborted, `intent` exists, `intent.epoch === driver.epoch`, `ctx.isIdle()`,
   `!ctx.hasPendingMessages()` — else return (latch released). Commit: one locked `mutateAsync`
   revalidating (title/active/armed/token/mode/stage === intent.stage/clean-loaded live
   enabled) and writing `loopIteration = intent.iteration`; predicate failure ⇒ drop intent.
   Then, once: `dispatchCount++`; move `intent` into `dispatched = {prompt, marker, iteration}`
   (keep the prompt for delivery confirmation) and clear `intent`; **start the delivery timer**;
   `sendUserMessage(dispatched.prompt, {deliverAs:"followUp"})`. The **commit + counter
   increment happen exactly once here**; the delivery timer's re-send (below) is a bare
   `sendUserMessage` of the same `dispatched.prompt` with NO commit and NO counter change
   (round 3 c#5 fix).
4. **Delivery confirmation & classification** —
   - Delivery is confirmed when the run actually starts: **`before_agent_start` with
     `event.prompt === dispatched.prompt`** ⇒ clear `dispatched`, cancel the timer,
     `runIsAutomatic = true`, `runToolAttempted = false`. This is the authoritative ack
     because it fires only after ALL input handlers ran and the run began (round 3 c#5 fix —
     no premature claim in the input handler).
   - `input` handler **NEVER returns `{action:"handled"}`** (round-5 MAJOR — Pi emits `input`
     before `before_agent_start`, so swallowing the live `dispatched.prompt` here would kill
     the loop's own dispatch before it could be acknowledged). It only does soft accounting and
     always lets the prompt through (`continue`): `source === "interactive"` ⇒ bump `epoch`
     (invalidate the pending mint/intent for this boundary), reset the safety epoch
     (`dispatchCount = 0`, no-progress/gateStall reset); embedded markers in user text are
     inert. Other sources ⇒ neutral. There is NO zombie-suppression-via-handled and no history
     buffer: a resumed-conversation or re-arm zombie continuation simply runs once as harmless
     implement text; the guard chain at its agent_end stops the unarmed loop and the
     transactional archive guard (§4.5) blocks any non-`pass` archive (R6). This trades a
     rare one-turn zombie for never risking the denial-of-message / self-swallow hazards.
   - **Drained-delivery de-dup (round 4 c#5):** if the R5 window queued our followUp behind a
     just-started run, it drains via `agent.continue()` with NO `before_agent_start`, yet a run
     DID consume it. So: on ANY `agent_end` while `dispatched` is still set, treat the delivery
     as consumed — clear `dispatched` and cancel the timer (a run happened; do not re-send).
     The delivery timer therefore only ever fires for a genuinely idle, never-started send.
   - Delivery timer (2 s, bound to token+epoch+marker): on fire, if `dispatched` already
     cleared ⇒ no-op; else ONLY if `ctx.isIdle() && !hasPendingMessages` (agent never became
     busy ⇒ the send truly did not land) bare re-send once (no commit, no counter change); if
     busy ⇒ reschedule (a run may be draining our followUp — the next agent_end clears
     `dispatched`); `deliveryAttempts > 3` ⇒ STOPPED("delivery-failed"). This covers another
     extension's `{action:"handled"}` suppressing the send (no run starts, timer re-sends then
     stops) WITHOUT duplicating a drained-but-delivered continuation (the agent_end de-dup
     above clears `dispatched` first). The bare re-send never increments `dispatchCount`, so
     `maxTurns` still bounds committed dispatches; at most one duplicate continuation of work
     can occur in the narrow race, bounded and non-corrupting.
5. **Compact fallback** — `session_compact`: intent pending ⇒ `setTimeout(0)` into the
   dispatcher. Latch + epoch make a late duplicate settled a no-op.

### 4.4 Continuation prompts (composed in src/loop.ts; src/prompts.ts frozen)

Fixed non-`/` leading text; pi-goal-style trust boundary; marker comment; untrusted blocks
(hook stdout, critique issues) embedded collision-safely: fence = a backtick run one longer
than the longest run in the content (min 4); caps (hook stdout 8 KB, issue block 2 KB); `<!--`
in untrusted content rewritten to `<!- -`. The composed prompt's first character is asserted
non-`/` so it can never be parsed as a command (§3 command-prefix fact).

- **implement**: continue executing the composed spec from authoritative current state; call
  `kanban_update stage_complete` when fully done and validated.
- **critique-run** (`critiqueAttempts ?? 0 === 0`): run the gate now via `stage_complete`.
- **critique-fix** (1 ≤ attempts ≤ CAP): fenced `## critique` issues (read via `readWorkfile`;
  written in the FAIL branch's locked mutate before the tool result returns) + fix then
  re-run; at attempts === CAP add "you MUST pass `rerunCritique: true`".
- **Gate-stall detector**: at an automatic critique agent_end, if `plan.critiqueAttempts`
  equals `gateStall.attempts` AND ≥ CAP AND the turn was tool-FREE (`!toolUsed` — a real fix
  edits) ⇒ `gateStall.repeats++`; any attempt change or a tool-using turn resets `repeats=0`
  and updates `attempts`. Order: compare/update, then `repeats++`, then `repeats >= 2` ⇒
  STOPPED("gate-cap"). A model that makes a token tool call each turn to defeat the tool-free
  check does NOT trip gate-stall but is still bounded by the dispatch cap (slower stop, stated
  explicitly; acceptable per G5). agent_end observing attempts > CAP ⇒ STOPPED("gate-cap").
- Prompts NEVER mention `acceptRemainingIssues`, `critiqueSummary`, or `/kanban complete`.

### 4.5 Terminal-action guard (central safety net — TRANSACTIONAL, in the archive lock)

The guard lives INSIDE `completeSession`'s locked mutate (src/index.ts:569-580), the single
archive predicate, so refusal is atomic with the archive and no check-then-act window exists
(round 4 atomicity finding). One line added to that predicate:

```ts
if (session.loop === "armed" && completion.critique !== "pass")
  throw new Error("loop mode is armed; it cannot auto-complete this session. Run /kanban loop off, then complete it yourself.");
```

Rationale for the `!== "pass"` scope: a gate **PASS** is the loop's own legitimate success
(the gate ran and passed), so it must archive even while armed — that is exactly what the loop
drives toward. Every OTHER completion kind is a human-decision archive and is refused
transactionally while armed: `manual` (critiqueSummary), `accepted-issues`
(acceptRemainingIssues), and `skipped` (`config.critique === false`). Because the check is on
durable `session.loop` evaluated inside the archive lock, it fires regardless of how the turn
reached the tool — automatic, queued-then-drained after its own agent_end, or an interactive
turn interleaved with an automatic run, or a `/kanban loop` that armed the session between an
earlier pre-check and the mutate (round 4 c#7 atomicity; round 3 c#2/c#3/c#7). A friendly
early pre-check in `completeCritique` still returns the same message before doing gate work,
but the LOCKED predicate is the enforcement.

It does NOT touch non-loop sessions (`loop` unset), so the existing headless gate-failure
completion path and its test (test/extension.integration.test.ts:697-712, no loop armed) stay
green. `stage_complete(implement)` and checkpoints need no guard (stage advance is re-enterable
work, not an archive — verified round 3).

**Deferred disarm keeps the guard covering the drain window (round-5 CRITICAL; round-6 fix).**
A queued continuation drains via `agent.continue()` with no `before_agent_start`, so if
`/kanban loop off`/pause cleared the durable `loop` field synchronously, that drained turn
could reach a headless summary/accept archive with the guard no longer armed. Therefore
loop-off and pause DEFER the durable clear. The "clear immediately" fast path is taken ONLY
when `ctx.isIdle()` AND there is no in-flight delivery — i.e. no `driver.dispatched`, no pending
`intent`, and no active delivery timer (round-7 CRITICAL 2: after the dispatcher's void
`sendUserMessage`, the continuation is sent but the run has not started yet, so `isIdle()` is
still true while `_isAgentRunActive` is set only later; clearing then would unguard that
already-sent continuation). Otherwise loop-off/pause `ctx.abort()` the in-flight run, stop all
dispatching, set the runtime `disarmPending` flag + status "stopping", and leave `loop:"armed"`
durable; a `dispatched`-but-unstarted continuation is covered because either it starts (and its
`agent_end`/`agent_settled` run under `disarmPending`) or the delivery timer's
`delivery-failed` path fires at a settled boundary and performs the deferred clear. **The
locked clear then happens at the next `agent_settled`, NOT at `agent_end`** (round-6 CRITICAL,
round-7 CRITICAL 1): Pi emits `agent_end`, then `_handlePostAgentRun`
observes the queued follow-up and calls `agent.continue()` to drain it (agent-session.js:
747-784), so `agent_end` fires BEFORE the drained continuation runs — clearing there would
unguard exactly that continuation. `agent_settled` fires only after the queue is fully drained
and no continuation will run (its contract), so the loop's `agent_settled` handler performs the
locked clear when `disarmPending` is set; if `agent_settled` never arrives (process died), the
stale arm simply remains durable and the guard stays conservatively ON until the user's next
explicit `/kanban loop off` (fail-safe — §4.6 session_start no longer clears it). The
transactional guard (`loop === "armed"`) thus stays in force across the entire drain window —
agent_end AND the drained continuation — so no human-decision archive can commit. An
already-running critique gate child is still left to finish (a passing gate completing is the
desired outcome, allowed by the `!== "pass"` scope). Documented R6.

### 4.6 Disarm matrix

Authoritative guard: `loopToken` CAS + cleanly-loaded enabled at every boundary; the durable
`loop` flag is the terminal guard. The driver does NOT register in the pipeline abort registry.
Rows are title-scoped: the locked mutate clears the TARGET session's three fields; the runtime
+ timers are discarded only when `driver.title === target`.

| Path | Site | Action |
|---|---|---|
| `/kanban pause` | :833-836 | if idle, delete 3 fields; else `ctx.abort()`, stop dispatching, set `disarmPending`, DEFER the field-delete to the next agent_settled (guard stays armed across the drained continuation) |
| rename | :457-465 | delete fields; if driver matches discard runtime + notify |
| remove | :485-491 | delete-by-removal; if driver matches discard runtime silently |
| open/create → `startCleanConversation` | :344 | `disarmActiveLoop(ctx, "conversation-switched")` |
| `session_shutdown` | :660 | `resetLoopRuntime()` (discard runtime + timers; no durable write) |
| `session_start` | :649 | does NOT reconstruct a runtime and does NOT clear durable loop fields (round-7 CRITICAL 3): a stale `loop:"armed"` is LEFT in place (guard stays conservatively ON — fail-safe), cleared only by an explicit disarm; one notify if a stale arm with no runtime is seen, telling the user to `/kanban loop off` to complete manually |
| archive (PASS) / removal | automatic | next agent_end session-missing guard ⇒ STOPPED("finished") |
| config cleanly disables `loop.enabled` | next boundary | STOPPED("disabled") |
| `/kanban loop off` | new verb | operates on DURABLE state, so it clears a stale arm even with NO runtime (crashed-process arm): if no runtime OR (idle AND no `dispatched`/intent/timer) delete 3 fields immediately; else `ctx.abort()` + set `disarmPending` + DEFER the field-delete to the next agent_settled. This is the sole way to clear a stale arm left by §4.6 session_start — so the fail-safe never permanently wedges a session |
| Esc / abort (any origin) | agent_end `stopReason:"aborted"` | STOPPED("interrupted") |
| hook exit 10 | mint task | STOPPED("hook-stop") |
| `/kanban unpause` | — | no auto re-arm |

### 4.7 Hook contract & iteration log

`src/loophooks.ts` ports pi-autoresearch hooks.ts: `.kanban/hooks/before-iteration` /
`after-iteration`, executable check, `spawn("bash",[script],{cwd,timeout:30_000})`, JSON stdin
`{event, cwd, title, stage, iteration, lastTurnSummary(≤2KB), gate:{attempts,lastIssues},
stopReason?}`, stdout 8 KB UTF-8-safe truncation, `steerMessageFor` maps timeout/nonzero(≠10)
to bracketed notices, exit 10 = graceful stop. Hooks run in the detached mint task, never in a
lock, and only when `config.loop.hooks === true` (default false — opt-in, round 3 c#1).

**Trust model (R7) — corrected (round 4 c#1, refined round 5):** this IS a genuinely new
execution surface. The extension does not today execute `config.init.start` — that value is
only rendered as instruction text in the implement kickoff (src/prompts.ts:268). The extension
DOES already spawn child processes, but only fixed/known binaries: `git` (src/index.ts:187)
and, in subprocess-runner mode, the configured `piBin` (src/runner.ts:194). Loop hooks are the
first execution of ARBITRARY USER-AUTHORED shell scripts. This is introduced deliberately and
gated, not smuggled in as "equivalent to existing":
- **Off by default and double opt-in**: `config.loop.hooks` defaults false AND the user must
  place an executable at `.kanban/hooks/…`. Neither installing kanban nor arming a loop runs
  any hook; a repository shipping `hooks:true` + a script still runs nothing until the user's
  own merged config enables it and they arm a loop in that repo. The flag is re-read LIVE each
  iteration (§4.3 step 2b), so setting it back to false stops further hook launches immediately,
  without needing to disarm.
- **Documented as a capability**: AGENTS.md, README, and docs state plainly that enabling
  `config.loop.hooks` lets kanban execute `.kanban/hooks/*` each iteration with full shell
  privileges, and that the script is the user's responsibility (it can, like any script, alter
  the repo). kanban's own writes stay locked + atomic and `normalizeState` sanitizes on read,
  so a hook cannot make kanban's reads observe a torn file, but a hook is not sandboxed.
- **Bounded control channel**: payload on stdin + exit code 10 to stop; 30 s timeout; runs
  outside the lock; failures never fatal.
This is the same, clearly-consented trust boundary as pi-autoresearch's hooks — accepted and
documented, not hidden.

Iteration log `.kanban/loop/<workfileBase>.jsonl`, owned by src/loop.ts; best-effort; deleted
by `completeSession` (:601) and `removeSessionPermanently` (:494); orphans swept at startup.
Plan snapshot and workfile are never written by the loop.

### 4.8 Config (`src/config.ts`, `research` nested pattern)

`loop: { enabled=false, maxTurns=25 (1..200), noProgressTurns=3 (2..20), hooks=false }` — the
8 touchpoints. Additionally, `loadConfig`'s result gains a `readOk: boolean` (true iff no layer
hit the `readLayer` hard-failure catch branches, src/config.ts:262/:274) — a small additive
change consumed by the loop's disable check (§4.3/§4.8); existing `loadConfig` callers ignore
it. `RawConfigSchema` is `additionalProperties:false`, so a missed touchpoint silently drops
the whole config to defaults — config tests MUST round-trip a real `loop` block through
`loadConfig` and assert parsed values, and assert `readOk===false` on a malformed-JSON layer
vs `true` with only unknown-key warnings.

**Failure-provenance policy (round-5 config finding — a structured flag, not warning-coupling
and not warning-blindness):** `loadConfig`'s two hard-failure catch branches in `readLayer`
(src/config.ts:262 "Unable to read config file", :274 "Invalid JSON in config file") already
distinguish a file that could not be read/parsed from unknown/invalid-KEY warnings. v6 surfaces
that distinction structurally: `loadConfig` returns `readOk: boolean` (added to its result),
`true` iff NO layer hit a hard read/JSON-parse failure (global AND repo layers). The loop
boundary calls `loadConfig(ctx.cwd)` directly and disables ONLY when `readOk === true &&
config.loop.enabled === false` — a clean, intentional disable. A hard parse/read failure of
EITHER layer ⇒ `readOk=false` ⇒ the disable check is skipped, the loop keeps running on
`enabledAtArm`, and the warning is surfaced once (honoring G3). Unknown/invalid-KEY warnings
do NOT set `readOk=false`, so they never block honoring `loop.enabled:false` (fixing the v4
over-coupling). Additionally `configCommand`'s write is made atomic (tmp+rename, matching
`writeState`) to shrink the truncation window for the repo layer. A `loadConfig` throw is
caught ⇒ skip this tick, retry next (bounded; the user can `/kanban loop off`).

### 4.9 UX / visibility

`/kanban loop` (arm+start), `/kanban loop off`, `/kanban loop status`; usage + description.
`ctx.ui.setStatus("kanban-loop", …)`: `loop: armed · iter 3 · auto 7/25` / `loop: stopped
(gate-cap)`; cleared on disarm. Widget four-line invariant untouched. Every STOPPED emits one
notify with cause + next action.

### 4.10 Wiring (src/index.ts)

`agent_end` gains the event param → `loopAgentEnd(event, ctx, state)` after the widget refresh.
New registrations: `agent_settled` → `loopAgentSettled(ctx)`; `input` → `loopInput(event, ctx)`;
`before_agent_start` → `loopBeforeAgentStart(event)`; `session_compact` → `loopSessionCompact(ctx)`.
`agent_start` resets `runToolAttempted`; `tool_execution_end` sets it. `completeCritique`'s
first line consults durable `session.loop` (§4.5). `CRITIQUE_ATTEMPT_CAP` moves to src/loop.ts
(index imports it back). Disarm one-liners per §4.6; `/kanban loop` verb after `complete`.

## 5. Test plan

Existing (`test/extension.integration.test.ts`): the 4 `followUps.length === 0` sites become
`assertOnlyLoopFollowUps(harness)`; `context()` gains `hasPendingMessages` and input `source`.
The headless gate-failure completion test (:697-712) is asserted UNCHANGED (no loop armed ⇒
guard silent) — a regression guard for §4.5's scoping.

New `test/loop.test.ts`:
- Arming: refused when disabled / manual mode / wrong stage / live pipeline / second loop /
  critique-with-critique-disabled / parse-failed config; success mints 3 fields; idle arm
  dispatches first continuation.
- **Terminal-action guard (transactional, in the archive lock)**: with `session.loop ===
  "armed"`, `completeSession` refuses to commit `critiqueSummary` (manual), `acceptRemainingIssues`
  (accepted-issues), AND `stage_complete(critique)` under `config.critique === false` (skipped)
  — asserted for hasUI AND headless, and with NO in-memory loop runtime present (proving the
  guard reads durable state inside the lock, covering a drained turn); a gate PASS while armed
  DOES archive (the loop's own success is allowed); an interleaved `/kanban loop` arming the
  session before the archive mutate is refused (atomicity). Non-armed session: existing headless
  summary completion still archives (regression guard for test:697-712).
- Inner loop: one marker followUp per settled boundary; `loopIteration` incremented under the
  lock; repeated `agent_settled` no double dispatch; `isIdle:false`/pending ⇒ no dispatch AND
  latch released; `dispatched` recorded + timer started before send.
- Delivery/classification: `before_agent_start` with the exact (unexpanded, verbatim) prompt
  confirms delivery + cancels timer + sets automatic; the loop sends with
  `expandPromptTemplates:false` so the received prompt equals the sent one (round 4 minor);
  **the input handler NEVER returns `{action:"handled"}`** — assert the loop's own dispatch is
  passed through and confirmed at before_agent_start (regression for the self-swallow); another
  extension returning `{action:"handled"}` ⇒ no before_agent_start, agent never busy ⇒ timer
  re-sends then STOPPED("delivery-failed"); **drained-delivery de-dup**: a followUp queued
  behind a just-started run (agent busy at timer fire) is NOT re-sent, and the intervening
  agent_end clears `dispatched` (no duplicate); interactive input bumps epoch + resets counters.
- Mint stall: manual turn completing while `mintTask` runs sets `mintRerequested` ⇒ re-mint;
  `dispatchCount`/no-progress NOT double-counted.
- errorPending: error at agent_end defers; manual-origin agent_end also clears it; retry-success
  clears it; still-set at settled ⇒ STOPPED("agent-error") only if still armed/owned.
- Outer loop: attempts 0/1/2 prompts; attempts 3 ⇒ gate-cap; gate-stall: two tool-FREE frozen
  critique turns ⇒ gate-cap, but tool-USING frozen turns do NOT trip it; a token-tool-per-turn
  refuser stops via the dispatch cap; `gateFailure`/`pendingCompletion` STOPs name the manual
  exits; ALL followUps regex-free of accept/summary; success wording only for `"pass"`.
- Aborts: Esc on automatic AND manual ⇒ STOPPED("interrupted").
- Disarm matrix: pause/loop-off clear 3 fields immediately ONLY when idle AND no
  `dispatched`/intent/active delivery timer; otherwise abort + set `disarmPending` + defer to
  the next **agent_settled** (NOT agent_end). Key regressions to cover:
  (round-6/round-7-C1) drive loop-off with a queued continuation, fire an ABORTED `agent_end`,
  assert `disarmPending` suppressed the STOPPED clear and `loop` is STILL "armed" (a
  `completeCritique` summary/accept/skipped there is refused); only the subsequent
  `agent_settled` clears the fields.
  (round-7-C2) call loop-off in the window after `sendUserMessage` but before the run starts
  (`dispatched` set, `isIdle()` true) and assert it does NOT clear immediately (defers).
  (round-7-C3) a `session_start` with a stale `loop:"armed"` present does NOT delete it and
  emits the "run /kanban loop off" notify; a second-process start cannot strip a live arm.
  non-driver rename/remove clear fields but keep runtime; driver
  rename/remove discard it; `startCleanConversation` disarms; `readOk && enabled===false` stops
  next boundary; a hard config parse/read failure (`readOk===false`) does NOT stop the loop but
  unknown-key warnings do NOT block a clean disable; live `config.loop.hooks:false` stops
  further hook spawns without disarming; `session_start` leaves a stale arm in place (guard
  stays ON) and notifies rather than clearing it; session_shutdown clears runtime+timers only.
- Safety: dispatch cap binds with classification disabled (boundedness); no-progress stop;
  tool call resets; interactive input resets; **repeated** interactive resets keep a
  no-progress loop alive indefinitely — asserted as accepted-by-design (a present user is the
  escape hatch; documented R8).
- Robustness: session_compact fallback dispatches once; PASS ⇒ finished; STOPPED losing the
  lock still discards the runtime.
- Hooks: opt-in gate (hooks:false ⇒ never spawned); LIVE revocation (flip hooks:false
  mid-loop ⇒ next iteration spawns nothing, without disarming); collision-safe fenced stdout;
  exit 1 ⇒ notice + continue; exit 10 ⇒ hook-stop; log grows/deletes; interactive input during
  the hook window discards the stale intent via epoch.

New `test/loophooks.test.ts`: notFired, stdin payload, 8 KB truncation, timeout, exit-10,
`steerMessageFor`. `test/orchestrator.test.ts`: `hasLivePipelineRun()`.
`test/config.test.ts`: defaults, precedence, invalid warned+ignored, full-file round-trip,
`readOk===false` on a malformed-JSON layer vs `readOk===true` with only unknown-key warnings,
atomic write in `configCommand`. `test/store.test.ts`: 3-field sanitize + round-trip.

## 6. Residual risks (accepted, documented)

- R1: `agent_settled` cadence fully verifiable only in manual Pi testing (contract + emission
  point confirmed in dist). Re-entries + delivery timer cover observed gaps.
- R2: Two Pi processes on one repo: `session_start` no longer clears loop fields (round-7
  CRITICAL 3), so a second process CANNOT strip the first's live arm mid-flight — the
  transactional guard stays in force for the first process's in-flight/queued turn. A stale arm
  from a genuinely crashed process persists (guard conservatively ON) until the user runs
  `/kanban loop off`; that is fail-safe (blocks auto-completion) rather than fail-open. The loop
  still does not resume across processes (no runtime is reconstructed).
- R3: Errors still standing at `agent_settled` stop the loop with the text.
- R4: The v7 "no followUp injection" invariant is REWRITTEN to permit only the armed loop's
  marker-carrying settled-boundary dispatch under the double gate + token CAS; all other paths
  still never inject followUps; updated tests assert exactly that boundary.
- R5: The idle-check-then-send race can queue one continuation that lands after a user turn;
  bounded by G2 (no completion) and reconverged at the next boundary.
- R6: With the transactional archive guard (§4.5) AND deferred disarm (§4.6), NO human-decision
  archive (summary/accept/skipped) can commit while a loop teardown is pending — the durable
  `loop === "armed"` flag is held across the entire queued-continuation drain window and cleared
  only at the next `agent_settled` (NOT `agent_end`; `disarmPending` suppresses every agent_end
  durable clear — round-7). A gate PASS (the loop's own success) is allowed. The only residual
  is a rare zombie continuation (resumed conversation / re-arm with no live `dispatched`) that
  runs one turn of harmless implement text before the guard chain stops the unarmed loop; it
  cannot archive (non-`pass` blocked). Net: never an unconfirmed destructive archive, never
  state corruption.
- R7: Loop hooks are the FIRST extension-spawned arbitrary shell (the extension does not
  execute `config.init.start` — that is only instruction text). Introduced deliberately: off by
  default, double opt-in (`config.loop.hooks` + a user-placed executable), documented as a
  capability with full shell privileges, bounded by the payload + exit-10 channel + 30 s
  timeout. Same consented trust boundary as pi-autoresearch's hooks.
- R8: Another extension can suppress the loop's `input` handler (`{action:"handled"}`),
  misclassifying one turn; repeated interactive resets can keep a no-progress loop alive; both
  are bounded by the dispatch cap and the fact that a present user is the escape hatch.

## 7. Workstreams (disjoint file ownership)

- W0 coordinator: frozen stubs — src/loop.ts export signatures, src/loophooks.ts interface,
  config keys, store field types, `hasLivePipelineRun()`.
- W1 codex (workspace-write): src/config.ts (loop keys + `readOk` in the result + atomic
  `configCommand` write) + test/config.test.ts; src/store.ts fields +
  sanitization + test/store.test.ts.
- W2 opus subagent: src/loop.ts + test/loop.test.ts.
- W3 pi: src/loophooks.ts + test/loophooks.test.ts; AGENTS.md, README.md, docs/architecture.md,
  docs/agent-workflow.md, docs/state-and-artifacts.md, docs/development.md.
- W4 coordinator: src/index.ts wiring (incl. §4.5 TRANSACTIONAL guard line in
  `completeSession`'s locked predicate plus the friendly pre-check in `completeCritique`, and
  the atomic `configCommand` write), src/orchestrator.ts export,
  test/extension.integration.test.ts boundary assertions + headless-regression assertion, full
  validation (`npm run typecheck`, `npm test`, `./init.sh --check`). Never `git add`/`commit`;
  end with a suggested commit.

## 8. Revision log

### v7 → v8 (round-7 findings)

Round 7 split: an independent subagent APPROVED; codex found 3 CRITICAL + 1 MINOR, all in the
disarm/teardown sequencing (both reviewers confirmed the core transactional guard sound). All
three are genuine platform-ordering holes in v7's deferred-disarm and are fixed:
- codex-r7 CRITICAL 1 (abort defeats deferral) → §4.3 step 2a: when `disarmPending` is set, the
  `agent_end` handler does NOTHING durable and returns — no STOPPED("interrupted") from the
  abort, no guard-chain STOPPED — so loop-off's own `ctx.abort()` cannot clear the arm at
  agent_end; the clear is exclusively at `agent_settled`.
- codex-r7 CRITICAL 2 (send-before-run-active race) → §4.5: loop-off/pause take the
  "clear immediately" path ONLY when idle AND no `dispatched`/intent/active delivery timer; a
  dispatched-but-unstarted continuation forces the deferred path (its start runs under
  `disarmPending`, or the delivery-failed path cleans up at a settled boundary).
- codex-r7 CRITICAL 3 (cross-process sweep) → §4.6/R2: `session_start` no longer clears durable
  loop fields; a stale arm is left in place (guard conservatively ON, fail-safe), so a second
  process cannot strip a first process's live in-flight guard; explicit `/kanban loop off`
  clears a genuinely stale arm.
- codex-r7 MINOR (R6 stale "agent_end" wording) → R6 corrected to `agent_settled`.
- Note (subagent APPROVE, retained as verified facts): all 5 archive paths route through
  `completeSession`'s lock; `critique:"pass"` is internally constructed after a real gate pass
  (not agent-forgeable); `agent_settled` is emitted unconditionally in the run loop `finally`
  even on abort (agent-session.js:758), so `disarmPending` reliably clears.

### v6 → v7 (round-6 findings)

codex round 6 returned a single CRITICAL (no other findings) — a precise bug in v6's
deferred-disarm:
- codex-r6 post-disarm terminal guard (CRITICAL) → the deferred arm-clear moves from the next
  `agent_end` to the next `agent_settled`. Pi drains a queued continuation via `agent.continue()`
  AFTER `agent_end` (`_handlePostAgentRun`, agent-session.js:747-784), so clearing `loop` at
  `agent_end` unguards exactly that drained continuation; `agent_settled` fires only after the
  drain completes. Added a `disarmPending` runtime flag; the `agent_settled` handler performs
  the locked clear first (§4.2/§4.3 step 3/§4.5/§4.6). pi round-6 pending.

### v5 → v6 (round-5 findings)

The transactional archive guard (v5) held under review; round-5 findings were concrete, no
architectural change.
- codex-r5 post-disarm terminal guard (CRITICAL) → §4.5/§4.6: loop-off/pause DEFER the durable
  arm-clear to the next agent_end when not idle, so `loop === "armed"` stays true across the
  queued-continuation drain window and the transactional guard blocks any headless
  summary/accept archive there too.
- codex-r5 delivery/zombie self-swallow (MAJOR) → §4.3 step 4: the `input` handler NEVER
  returns `{action:"handled"}` (it would swallow the loop's own dispatch, since `input`
  precedes `before_agent_start`); `before_agent_start` is the sole delivery-ack;
  zombie-suppression-via-handled is removed entirely (a rare zombie runs once as harmless text,
  blocked from archiving by the transactional guard).
- codex-r5 config-disable (MAJOR) → §4.8: `loadConfig` returns a structured `readOk` flag;
  disable only on `readOk && enabled === false`; a hard read/parse failure of any layer
  preserves the loop; unknown-key warnings no longer block a clean disable.
- codex-r5 hook opt-in revocation (MAJOR) → §4.3 step 2b/§4.7: `config.loop.hooks` is re-read
  LIVE each iteration; setting it false stops further hook launches immediately.
- codex-r5 hook-trust doc (MINOR) → G4/§4.7: corrected — the extension already spawns fixed
  binaries (`git`, `piBin`) but NOT `config.init.start` (instruction-only); hooks are the first
  arbitrary-user-shell execution.

### v4 → v5 (round-4 findings)

Root theme: a durable-state PRE-CHECK is still not transactional. Fix: move the guard into the
archive lock.
- codex-r4 terminal-guard atomicity (MAJOR) + codex-r4-c1 skipped escape (CRITICAL) +
  codex-r4-c7-lineage → §4.5 now adds `session.loop === "armed" && completion.critique !== "pass"`
  to `completeSession`'s LOCKED predicate (src/index.ts:569-580) — refusal atomic with the
  archive; allows the loop's own gate-PASS success; blocks summary/accept/skipped
  transactionally regardless of arrival path or an interleaved arm.
- codex-r4-c1 hook isolation (CRITICAL) → R7/§4.7 corrected: hooks ARE a new execution surface
  (the extension does NOT execute init.start); reframed as a deliberately-gated, double-opt-in,
  documented capability rather than "equivalent to existing."
- codex-r4 config-disable semantics (MAJOR) → the "any warning ⇒ skip disable" coupling is
  dropped; `configCommand` writes atomically (tmp+rename) so reads are never torn and the loop
  honors `loop.enabled` plainly (§4.8).
- codex-r4 delivery drained-delivery (MAJOR) → on any agent_end while `dispatched` is set,
  treat the delivery as consumed (clear it, no re-send); the timer re-sends only when the agent
  never became busy; no duplicate committed dispatch, `maxTurns` still bounds commits (§4.3/§4.4).
- codex-r4 gate-PASS cancellation (MAJOR) → a passing gate concurrent with loop-off archiving is
  a legitimate success, not a violation; the transactional guard blocks only non-`pass`
  archives; loop-off leaves a running gate child to finish (§4.5, R6).
- codex-r4 mintRerequested coalescing (MINOR) → drain-safe `while`-loop re-check (§4.3 step 2b).
- codex-r4 delivery-expansion (MINOR) → the loop sends with `expandPromptTemplates:false` (the
  `sendUserMessage` default) and asserts the sent text is used verbatim, so
  `before_agent_start.prompt` equals what was sent; tested (§5).
- pi round 4: re-run pending; findings will be folded before round 5 sign-off if any land.

### v3 → v4 (round-3 findings)

Root cause of 4 CRITICALs: an in-memory run flag cannot guard drained/interleaved automatic
turns. Fix: the terminal-action guard is now DURABLE (`session.loop === "armed"`), §4.5.
- codex-c#7 run-origin ownership (CRITICAL) → durable-arm guard (no in-memory dependency).
- codex-c#3 / pi-c#1 queued terminal guard (CRITICAL) → durable-arm guard covers drained turns.
- codex-c#2 / pi-c#2 disabled-critique completion (CRITICAL) → §4.5 also refuses the
  `config.critique === false` skipped-archive while armed.
- codex-c#1 hook isolation (CRITICAL) → R7 reframed: hooks are user-authored repo scripts under
  the existing init-command trust model; opt-in via `config.loop.hooks` (default false).
- codex/pi headless-completion regression (MAJOR) → the guard is scoped to `loop === "armed"`,
  NOT to `!hasUI`, so the existing headless completion path/test is untouched (§4.5, §5).
- codex-c#5 / pi-c#5 delivery verification (MAJOR) → delivery is confirmed at
  `before_agent_start` (after all input handlers), not claimed in the input handler; a
  suppressed send is caught by the timer → STOPPED("delivery-failed") (§4.4).
- codex-c#8 zombie ownership (MAJOR) → suppression only of the live pre-start `dispatched.prompt`;
  no post-claim comparison, no history buffer (§4.4).
- codex-c#9 accounting ordering (MAJOR) → `wasAutomatic`/`toolUsed` snapshotted before clearing
  `runIsAutomatic` (§4.3 step 2a).
- codex-c#10 / pi config provenance (MAJOR) → the boundary calls `loadConfig` directly and
  disables only on `warnings.length === 0 && enabled === false`; throws caught (§4.8).
- pi gate-stall tool-using refuser (MINOR) → explicit dispatch-cap fallback stated (§4.4).
- pi command-prefix (MINOR) → continuation text pinned non-`/`, hook content fenced (§3, §4.4).
- codex/pi test coverage (MINOR) → durable-guard drained-turn test + repeated-reset soft-loop
  test + headless-regression assertion added (§5).

### v2 → v3 (round-2 findings) — see git history of this file; superseded by v4 where noted.
### v1 → v2 (round-1 findings) — superseded.
