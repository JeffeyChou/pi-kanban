# Kanban orchestrated pipeline — implementation plan v7

Status: REVISED after five adversarial review rounds (round 1: pi 15 + codex 20; round 2:
codex 8 + pi 12; round 3: codex 9 + pi 7; round 4: codex 3 + pi 12; round 5: pi APPROVE
with 8 implementation-time MINORs, codex 3 MAJOR + 1 MINOR — each round confirming the prior
round's fixes as genuine, architecture unchallenged since round 2). Revision logs at the
end.

## 1. Problem (evidence: Pi session 01a05e63, FINCCL repo, 2026-09-01)

1. **Stages are labels, not constraints.** `kickoff()` (src/index.ts:109) injects identical
   boilerplate for all six stages; the agent did all work in `refine` and stages 2–6
   degenerated into re-verification laps.
2. **init nagging.** Every stage kickoff, the completion message, and the handoff template
   hardcode `./init.sh`, even in repos that have none.
3. **Stale kickoff race.** Queued `sendUserMessage(..., followUp)` kickoffs (src/index.ts:483)
   arrive after the state has moved on.
4. **No fast path.**

## 2. Goals

- G1: Each non-implement stage runs in an isolated child session, one responsibility, one
  output section, driven deterministically by extension code.
- G2: Research fans out to parallel child sub-agents.
- G3: Config decides which model each stage / research worker uses (limitation L1 below).
- G4: Self-contained internal child engine + internal user interaction; not exposed as public
  tools; installed external tools (pi-subagents / pi-background-tasks /
  rpiv-ask-user-question) detected and named in the implement kickoff.
- G5: init once at implement start, check once at final completion; configurable,
  auto-detected, never mentioned elsewhere (incl. handoff template and tool guidance).
- G6: All transitions ride in tool results; the followUp kickoff is deleted.
- G7: Fast path — a refine `simple` verdict (with `fastPath: true`) makes the pipeline run
  refine → compose directly, skipping research and grill, with the justification recorded in
  `plan.work.done` and the `## refine` section. (`fastPath: false` ⇒ verdict recorded, no
  skip.) The earlier `skipRemaining` tool parameter is REMOVED from the design: at implement
  the normal finish is already two calls (implement→critique, then the gate), which is the
  fast path; a separate skip flag added contradiction without skipping anything (round-3
  pi#1/codex#3).
- Out of scope: pi-goal loop driver, auto-research loop, remote view, multi-session queues,
  cross-process mid-child abort.

## 3. Platform facts

Verified against pi-coding-agent 0.84.3 dist (both reviewers independently re-verified):
- `createAgentSession`, `SessionManager.inMemory(cwd)`, `getAgentDir`,
  `AgentSession.prompt/abort/dispose/getLastAssistantText`, `DefaultResourceLoader` options
  are all present/root-exported. `DefaultResourceLoaderOptions.agentDir` is REQUIRED and a
  caller-supplied loader is NOT auto-reloaded — the runner constructs it and awaits
  `loader.reload()` itself.
- `AgentSession.prompt()` takes no AbortSignal; the runner bridges `spec.signal` →
  `session.abort()` (listener added/removed; pre-aborted → immediate `{aborted: true}`).
- Omitted `model` in `createAgentSession` means "child settings default", NOT parent model —
  `ChildSpec.model` is REQUIRED and resolved by the orchestrator.
- No cross-extension tool invocation exists (`ToolInfo` has no `execute`). Detection must use
  `getActiveTools()` ∩ known names (a registered-but-disabled tool is not advertised).
- `ExtensionUIContext` (available on both `ExtensionContext.ui` and
  `ExtensionCommandContext.ui`) includes `select/confirm/input/editor/notify/setStatus/
  setWidget` (types.d.ts:68-115). The `Pick<...>`-limited ui is only `ProjectTrustContext`'s.
- Subprocess CLI flags verified: `-p --no-extensions --no-skills --no-context-files
  --no-prompt-templates --no-themes --no-session --provider --model --tools --system-prompt`;
  print mode reads the prompt from stdin, emits only final assistant text, and exits 1 when no
  model resolves.
- **A1 RESOLVED by spike (2026-09-01)**: a live pi extension ran an in-process, extension-free
  child (`DefaultResourceLoader{agentDir, no*} + reload → createAgentSession{model: ctx.model,
  tools:["read"], SessionManager.inMemory}`); the child used the read tool and returned the
  expected text in 2.8 s (scratchpad spike-ext.mjs; parent model object propagated cleanly).
  In-process is the default backend; the subprocess backend remains behind the same interface
  as the escape hatch and for config `runner: "subprocess"`.
- **Known limitation (L1)**: a child runtime (either backend) builds auth/models from
  `~/.pi/agent` files; providers registered dynamically via `pi.registerProvider` may not
  authenticate in a child. Runner classifies this as `errorKind: "model"`; see D5 fallback.
  Documented in troubleshooting.md.
- **Spike addendum (W1 step 0)**: also verify `ctx.ui.confirm` inside a tool `execute` in the
  real TUI (needed by D3's accept path). All such confirms pass
  `ExtensionUIDialogOptions.timeout: 120000`; timeout ⇒ treated as refusal (safe fallback if
  dialog routing mid-turn misbehaves).

## 4. Design

### D1. Session modes

`Session.mode?: "pipeline" | "manual"` — additive optional on schema v4; missing ⇒ `"manual"`
(legacy). New sessions: `"pipeline"`.

- **pipeline**: refine/research/grill/compose are orchestrator-owned (child sessions);
  `stage_complete` during them returns an error result ("run by the Kanban pipeline; use
  /kanban open to resume it"). implement/critique are agent-owned via `kanban_update`.
- **manual**: every stage agent-owned; each `stage_complete` result carries the NEXT stage's
  single-responsibility prompt (same text source, D9). Entered durably (locked, revalidated,
  notify with reason) when: the runner backend is unavailable, a refine/grill/compose child
  fails, or ALL research workers fail. (Critique-child failure has its own path, D3; a
  partial research failure does NOT flip, D2.)

### D2. Stage topology (pipeline mode)

Stage order and `STAGES` unchanged; one state transition per explicit completion event
(agent-owned stages) / per orchestrator commit (child stages, one stage at a time — docs will
state this ownership split explicitly).

| Stage | Owner | Tools | Single responsibility | Output |
| --- | --- | --- | --- | --- |
| refine | child | `read,grep,find,ls` | Goal/scope/constraints/success criteria + `Verdict: simple\|standard` | `## refine` |
| research | N parallel children | `read,grep,find,ls` | One angle each: repo structure & conventions / affected code paths & facts / validation commands & test layout (discovered by READING, never executing) | `## research` (orchestrator-merged; failed workers noted; advances if ≥1 succeeded; ALL failed ⇒ D5) |
| grill | child + orchestrator (D7) | `read,grep,find,ls` | Assumptions/risks; Q&A | `## grill` |
| compose | child | `read,grep,find,ls` | Decision-complete implementation spec | `## compose` |
| implement | main conversation | full (+ detected external tools) | Execute the spec; checkpoints | worktree + plan work summary |
| critique | main-conversation stage; gate child runs inside `stage_complete(critique)` | child: `read,grep,find,ls` + injected diff | Adversarial review vs the spec | `## critique` + gate verdict in tool result |

Critique diff: computed by the tool via node `child_process` (never by the child): `git
status --short` + `git diff` + `git diff --cached` + untracked list (mirrors init.sh's check
scope), bounded to 3000 lines with a `[diff truncated]` note.

### D3. State machine, commit protocol, critique gate

**Run identity and the abort registry.** The orchestrator keeps a module registry
`Map<title, AbortController>` — the abort CHANNEL. The CAS IDENTITY is
`Session.pipelineToken: string` (random; additive optional field). When a pipeline run starts
(`create` or `open` resume), the starter FIRST aborts + unregisters any existing controller
for that title (so `/kanban open` can never leave a duplicate live run burning tokens or
showing stale grill dialogs — grill dialogs also receive the run's signal via
`ExtensionUIDialogOptions.signal` so an abort dismisses them), THEN a locked mutation mints a
fresh token, then the new controller is registered. Registry entries are unregistered when
their run ends (finally). The critique-gate child (D3 below) registers under the same
title-keyed registry for its duration, so `pause`/`remove` abort it too. `pause`, `remove`,
AND `rename` abort via the registry, unregister, and clear the token (renaming a live run
cancels it; `/kanban open` under the new title resumes); `unpause` restarts nothing (a later
`/kanban open` mints a new token). A recreated same-title session can never match a stale
token. Unregistration is always identity-compared (`if (registry.get(title) === mine)
registry.delete(title)`) so a displaced run's `finally` can never delete its successor's
controller (ABA guard). **Process-level exclusivity:** at most ONE live pipeline run per
process — `create`/`open` while a DIFFERENT title's run is live is refused with a notify
("pause it or let it finish first"), which also guarantees at most one pending
`openImplementConversation`.

**Commit protocol (per child stage).** Children ALWAYS run outside the lock. After a child
succeeds, ONE locked `mutateAsync`:
1. Revalidate: session by title exists, `state === "active"`, `mode === "pipeline"`,
   `stage === expected`, `pipelineToken === ours`, and `!signal.aborted`.
2. On success: write the workfile section (inside the lock, same protected pattern as
   existing checkpoint artifact writes) and advance exactly one stage.
3. On mismatch: commit nothing; notify; stop the pipeline. (A late child after
   pause/remove/rename commits nothing and writes nothing — no orphan workfile.)
Between stages the orchestrator reloads state; `blocked`/missing ⇒ stop (cross-process pause
takes effect at stage boundaries; documented limitation).

**Implement.** The compose commit advances to implement inside its locked mutation, and the
pipeline ENDS there: the orchestrator never switches conversations itself (Pi 0.84.3 gives an
extension no way to inspect or reserve the TUI's separate `pendingUserInputs` queue, so any
auto-switch after a minutes-long pipeline can destroy a message the user just submitted). It
notifies "pipeline composed the spec — run /kanban open (or press Enter on the session in
/kanban) to start implementation" and updates the widget. The conversation switch happens
only on the USER-initiated `/kanban open` / dashboard Enter, which calls
`deps.openImplementConversation` (a wrapper around the existing `startCleanConversation`),
seeded with handoff + plan + `## compose` spec + ONE implement kickoff (init-start if
configured; external tools line). Cancelled ⇒ session stays at implement. This also removes
any orchestrator-after-newSession ctx-staleness hazard (the orchestrator's tail never
outlives its own conversation). In MANUAL mode, every path that ENTERS implement (a `stage_complete` result advancing
compose→implement, or `/kanban open` at implement) delivers `implementKickoff` — not a bare
stage prompt — so G5's init-start and G4's external-tools line survive the fallback.

**`stage_complete(implement)`** → single transition implement→critique; result: "Critique
gate armed — call kanban_update stage_complete to run the adversarial critique."

**Blocked-state guard (all agent-owned paths).** Every `kanban_update` mutation (checkpoint,
every stage_complete variant, the gate-token mint) and `/kanban complete` includes
`state === "active"` and the expected stage in its locked predicate — a paused session
refuses to advance, arm/run a gate, or archive, with a clear error result.

**`stage_complete(critique)` — pipeline mode.** The tool FIRST mints a fresh gate token in a
locked mutation (`pipelineToken = random` — the gate's own CAS generation, so a
pause/unpause at implement can never let a stale cross-process gate commit; the mint
predicate includes `stage === "critique"` and `state === "active"`), then computes
the diff, then calls the W2-owned `runCritiqueGate(ctx, session, deps)` (D12) — which
resolves `models.critique` itself, registers the child's controller in the title-keyed
registry for its duration, runs it lock-free with the tool `signal` bridged and `onStatus` →
tool `onUpdate`, and parses the gate (D9: `Gate: PASS|FAIL` + `- ` issue bullets; unparseable
⇒ FAIL with issue "unparseable critique output"). All post-gate locked mutations revalidate
the gate token. Then, in the tool:
- PASS → locked revalidated mutation: existing completion path (archive plan complete with
  `plan.completion = { critique: "pass" }`, remove session, idle handoff), delete the
  workfile; result carries final text + init-check command (if configured) + suggested
  commit. (Workfile delete after the mutation; a crash in between leaves an orphan — swept by
  the startup cleanup below.)
- FAIL → stage stays critique; `plan.critiqueAttempts++` (locked); the W4 tool writes the
  `## critique` section from `GateOutcome.body` in the same locked mutation; result lists
  the issues; the agent fixes and calls again.
- ABORTED (`GateOutcome.kind === "aborted"` — pause/Esc during the gate) → nothing committed;
  result: "critique gate aborted; call stage_complete to re-run."
- Passing both `rerunCritique: true` and `acceptRemainingIssues: true` in one call ⇒ error
  result (mutually exclusive).
- **Attempts cap (enforced):** once `critiqueAttempts >= 2`, a plain `stage_complete` does
  NOT re-run the child; the result states the cap and requires exactly one of:
  `rerunCritique: true` (explicit re-run, attempts keep counting) or
  `acceptRemainingIssues: true`. The accept path: when `hasUI`, `ctx.ui.confirm` (120 s
  timeout ⇒ refusal; on refusal/timeout the tool writes `plan.pendingCompletion = { critique:
  "accepted-issues", note: <bounded issue list> }` in a locked mutation and points the user
  at `/kanban complete`, D10); HEADLESS it is allowed and completes — unattended runs cannot
  confirm — with the issues recorded durably. Both accept variants complete with
  `plan.completion = { critique: "accepted-issues", note: <bounded issue list> }`. A later
  successful PASS or an explicit `rerunCritique` clears `pendingCompletion`.
- Critique CHILD failure (spawn/model/other) does NOT loop, does NOT flip the session to
  manual, and does NOT silently archive: the tool records `plan.gateFailure = { errorKind,
  error? }` in a locked mutation, and the result reports the failure and offers ONLY the
  manual-critique completion below. In PIPELINE mode the `critiqueSummary` path is
  AUTHORIZED only while `plan.gateFailure` exists (durable, restart-safe — a healthy gate
  cannot be bypassed by simply supplying a summary). While `gateFailure` exists: a plain
  `stage_complete(critique)` RETRIES the gate child (success clears `gateFailure`);
  `acceptRemainingIssues` is NOT available (no gate ever produced an issues list) — the
  manual `critiqueSummary` path is the only completion. A gate child that finishes after its
  token was cleared (pause won the race) commits nothing; result: "critique gate finished
  but the session was paused; nothing was recorded — re-run after unpausing."

**`stage_complete(critique)` — manual mode (and pipeline-mode child-failure path).** No child
runs. The call requires `critiqueSummary: string` (what was reviewed, verdict, remaining
issues) — missing ⇒ error result carrying the critique-stage prompt. With a summary: when
`hasUI`, `ctx.ui.confirm("Complete <title>? Critique gate was manual.")` gates completion
(timeout/refusal ⇒ the tool writes `plan.pendingCompletion = { critique: "manual", note:
<critiqueSummary, bounded> }` and points at `/kanban complete`); headless completes. Either
way the summary is recorded durably as `plan.completion = { critique: "manual", note:
<critiqueSummary, bounded> }` — the workfile is deleted at completion, so the plan's bounded
`completion` record is the durable trail (see D10 invariant amendment). With config
`critique: false`, `stage_complete(critique)` completes without any gate and records
`plan.completion = { critique: "skipped" }`.

**`/kanban complete` (command).** Valid ONLY when the selected session is at critique AND
`plan.pendingCompletion` exists (i.e., a tool path has directed the user here); otherwise a
notify explains. It shows `ctx.ui.confirm` in command context and, on confirm, performs the
same locked completion, converting `pendingCompletion` into `completion`. No free-form
inputs — the durable pending record is its only authority and note source.

**Startup sweep.** `session_start` initialization deletes `.kanban/work/*.md` files whose
base matches no session in state — ANY state, active or blocked (a paused session keeps its
workfile). Idempotent.

**Small decisions pinned (round-5 pi MINORs):** `acceptRemainingIssues` before the cap
(attempts < 2) is REFUSED with "fix or re-run the gate first"; subprocess `errorKind`
mapping: spawn error (ENOENT etc.) ⇒ "spawn", exit ≠ 0 with stderr/stdout naming
model/provider resolution ⇒ "model", any other non-zero exit ⇒ "other"; the in-memory-only
nature of `mode` sanitization matches existing v4 normalize behavior (persisted on the next
ordinary mutation) and is acceptable.

### D4. Workfile

`.kanban/work/<base>.md`, where `base` = plan basename without directory/extension
(`plans/2026-09-01-title.json` → `2026-09-01-title`). New artifact class documented in
state-and-artifacts.md (plans keep their compact contract untouched).

- Sole writer: orchestrator / the critique tool, always inside the locked commit (D3).
- One `## <stage>` section per stage, each capped at 300 lines at write time (truncated with
  a note).
- **Resume authority is `state.json`'s stage ONLY.** Sections are prompt inputs. `/kanban
  open` on a child-run stage re-runs the CURRENT stage (a stale section for it is
  overwritten). At implement/critique, `/kanban open` opens the conversation; a missing
  workfile there is tolerated: the seed notes "spec unavailable" and the agent proceeds from
  the plan JSON.
- Lifecycle: created on first section write; deleted at completion and `/kanban remove`;
  never created by migration; orphans swept at startup (D3).

### D5. Manual fallback

Trigger set (exact): runner unavailable; refine/grill/compose child failure; ALL research
workers failed. Effect: durable flip to `mode: "manual"` (locked, revalidated) + notify with
`errorKind` and model name. `/kanban open` then seeds the main conversation with handoff +
plan + existing workfile sections + the CURRENT stage's prompt; every subsequent
`stage_complete` result carries the next stage's prompt. Critique gate in manual mode: D3
manual path (summary + human confirm). No followUp injection anywhere.

### D6. Capability detection

`src/capabilities.ts`: `detectExternalTools(pi: ExtensionAPI): string[]` — intersection of
`pi.getActiveTools()` with `subagent`, `ask_user_question`, plus active tools whose
`getAllTools().sourceInfo` resolves to the `pi-background-tasks` package. Used only for one
line in the implement kickoff. No config overrides, no suppression logic.

### D7. Grill user interaction (internal)

Grill child output: answered Q&A + open questions as `Q:` / `Recommended:` line pairs (D9).
Orchestrator walks open questions via `ctx.ui.select(question, [recommended, "Answer
differently…", "Skip (record assumption)"])` + `ctx.ui.input`. `hasUI === false` ⇒
auto-accept recommendations recorded as `ASSUMED:`. All Q&A land in `## grill`. Unparseable ⇒
no questions, body kept, warning notify.

### D8. Child-session engine (`src/runner.ts`) — frozen

```ts
export type ErrorKind = "spawn" | "model" | "aborted" | "other";
export interface ChildResult {
  text: string;                      // "" on failure
  aborted: boolean;
  errorKind?: ErrorKind;
  error?: string;
}
export interface ChildSpec {
  cwd: string;
  agentDir?: string;                 // default getAgentDir()
  prompt: string;                    // delivered via prompt() / stdin — never argv
  systemPrompt: string;              // short; per-stage
  model: Model<any>;                 // REQUIRED — resolved by the caller
  tools: string[];
  signal: AbortSignal;
  onStatus?: (line: string) => void;
}
export type RunChild = (spec: ChildSpec) => Promise<ChildResult>;
export function createInProcessRunner(): RunChild;
export function createSubprocessRunner(): RunChild;
export function selectRunner(config: KanbanConfig): RunChild;
```

In-process backend: exactly the spike recipe (§3), plus failure detection: after `prompt()`
resolves, the runner inspects the last assistant message — pi's agent loop swallows
exhausted-retry model errors into a final message with `stopReason: "error"` — and maps that
to `errorKind: "model"` with the error text instead of returning garbage as `text` (this is
what makes the D5 manual-flip trigger actually fire on mid-stream failures). Subprocess
backend: the binary resolves to config `piBin` (default `"pi"`, PATH lookup); `pi -p
--no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes
--no-session --provider <model.provider> --model <model.id> --tools <t1,t2,...>
--system-prompt <literal text>` with the STAGE PROMPT written to stdin (never argv —
ARG_MAX); both backends therefore deliver the same environment and honor the required model
(print mode exits 1 if the model cannot resolve → `errorKind: "model"`). Errors are returned,
never thrown. Model resolution lives in the ORCHESTRATOR: config `"provider:model-id"` →
`ctx.modelRegistry` lookup; unset → `ctx.model`; failures ⇒ D5/D3 fallback (L1).

Callers wire `onStatus`: pipeline → `ctx.ui.setStatus("kanban", line)` (ExtensionUIContext,
verified §3); critique tool → its `onUpdate`.

### D9. Prompts and output grammar (`src/prompts.ts`) — frozen

```ts
export interface StageInputs {
  prompt: string;                              // original session prompt (plan.prompt)
  title: string;
  sections: Partial<Record<Stage, string>>;    // prior workfile sections
  researchAngle?: 1 | 2 | 3;                   // research workers only
  grillAnswers?: string;                       // orchestrator-collected Q&A (compose input)
  diff?: string;                               // critique only (tool-computed, bounded)
}
export function stagePrompt(stage: Stage, inputs: StageInputs): string;
export function stageSystemPrompt(stage: Stage): string;
export interface ParsedStageOutput {
  body: string;                              // after the LAST `## <stage>` line; whole text if absent (warn)
  verdict?: "simple" | "standard";           // refine only; default "standard"
  questions?: Array<{ q: string; recommended: string }>;  // grill only
  gate?: "pass" | "fail";                    // critique only; missing/unparseable ⇒ "fail"
  issues?: string[];                         // critique FAIL bullets; empty ⇒ ["critique produced no parseable issues"]
}
export function parseStageOutput(stage: Stage, text: string): ParsedStageOutput;
export function implementKickoff(config: KanbanConfig, externalTools: string[], spec: string | undefined): string;
export function completionText(config: KanbanConfig, plan: PlanSnapshot): string;
```

Critique child contract (in its prompt): end with `## critique`, first line `Gate: PASS` or
`Gate: FAIL`, then `- ` bullets for each issue. Common stage frame: "You are executing
exactly the <stage> stage… Do NOT do later stages' work…". Tests assert stage naming,
later-stage prohibition, "init" absent from all stage prompts (only implementKickoff /
completionText may carry the configured commands).

### D10. Changes to existing files (ownership)

- `src/store.ts` (**W0** — moved up so every workstream typechecks against the final
  `Session` type from minute one): additive `mode?`, `pipelineToken?` on Session;
  `normalizeState` preserves them and strips a `mode` value outside
  {"pipeline","manual"} (unknown ⇒ absent ⇒ manual, the safe default); migrations untouched.
- `src/artifacts.ts` (W1): `buildHandoff`/`buildIdleHandoff` take optional init config and
  render the init rule only when configured; PlanSnapshot additive optional `complexity?`,
  `critiqueAttempts?`, `completion?: { critique: "pass" | "accepted-issues" | "manual" |
  "skipped"; note?: string }`, `pendingCompletion?: { critique: "accepted-issues" |
  "manual"; note: string }`, and `gateFailure?: { errorKind: string; error?: string }`, with
  every `note` bounded to 10 lines (truncated). **Invariant amendment
  (docs, W3):** plans remain compact and still never accumulate progressive review/evidence
  archives; the single bounded `completion` record at archive time is the one sanctioned
  exception (AGENTS.md and state-and-artifacts.md say so explicitly).
- `src/index.ts` (W4): delete `kickoff()` + followUp; `/kanban open [title]` (no arg ⇒
  selected; blocked ⇒ notify; dashboard Enter routes here); `create|open` → orchestrator;
  `/kanban config` (ui.editor → `.kanban/config.json`); `/kanban complete` per D3 (gated by
  `plan.pendingCompletion`); `pause`/`remove`/`rename` abort via the orchestrator registry
  and clear `pipelineToken` before mutating; `kanban_update` per D3 (params:
  `rerunCritique?`, `acceptRemainingIssues?`, `critiqueSummary?`; the two booleans are
  mutually exclusive); `promptGuidelines` drop hardcoded init text;
  `removeSessionPermanently` deletes the workfile too; startup sweep (D3).
- `src/ui.ts` (W4): widget shows running pipeline children (from `session.agents`, maintained
  via existing `replaceAgents`).
- `init.sh` (W4): mention the workfile in the start report; `--check` otherwise unchanged.
- Docs (W3): AGENTS.md (kanban now RUNS internal child sessions; mode/pipelineToken fields;
  workfile artifact; init config; stage ownership split), architecture.md (ownership table,
  lock/commit protocol), agent-workflow.md (owner column, manual mode, critique gate, fixes
  allowed during critique), README (config, /kanban open, /kanban config, L1 + stage-boundary
  pause limitation), state-and-artifacts.md (workfile contract, new plan fields),
  troubleshooting.md (child failures, model auth, runner backends).

### D11. Config (`src/config.ts`) — frozen shape

```jsonc
{
  "models": { "refine": null, "research": null, "grill": null, "compose": null,
              "critique": null },           // "provider:model-id" | null → parent model
  "research": { "workers": 3 },             // 1–3 (one per defined angle; 1 or 2 run the first angles only)
  "fastPath": true,
  "critique": true,                          // false ⇒ stage_complete(critique) completes
                                             // without running the gate child (own explicit call)
  "runner": "auto",                          // auto | inprocess | subprocess
  "piBin": "pi",                             // subprocess backend binary (PATH lookup)
  "init": { "start": "auto", "check": "auto" } // "auto": ./init.sh (+ --check) iff executable
                                               // ./init.sh exists; string verbatim; null disables
}
```
Precedence: defaults ← `~/.pi/agent/extensions/kanban.json` ← `<repo>/.kanban/config.json`.
Typebox-validated; unknown keys ⇒ warning, ignored.
`export function loadConfig(cwd: string, agentDir?: string): Promise<KanbanConfig>` (merged,
validated); `export interface KanbanConfig` mirrors the JSON with all fields required after
merge.

### D12. Frozen cross-workstream seams (complete list)

D8 (runner), D9 (prompts/grammar), D11 (config), D6
(`detectExternalTools(pi): string[]`), workfile API:

```ts
export interface Workfile { sections: Partial<Record<Stage, string>> }
export function workfileBase(planPath: string): string;               // "plans/x.json" → "x"
export function workfilePath(cwd: string, base: string): string;      // .kanban/work/<base>.md
export function readWorkfile(cwd: string, base: string): Promise<Workfile>;   // missing → {sections:{}}
export function writeWorkfileSection(cwd: string, base: string, stage: Stage, body: string): Promise<void>;
  // atomic read-modify-replace of ONE section, others preserved; 300-line cap applied here.
  // `body` NEVER includes the heading — this function owns the `## <stage>` heading lines,
  // and readWorkfile returns bodies without them (pins the layout for W1/W2 alike).
export function deleteWorkfile(cwd: string, base: string): Promise<void>;     // idempotent
```

Orchestrator seam (frozen, resolves the W2/W4 boundary):

```ts
export interface OrchestratorDeps {
  runChild: RunChild;
  config: KanbanConfig;
  // W4 wraps startCleanConversation. v6: the ORCHESTRATOR NEVER CALLS THIS — the pipeline
  // ends at the compose commit with a notify; W4's user-initiated /kanban open / dashboard
  // Enter path is the only caller. It stays in deps so tests can assert it is NOT called.
  openImplementConversation: (session: Session, spec: string | undefined) => Promise<{ cancelled: boolean }>;
}
// FIRE-AND-FORGET: the command handler calls startPipeline and returns immediately after
// the run is registered (pi awaits command handlers inline in the agent loop — an awaited
// pipeline would park the main turn for minutes). The detached run notifies on failure.
export function startPipeline(ctx: ExtensionCommandContext, title: string, deps: OrchestratorDeps): Promise<void>;
export function abortPipelineFor(title: string): boolean;  // aborts + unregisters; used by pause/remove/rename/open (open at ANY stage aborts first)
export function clearPipelineRegistry(): void;             // W4 calls on session_shutdown/reload — orphaned children then stop at their next token revalidation

export interface CritiqueGateDeps {
  runChild: RunChild;
  config: KanbanConfig;
  diff: string;
  signal: AbortSignal;                  // the tool's execute signal — bridged into the gate child
  onUpdate?: (line: string) => void;    // the tool's onUpdate — streams gate progress
}
export interface GateOutcome {
  kind: "pass" | "fail" | "child-failed" | "aborted";
  issues: string[];
  body: string;      // parsed `## critique` body — the W4 tool records it as the workfile section
  errorKind?: ErrorKind;  // set when kind === "child-failed" — the tool persists it into plan.gateFailure
  error?: string;
}
// Owned by W2 (orchestrator.ts); resolves models.critique itself; registers the child in the
// title-keyed registry; runs lock-free. The W4 tool computes the diff, calls this, and owns
// the state mutations that follow.
export function runCritiqueGate(ctx: ExtensionContext, session: Session, deps: CritiqueGateDeps): Promise<GateOutcome>;
```

**W0 (coordinator, before W1–W3 launch): commit compilable interface stub files** —
`src/runner.ts`, `src/prompts.ts`, `src/config.ts`, `src/capabilities.ts`, `src/workfile.ts`,
`src/orchestrator.ts` containing the frozen types/signatures with `throw new
Error("unimplemented")` bodies — PLUS the `src/store.ts` additive `Session` fields
(`mode?`, `pipelineToken?`, with normalize validation) — so all workstreams typecheck
against identical seams and the final `Session` type from minute one.

### D13. What does NOT change

Schema v4 + migrations, lock implementation, handoff 200-line cap, pause/unpause/rename
semantics (plus pipeline-abort side effect), dashboard, title generation, "never git commit",
`.kanban/` untracked.

## 5. Test plan

- runner: options mapping (agentDir default, loader flags + reload, inMemory, tools, model
  passthrough); pre-aborted signal; abort mid-run; error classification; subprocess arg
  construction incl. `--provider/--model` + stdin prompt (command-builder unit test, no real
  spawn); backend parity of flag sets.
- orchestrator (fake RunChild + fake ui): happy path (4 sections, one stage per commit,
  revalidation predicates incl. pipelineToken and signal.aborted); fast path; grill Q&A hasUI
  true/false + unparseable; research merge with one failed worker (advances) and ALL failed
  (manual flip); non-research child failure ⇒ durable manual flip + notify; pause during a
  live child aborts, token cleared, resumable; rename/remove mid-pipeline ⇒ commit dropped,
  nothing written (incl. no workfile resurrection); late child after abort commits nothing;
  stale-token commit rejected after unpause + new open; **open-during-live-run aborts and
  unregisters the old controller before minting the new token (no duplicate pipeline; grill
  dialog receives the abort signal)**; registry entry removed when a run ends; fast path:
  simple verdict + fastPath:true skips research/grill (recorded), fastPath:false does not
  skip; mid-pipeline open re-runs current stage and overwrites stale section; lock never held
  during a child (fake runner asserts `.kanban/lock` absent); startup sweep removes orphaned
  workfiles; pause during a running critique gate aborts the gate child (registry);
  **v5 mechanics:** identity-compared unregistration survives the open-while-live ABA
  interleaving; starting a second pipeline under a different title is refused; the
  orchestrator never calls openImplementConversation (asserted via the deps fake) and ends
  the pipeline with the /kanban open notify;
  rename aborts a live run; blocked session refuses checkpoint/stage_complete/gate mint//kanban complete.
- tool: implement→critique single transition; gate PASS→archive+workfile deleted+
  `completion.critique === "pass"`; FAIL→attempts++, issues in result; unparseable gate ⇒
  FAIL; cap enforced (attempts ≥ 2 ⇒ plain call does NOT re-run the child; requires
  rerunCritique or acceptRemainingIssues); accept with hasUI requires ui.confirm (timeout ⇒
  refusal + `/kanban complete` pointer), headless accept completes with durable
  `completion.note`; critique-child failure offers manual path only (no manual flip, no
  archive); manual-mode critique requires critiqueSummary (+ confirm when hasUI) and records
  `completion.critique === "manual"`; manual transition INTO implement delivers
  implementKickoff (init + external tools present); critique:false path; stage_complete
  rejected in pipeline child stages / accepted in manual with next-stage prompt; no
  `sendUserMessage` from the tool (harness assertion); **v5:** gate-token mint before the
  child + stale-gate commit rejection after pause/unpause; GateOutcome.body written as the
  `## critique` section; aborted gate commits nothing with the specified result text;
  rerunCritique+acceptRemainingIssues together ⇒ error; confirm refusal/timeout writes
  `pendingCompletion` and `/kanban complete` (gated on it, no free inputs) converts it;
  PASS/rerunCritique clears `pendingCompletion` AND `gateFailure`; gate child failure writes `gateFailure` and only then authorizes pipeline-mode critiqueSummary; early accept (attempts<2) refused; critique:false records
  `completion.critique === "skipped"`.
- prompts: D9 grammar incl. critique Gate parsing + fallbacks; init placement.
- config: precedence, validation, auto init detection, model string resolution fallback.
- capabilities: active∩known; disabled tool not advertised; bg-tasks source match.
- workfile: base derivation, section replace preserves others, cap, missing-file reads,
  idempotent delete.
- integration test updates per above; store/migration tests untouched; mode/pipelineToken
  normalization.

## 6. Residual risks (accepted, documented)

- R2: multi-minute critique inside a tool call — onUpdate streaming + signal bridge; user
  input during the gate queues per normal Pi behavior.
- R3: research parallelism vs rate limits — `workers` config, partial-failure notes.
- R4: no per-child turn cap — abort via pause; documented.
- L1: extension-registered providers may not auth in children — fallback + notify.
- Cross-process pause at stage boundaries only; `ui.confirm`-inside-tool routing is
  spike-verified in W1 step 0 with a timeout refusal fallback either way.

## 7. Workstreams

- **W0 (coordinator)**: interface stubs (D12).
- **W1 (codex)**: commit `scripts/spike-child.mjs` (the verified A1 spike, so the evidence
  lives in-repo) and `scripts/spike-confirm.mjs` (ui.confirm-in-tool check), `src/runner.ts`
  (both backends), `src/config.ts`, `src/capabilities.ts`, `src/workfile.ts`,
  `src/artifacts.ts` edits, unit tests for each.
- **W2 (opus subagent)**: `src/orchestrator.ts`, `src/prompts.ts` + tests (fake RunChild,
  fake ui). New files only (over the W0 stubs).
- **W3 (pi)**: all doc updates (D10) + `test/extension.integration.test.ts` expectations.
- **W4 (coordinator, after W1+W2)**: `src/store.ts`, `src/index.ts`, `src/ui.ts`, `init.sh`,
  merge, `npm run typecheck`, `npm test`, `./init.sh --check`.

## 8. Revision log v6 → v7 (codex round-6 findings)

- codex#1 (GateOutcome lacked the failure classification) → GateOutcome gains
  `errorKind?`/`error?` for kind "child-failed"; the W4 tool persists them into
  `plan.gateFailure`.
- codex#2 (workers 4–5 had no defined angles) → `research.workers` capped at 1–3, one per
  defined angle in order.
- codex#3 (stale auto-switch remnants) → D12 comment and the §5 test bullet rewritten: the
  orchestrator never calls openImplementConversation (tests assert it), pipeline ends with
  the /kanban open notify.

## 9. Revision log v5 → v6 (round-5 findings; pi round-5 was APPROVE)

- codex#1 (manual-critique authorization not durable) → `plan.gateFailure` written on gate
  child failure; pipeline-mode `critiqueSummary` path authorized only while it exists;
  cleared by a successful gate run.
- codex#2 (blocked state not enforced on agent-owned paths) → blocked-state guard: every
  kanban_update mutation, the gate-token mint, and `/kanban complete` include
  `state === "active"` (+ expected stage) in their locked predicates; tests added.
- codex#3 (switch guard cannot see the TUI input queue — verified API limitation) →
  auto-switch REMOVED: the pipeline ends at the compose commit with a notify; the
  conversation switch happens only on user-initiated `/kanban open` / dashboard Enter. Also
  dissolves pi round-5 #2 (ctx staleness after newSession).
- codex#4 (mode sanitization not persisted at init) → accepted as matching existing v4
  normalize behavior; documented.
- pi round-5 MINORs pinned: CritiqueGateDeps gains `signal`; early accept refused before the
  cap; workfile bodies exclude headings (writeWorkfileSection owns them); sweep matches any
  session state; subprocess errorKind mapping; gate mint predicate includes stage + active.

## 10. Revision log v4 → v5 (round-4 findings)

- codex#1 / pi#8 (`/kanban complete` had no durable authority) → `plan.pendingCompletion`
  written by the tool on confirm refusal/timeout; the command is gated by it, has no
  free-form inputs, and converts it to `completion`; cleared by PASS/rerunCritique.
- codex#2 (rename leaves live run) → rename aborts/unregisters/clears token like pause.
- codex#3 (no gate CAS generation after pause/unpause at implement) →
  `stage_complete(critique)` mints a fresh gate token first; post-gate mutations revalidate
  it.
- pi#1 (GateOutcome lacked the section body) → `GateOutcome.body`; W4 writes the section in
  its post-gate locked mutation.
- pi#2 (conversation switch mid-activity) → waitForIdle + hasPendingMessages guard; busy ⇒
  notify + manual /kanban open.
- pi#3 (registry ABA) → identity-compared unregistration.
- pi#4 (cross-title duplicate pipelines) → one live pipeline run per process.
- pi#5 (aborted gate) → GateOutcome kind "aborted" + specified result text.
- pi#6 (critique:false trail) → `completion.critique: "skipped"`.
- pi#7 (flag precedence) → rerunCritique/acceptRemainingIssues mutually exclusive ⇒ error.
- pi#9 (in-process error detection) → D8 stopReason:"error" inspection specified.
- pi#10 (Session type drift) → store.ts additive fields moved into W0.
- pi#11 (mode validation) → normalizeState strips unknown mode values.
- pi#12 (pi binary resolution) → config `piBin` (default "pi"); real-spawn testing remains a
  documented manual step.

## 11. Revision log v3 → v4 (round-3 findings)

- pi#1 / codex#3 (fast path undefined; skipRemaining self-contradictory) → G7 rewritten:
  refine-simple skips research+grill under fastPath; `skipRemaining` REMOVED entirely.
- pi#2 (manual mode loses implementKickoff) → D3 Implement: every manual entry into
  implement delivers implementKickoff.
- pi#3 / pi#6 / codex#4 (gate child not abortable; registry leaks; duplicate run on open) →
  D3 registry redesign: title-keyed abort channel, unregister on run end, open aborts the
  prior run BEFORE minting, gate child registers too, grill dialogs get the run signal.
- pi#4 (no escape if in-tool confirm fails) → D10 `/kanban complete` command-context escape
  hatch, referenced from both confirm paths.
- pi#5 / codex#1 (StageInputs undefined) → D9 typed and frozen.
- pi#7 (lock across newSession risk) → D3 Implement: openImplementConversation called only
  after the locked mutation returns.
- codex#2 / codex#7 (orchestrator/critique seam untyped, model resolution stranded) → D12
  OrchestratorDeps / runCritiqueGate / GateOutcome frozen; gate model resolution owned by W2.
- codex#5 (attempts cap unenforced; headless deadlock) → D3 enforced cap (plain call stops
  re-running; rerunCritique | acceptRemainingIssues required; headless accept allowed with
  durable record).
- codex#6 / codex#8 (no durable summary home; plan-invariant violation) → PlanSnapshot
  `completion` record (bounded, archive-time only) replaces `acceptedIssues`; explicit
  invariant amendment assigned to W3 docs.
- codex#9 (spike evidence not in-repo) → W1 commits both spike scripts.

## 12. Revision log v2 → v3 (round-2 findings)

- codex#1 / pi#1 (manual critique deadlock & bypass) → D3 manual-critique path:
  `critiqueSummary` + human `ui.confirm` (timeout ⇒ refusal), headless records durably;
  critique-child failure offers only this path; no runner retry loop; no silent archive.
- codex#2 (no critique verdict contract) → D9 `Gate: PASS|FAIL` + issue bullets + typed
  `ParsedStageOutput.gate/issues` + safe FAIL defaults; `acceptedIssues` populated from the
  last parsed FAIL.
- codex#3 / pi#2 (subprocess model + parity) → D8 `--provider/--model`, full `--no-*` flag
  parity, prompt via stdin (also fixes pi#8 ARG_MAX / `--system-prompt` literal-text nit).
- codex#4 (identity CAS) → D3 `pipelineToken` minted per run, cleared on pause/remove,
  registry keyed by token, `!signal.aborted` in the revalidation predicate.
- codex#5 / pi#7 / pi#12 (workfile orphan/races) → D3 section write moved INSIDE the locked
  revalidated commit; startup orphan sweep; PASS-path crash orphan also swept.
- codex#6 / pi#10 (research failure semantics) → D2: advance if ≥1 worker succeeded; ALL
  failed ⇒ manual flip.
- codex#7 / pi#5 (skipRemaining scope) → D3: implement-only, error elsewhere.
- codex#8 (workfile seam untyped) → D12 full typed API + W0 stub commit.
- pi#3 (ui.confirm-in-tool unverified) → §3 spike addendum + universal 120 s timeout⇒refusal.
- pi#4 (resume rules at agent-owned stages) → D4: re-run applies to child stages only;
  implement/critique open the conversation; missing spec tolerated and noted.
- pi#6 (post-cap semantics) → D3: every further call re-runs the gate, attempts keep
  counting, accept offer stands from the 2nd FAIL on.
- pi#9 (onStatus channel) → D8 callers section; §3 corrects the ui surface fact
  (setStatus IS on ExtensionUIContext; the Pick-limited ui is ProjectTrustContext only).
- pi#11 (missing seam signatures) → D12 detectExternalTools + orchestrator exports + W0.

## 13. Revision log v1 → v2 (round-1 findings)

Same mapping as previously recorded: fallback modes (pi1/cx12), tool-computed diff
(pi2/cx7), loader construction (pi3/cx1), init de-hardcoding (pi4), lock protocol
(pi5/cx8), model semantics/auth (pi6/cx2/cx3), sole-writer merge (pi7), pause reach
(pi8/cx9), critique gate reachability (pi9/cx11), stage-only resume authority (pi10/cx14),
enforceable escape hatch (pi11/cx18), spike + subprocess backend (pi12/cx5), workfile
relocation/lifecycle (pi13/cx13/cx15), expanded tests (pi14/cx19), scope trim (pi15),
signal bridge (cx4), active-tools intersection (cx6), onUpdate wiring (cx10), frozen
grammar (cx16), ownership completeness (cx17), /kanban open contract (cx20).
