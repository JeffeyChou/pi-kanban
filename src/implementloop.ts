import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readPlan } from "./artifacts.js";
import type { KanbanConfig, LoopConfig } from "./config.js";
import {
  appendLoopLog,
  deleteLoopArtifacts,
  iterationWorktreePath,
  readLandedMarker,
  readLoopLog,
  registerWorktree,
  renderLivingSummary,
  unregisterWorktree,
  writeBestPatch,
  writeLandedMarker,
  type LoopIterationRecord,
} from "./looplog.js";
import { measure, type MeasureOutcome } from "./measure.js";
import {
  armImplementLoop,
  loopChildFailed,
  type LoopRunDeps,
  type LoopRunHandle,
} from "./orchestrator.js";
import { implementLoopPrompt, parseImplementLoopOutput } from "./prompts.js";
import { load } from "./store.js";
import { readWorkfile, workfileBase, type Workfile } from "./workfile.js";
import {
  applyPatch,
  capturePatch,
  createDetachedWorktree,
  headCommit,
  landPatch,
  modifiedTrackedFiles,
  patchStat,
  removeWorktreeForce,
} from "./worktree.js";

/**
 * The implement child's tool set. NO `bash` (plan §4.2, round-4 CRITICAL): a child with a shell
 * could `cd` out of the worktree or run `git add`/`git commit` in the real repository, escaping
 * both the experiment isolation and the never-stage invariant. Running commands is the
 * orchestrator's job — see the measure step.
 */
export const IMPLEMENT_CHILD_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
] as const;

/** The baseline uses iteration 0's worktree path; real iterations start at 1. */
const BASELINE_ITERATION = 0;
const HOOK_TIMEOUT_MS = 30_000;
const HOOK_STDOUT_MAX_BYTES = 8 * 1024;
/** A hook exiting with this code stops the loop. */
const HOOK_STOP_EXIT = 10;

export type LoopOutcomeKind =
  /** A kept iteration reported `Status: complete` and met the fitness bar: landed + advanced. */
  | "success"
  /** Iterations or the no-improvement streak ran out: the partial best is landed, stage stays. */
  | "exhausted"
  /** No iteration was ever kept: nothing is landed and the stage stays. */
  | "failure"
  /** The user (or a lifecycle event) aborted the run: nothing is landed. */
  | "aborted"
  /** A state predicate stopped the run at a boundary: nothing is landed. */
  | "stopped";

export interface LoopResult {
  kind: LoopOutcomeKind;
  /** Completed iterations, baseline excluded. */
  iterations: number;
  landed: boolean;
  advanced: boolean;
  message?: string;
}

export type LoopStart =
  | { armed: true; run: Promise<LoopResult> }
  | { armed: false; message: string; kind: "info" | "error" };

export interface ImplementLoopDeps extends LoopRunDeps {
  /** Injectable for tests; defaults to the real command runner. */
  measure?: typeof measure;
}

interface LoopSetup {
  handle: LoopRunHandle;
  config: KanbanConfig;
  loop: LoopConfig;
  base: string;
  baseCommit: string;
  spec: string | undefined;
  prompt: string;
  baseline: MeasureOutcome;
  measure: typeof measure;
}

function fitnessConfigured(loop: LoopConfig): boolean {
  return Boolean(loop.validate?.trim() || loop.metric?.trim());
}

function better(
  candidate: number,
  best: number | undefined,
  direction: LoopConfig["direction"],
): boolean {
  if (best === undefined) return true;
  return direction === "lower" ? candidate < best : candidate > best;
}

function targetReached(
  metric: number | undefined,
  loop: LoopConfig,
): boolean {
  if (loop.target === undefined) return true;
  if (metric === undefined) return false;
  return loop.direction === "lower" ? metric <= loop.target : metric >= loop.target;
}

interface Decision {
  keep: boolean;
  failureReason?: string;
}

/** Deterministic, orchestrator-side fitness (plan §4.5) — the child never decides this. */
export function decide(
  loop: LoopConfig,
  outcome: MeasureOutcome,
  bestMetric: number | undefined,
): Decision {
  if (!outcome.validationPass)
    return { keep: false, failureReason: "the validation command failed" };
  if (!loop.metric?.trim()) return { keep: true };
  if (outcome.metricUnmeasured || outcome.metric === undefined)
    return { keep: false, failureReason: "the metric could not be measured" };
  if (!better(outcome.metric, bestMetric, loop.direction))
    return {
      keep: false,
      failureReason: `the metric did not improve (${outcome.metric} vs best ${bestMetric ?? "none"}, ${loop.direction} is better)`,
    };
  return { keep: true };
}

/* ---------------------------------- optional hooks ---------------------------------- */

interface HookOutcome {
  note?: string;
  stop: boolean;
}

/**
 * Opt-in `.kanban/hooks/{before,after}-iteration`: JSON on stdin, ≤8KB of stdout injected into
 * the next prompt, 30s timeout, exit 10 stops the loop. A missing or non-executable hook is
 * silently skipped, and a hook failure never fails an iteration.
 */
async function runHook(
  cwd: string,
  name: "before-iteration" | "after-iteration",
  payload: unknown,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const path = join(cwd, ".kanban", "hooks", name);
  try {
    await access(path, constants.X_OK);
  } catch {
    return { stop: false };
  }
  if (signal.aborted) return { stop: false };
  return new Promise<HookOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, [], { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve({ stop: false });
    }
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ stop: false });
    }, HOOK_TIMEOUT_MS);
    const onAbort = () => {
      kill();
      finish({ stop: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < HOOK_STDOUT_MAX_BYTES) stdout += chunk.toString();
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", () => finish({ stop: false }));
    child.on("close", (code: number | null) => {
      const note = stdout.slice(0, HOOK_STDOUT_MAX_BYTES).trim();
      finish({ ...(note ? { note } : {}), stop: code === HOOK_STOP_EXIT });
    });
    try {
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    } catch {
      // A hook that closed stdin early still gets to report through its exit code.
    }
  });
}

/* ------------------------------------ worktrees ------------------------------------- */

/** Create the iteration worktree, register it in the manifest, and apply the current best. */
async function openWorktree(
  setup: LoopSetup,
  iteration: number,
  bestPatch: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const cwd = setup.handle.ctx.cwd;
  const path = iterationWorktreePath(cwd, setup.base, iteration);
  const created = await createDetachedWorktree(cwd, setup.baseCommit, path);
  if (!created.ok) return { ok: false, error: created.error ?? "git worktree add failed" };
  await registerWorktree(cwd, setup.base, {
    path,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  if (bestPatch.trim()) {
    const applied = await applyPatch(path, bestPatch);
    if (!applied.ok) {
      await closeWorktree(setup, path);
      return {
        ok: false,
        error: `the best-so-far patch no longer applies: ${applied.error ?? "git apply failed"}`,
      };
    }
  }
  return { ok: true, path };
}

/** Disposable scaffolding: force-remove and unregister. Always runs, including on abort. */
async function closeWorktree(setup: LoopSetup, path: string): Promise<void> {
  const cwd = setup.handle.ctx.cwd;
  try {
    await removeWorktreeForce(cwd, path);
  } finally {
    await unregisterWorktree(cwd, setup.base, path).catch(() => undefined);
  }
}

/* ------------------------------------- landing -------------------------------------- */

interface LandOutcome {
  landed: boolean;
  /** Already-landed (marker match) counts as landed without re-applying. */
  reason?: string;
}

/**
 * Detect-and-defer landing (plan §4). Kanban cannot lock the user's git working tree, so the
 * TOCTOU is irreducible; it is made safe by (1) always writing the recoverable patch first,
 * (2) re-checking HEAD/cleanliness/token immediately before applying, (3) `git apply` being
 * atomic per invocation, and (4) an atomic `<base>.landed` marker written BEFORE the advancing
 * mutate so a re-run never double-applies.
 */
async function land(setup: LoopSetup, patch: string): Promise<LandOutcome> {
  const cwd = setup.handle.ctx.cwd;
  const sha = await writeBestPatch(cwd, setup.base, patch);
  const marker = await readLandedMarker(cwd, setup.base);
  if (marker?.patchSha === sha) return { landed: true, reason: "already landed" };

  const head = await headCommit(cwd);
  if (head !== setup.baseCommit)
    return { landed: false, reason: "the repository moved to a different commit" };
  let modified: string[];
  try {
    modified = await modifiedTrackedFiles(cwd);
  } catch (error: unknown) {
    return {
      landed: false,
      reason: `the working tree could not be inspected (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (modified.length)
    return { landed: false, reason: "the working tree has uncommitted changes to tracked files" };
  const checked = await setup.handle.check("implement");
  if (!checked.ok) return { landed: false, reason: `the session ${checked.reason}` };

  const applied = await landPatch(cwd, patch);
  if (!applied.ok)
    return { landed: false, reason: applied.error ?? "git apply refused the patch" };
  await writeLandedMarker(cwd, setup.base, sha);
  return { landed: true };
}

/* ------------------------------------ reporting ------------------------------------- */

function metricText(record: LoopIterationRecord): string {
  return record.metric === undefined ? "" : ` metric ${record.metric}`;
}

/** The `## implement` workfile section: what the loop tried, kept, and landed. */
function implementSection(
  setup: LoopSetup,
  kind: LoopOutcomeKind,
  records: LoopIterationRecord[],
  landed: boolean,
): string {
  const kept = records.filter((record) => record.decision === "keep");
  const lines: string[] = [
    `Implemented by the Kanban implement loop: ${records.length} iteration(s), ${kept.length} kept.`,
    "",
    `Outcome: ${kind}. Best result ${landed ? "landed as uncommitted, unstaged working-tree changes" : "was NOT landed"}.`,
  ];
  if (setup.loop.validate) lines.push(`Validation: \`${setup.loop.validate}\``);
  if (setup.loop.metric)
    lines.push(
      `Metric: \`${setup.loop.metric}\`${setup.loop.metric_name ? ` (${setup.loop.metric_name})` : ""}, ${setup.loop.direction} is better${setup.loop.target === undefined ? "" : `, target ${setup.loop.target}`}.`,
    );
  lines.push("", "### Iterations", "");
  for (const record of records)
    lines.push(
      `- ${record.iteration}. ${record.decision}${metricText(record)}${record.verdict ? ` · ${record.verdict}` : ""}${record.failureReason ? ` — ${record.failureReason}` : ""}${record.changed ? `\n  ${record.changed.replace(/\n/g, "\n  ")}` : ""}`,
    );
  const lessons = records.filter((record) => record.lesson);
  if (lessons.length) {
    lines.push("", "### Lessons from discarded iterations", "");
    for (const record of lessons) lines.push(`- ${record.iteration}. ${record.lesson}`);
  }
  return lines.join("\n");
}

/* ------------------------------------ the driver ------------------------------------ */

interface IterationInput {
  iteration: number;
  bestPatch: string;
  bestMetric: number | undefined;
  lessons: string | undefined;
  hookNote: string | undefined;
}

interface IterationOutput {
  record: LoopIterationRecord;
  candidate: string;
  metric?: number;
  verdict: "complete" | "continue";
  validationPass: boolean;
  /** Set when the run must stop without recording anything more. */
  stop?: LoopOutcomeKind;
  stopMessage?: string;
}

async function runIteration(
  setup: LoopSetup,
  input: IterationInput,
): Promise<IterationOutput> {
  const at = new Date().toISOString();
  const discarded = (failureReason: string, lesson?: string): IterationOutput => ({
    record: {
      iteration: input.iteration,
      decision: "discard",
      failureReason,
      ...(lesson ? { lesson } : {}),
      at,
    },
    candidate: "",
    verdict: "continue",
    validationPass: false,
  });

  const opened = await openWorktree(setup, input.iteration, input.bestPatch);
  if (!opened.ok) return discarded(opened.error, `Could not set up the experiment: ${opened.error}.`);
  const worktree = opened.path;
  try {
    setup.handle.status(
      `kanban implement: iteration ${input.iteration}/${setup.loop.maxIterations} — child session`,
    );
    const outcome = await setup.handle.child({
      prompt: implementLoopPrompt({
        title: setup.handle.title,
        prompt: setup.prompt,
        ...(setup.spec ? { spec: setup.spec } : {}),
        ...(input.lessons ? { lessons: input.lessons } : {}),
        iteration: input.iteration,
        maxIterations: setup.loop.maxIterations,
        ...(setup.loop.validate ? { validate: setup.loop.validate } : {}),
        ...(setup.loop.metric
          ? {
              hasMetric: true,
              direction: setup.loop.direction,
              ...(setup.loop.metric_name ? { metricName: setup.loop.metric_name } : {}),
              ...(setup.loop.target === undefined ? {} : { target: setup.loop.target }),
              ...(input.bestMetric === undefined ? {} : { bestMetric: input.bestMetric }),
            }
          : {}),
        ...(input.hookNote ? { hookNote: input.hookNote } : {}),
      }),
      cwd: worktree,
      tools: IMPLEMENT_CHILD_TOOLS,
      label: `implement ${input.iteration}/${setup.loop.maxIterations}`,
    });
    if (outcome.result.aborted || setup.handle.signal.aborted)
      return { ...discarded("the run was aborted"), stop: "aborted" };
    if (loopChildFailed(outcome.result)) {
      const detail = `${outcome.result.errorKind ?? "other"}${outcome.result.error ? `: ${outcome.result.error}` : ""}`;
      // A DISCARD per plan §2, EXCEPT for an unresolvable model: that is a configuration error
      // rather than an experiment outcome, and every further iteration would fail identically.
      if (outcome.result.errorKind === "model")
        return {
          ...discarded(`the implement child could not run (${detail})`),
          stop: "failure",
          stopMessage: `the implement model did not resolve (${detail}) — fix models.implement and re-run /kanban implement`,
        };
      return discarded(
        `the implement child failed (${detail})`,
        `The child session failed (${detail}); no hypothesis was tested.`,
      );
    }

    const parsed = parseImplementLoopOutput(outcome.result.text);
    // The candidate is captured BEFORE measuring, so measurement debris (build output, caches)
    // can never enter the patch.
    let candidate: string;
    try {
      candidate = await capturePatch(worktree, setup.baseCommit);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return discarded(
        `the candidate patch could not be captured (${detail})`,
        `Iteration ${input.iteration} could not be captured (${detail}); its work was dropped.`,
      );
    }
    const measured = await setup.measure(worktree, setup.loop, setup.handle.signal);
    if (setup.handle.signal.aborted)
      return { ...discarded("the run was aborted"), stop: "aborted" };
    const decision = decide(setup.loop, measured, input.bestMetric);
    const stat = candidate.trim() ? await patchStat(worktree, candidate) : "";
    const changed = [stat.trim(), parsed.rationale].filter(Boolean).join("\n") || undefined;

    if (!candidate.trim())
      return {
        record: {
          iteration: input.iteration,
          decision: "discard",
          ...(changed ? { changed } : {}),
          validation: measured.validationPass,
          failureReason: "the iteration changed nothing",
          lesson: `Iteration ${input.iteration} produced no file changes${parsed.rationale ? ` (${parsed.rationale})` : ""}; a different approach is needed.`,
          verdict: parsed.verdict,
          at,
        },
        candidate: "",
        verdict: parsed.verdict,
        validationPass: measured.validationPass,
        ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      };

    const record: LoopIterationRecord = {
      iteration: input.iteration,
      decision: decision.keep ? "keep" : "discard",
      ...(changed ? { changed } : {}),
      validation: measured.validationPass,
      ...(decision.keep ? {} : { validationTail: measured.tail }),
      ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      ...(decision.failureReason ? { failureReason: decision.failureReason } : {}),
      ...(decision.keep
        ? {}
        : {
            lesson: `Iteration ${input.iteration}${parsed.rationale ? ` tried: ${parsed.rationale}.` : "."} Discarded because ${decision.failureReason}.`,
          }),
      verdict: parsed.verdict,
      at,
    };
    return {
      record,
      candidate,
      verdict: parsed.verdict,
      validationPass: measured.validationPass,
      ...(measured.metric === undefined ? {} : { metric: measured.metric }),
    };
  } finally {
    await closeWorktree(setup, worktree);
  }
}

async function driveLoop(setup: LoopSetup): Promise<LoopResult> {
  const cwd = setup.handle.ctx.cwd;
  const records: LoopIterationRecord[] = [];
  let bestPatch = "";
  let bestMetric = setup.baseline.metric;
  let lessons: string | undefined;
  let streak = 0;
  let success = false;
  let stopped: { kind: LoopOutcomeKind; message?: string } | undefined;
  let hookNote: string | undefined;

  for (
    let iteration = 1;
    iteration <= setup.loop.maxIterations && !success && !stopped;
    iteration += 1
  ) {
    if (setup.handle.signal.aborted) {
      stopped = { kind: "aborted" };
      break;
    }
    const checked = await setup.handle.check("implement");
    if (!checked.ok) {
      setup.handle.boundaryStop(checked.reason);
      stopped = { kind: checked.reason === "aborted" ? "aborted" : "stopped" };
      break;
    }
    if (
      !(await setup.handle.agents("implement", [
        setup.handle.childAgent(`implement iteration ${iteration}`, "implement stage"),
      ]))
    ) {
      stopped = { kind: "stopped" };
      break;
    }
    if (setup.loop.hooks) {
      const before = await runHook(
        cwd,
        "before-iteration",
        { iteration, base: setup.base, bestMetric: bestMetric ?? null },
        setup.handle.signal,
      );
      hookNote = before.note;
      if (before.stop) {
        stopped = { kind: "stopped", message: "a before-iteration hook stopped the loop" };
        break;
      }
    }

    const outcome = await runIteration(setup, {
      iteration,
      bestPatch,
      bestMetric,
      lessons,
      hookNote,
    });
    records.push(outcome.record);
    await appendLoopLog(cwd, setup.base, outcome.record);
    lessons = await renderLivingSummary(cwd, setup.base, await readLoopLog(cwd, setup.base));

    if (outcome.record.decision === "keep") {
      bestPatch = outcome.candidate;
      if (outcome.metric !== undefined) bestMetric = outcome.metric;
      streak = 0;
      await writeBestPatch(cwd, setup.base, bestPatch);
      success =
        outcome.verdict === "complete" &&
        outcome.validationPass &&
        (!setup.loop.metric?.trim() || targetReached(outcome.metric, setup.loop));
    } else {
      streak += 1;
    }

    if (outcome.stop) {
      stopped = {
        kind: outcome.stop,
        ...(outcome.stopMessage ? { message: outcome.stopMessage } : {}),
      };
      break;
    }
    if (setup.loop.hooks && !success) {
      const after = await runHook(
        cwd,
        "after-iteration",
        {
          iteration,
          base: setup.base,
          decision: outcome.record.decision,
          metric: outcome.metric ?? null,
        },
        setup.handle.signal,
      );
      if (after.note) hookNote = after.note;
      if (after.stop) {
        stopped = { kind: "stopped", message: "an after-iteration hook stopped the loop" };
        break;
      }
    }
    if (!success && streak >= setup.loop.noImprovementStreak) break;
  }

  const aborted = stopped?.kind === "aborted" || setup.handle.signal.aborted;
  // The advancing commit clears the roster itself; every other terminal path must, or the
  // widget keeps reporting a phantom working child. An aborted run cannot write state at all,
  // so its roster is cleared by the next run's mint, exactly as the pipeline's is.
  if (!aborted) await setup.handle.agents("implement", []);
  if (aborted)
    return {
      kind: "aborted",
      iterations: records.length,
      landed: false,
      advanced: false,
      message: "the implement loop was stopped; nothing was landed",
    };
  if (stopped && stopped.kind !== "failure" && stopped.kind !== "exhausted")
    return {
      kind: "stopped",
      iterations: records.length,
      landed: false,
      advanced: false,
      ...(stopped.message ? { message: stopped.message } : {}),
    };
  if (!bestPatch.trim()) {
    const message =
      stopped?.message ??
      `no iteration improved on the baseline after ${records.length} attempt(s); the lessons are in .kanban/loop/${setup.base}.md`;
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "warning");
    return { kind: "failure", iterations: records.length, landed: false, advanced: false, message };
  }

  const kind: LoopOutcomeKind = success ? "success" : "exhausted";
  const landing = await land(setup, bestPatch);
  if (!landing.landed) {
    const message = `could not land the winning patch (${landing.reason ?? "unknown reason"}); apply .kanban/loop/${setup.base}.patch yourself`;
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "error");
    return { kind, iterations: records.length, landed: false, advanced: false, message };
  }

  if (kind === "exhausted") {
    // A specific stop reason (e.g. an unresolvable implement model) must survive the generic
    // exhausted banner, or the user is told the wrong reason the loop ended.
    const message =
      stopped?.message ??
      `${records.length} iteration(s) ran and the best result is now in your working tree (uncommitted), but no iteration reported the spec complete — review it and continue with /kanban open`;
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "warning");
    return { kind, iterations: records.length, landed: true, advanced: false, message };
  }

  const committed = await setup.handle.commit(
    "implement",
    implementSection(setup, kind, records, true),
  );
  if (!committed.ok) {
    setup.handle.commitStop("implement", committed.reason);
    const message =
      "the winning patch is in your working tree (uncommitted) but the stage could not be advanced; advance it yourself with kanban_update stage_complete";
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "error");
    return { kind, iterations: records.length, landed: true, advanced: false, message };
  }
  await deleteLoopArtifacts(cwd, setup.base).catch(() => undefined);
  const message = `implemented in ${records.length} iteration(s); the change is in your working tree (uncommitted) and the session moved to critique — run /kanban open to review it`;
  setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "info");
  return { kind, iterations: records.length, landed: true, advanced: true, message };
}

/* -------------------------------------- arming -------------------------------------- */

function refuse(
  ctx: ExtensionCommandContext,
  message: string,
  kind: "info" | "error" = "info",
): LoopStart {
  ctx.ui.notify(message, kind);
  return { armed: false, message, kind };
}

/** Clear the minted token when a post-arm preflight refuses, then release the abort channel. */
async function disarm(handle: LoopRunHandle): Promise<void> {
  await handle
    .mutate("implement", async (_state, session) => {
      delete session.pipelineToken;
      session.updatedAt = new Date().toISOString();
    })
    .catch(() => undefined);
  handle.release();
}

/**
 * Arm and start the orchestrator-owned implement loop for `title`.
 *
 * FIRE-AND-FORGET: the returned promise resolves as soon as the run is registered; the detached
 * run reports every outcome through ctx.ui.notify. The loop is COMMIT-FREE and STAGE-FREE: it
 * never runs `git add` or `git commit`, and the winning result lands as uncommitted, unstaged
 * working-tree changes.
 */
export async function startImplementLoop(
  ctx: ExtensionCommandContext,
  title: string,
  deps: ImplementLoopDeps,
): Promise<LoopStart> {
  const loop = deps.config.loop;
  if (!loop.enabled)
    return refuse(
      ctx,
      "The Kanban implement loop is disabled. Set loop.enabled in /kanban config to use it.",
    );
  if (!fitnessConfigured(loop))
    return refuse(
      ctx,
      "The Kanban implement loop needs a fitness signal: set loop.validate (a command whose exit code decides) or loop.metric in /kanban config.",
    );

  const state = await load(ctx.cwd);
  const session = state.sessions.find((item) => item.title === title);
  if (!session)
    return refuse(ctx, `Kanban session “${title}” is no longer active.`, "error");

  const baseCommit = await headCommit(ctx.cwd);
  if (!baseCommit)
    return refuse(
      ctx,
      "The Kanban implement loop needs a Git repository with at least one commit.",
      "error",
    );
  // The git helpers throw when git itself fails; a preflight probe that cannot answer must
  // refuse cleanly rather than surface as an unhandled command error.
  let modified: string[];
  try {
    modified = await modifiedTrackedFiles(ctx.cwd);
  } catch (error: unknown) {
    return refuse(
      ctx,
      `The Kanban implement loop could not inspect the working tree: ${error instanceof Error ? error.message : String(error)}.`,
      "error",
    );
  }
  if (modified.length)
    return refuse(
      ctx,
      `The Kanban implement loop needs a clean working tree: ${modified.length} tracked file(s) are modified. Commit or stash them first.`,
    );

  const armed = await armImplementLoop(ctx, title, deps);
  if (!armed.ok) return refuse(ctx, armed.message, armed.kind);
  const handle = armed.handle;

  const base = workfileBase(session.planPath);
  const [plan, workfile] = await Promise.all([
    readPlan(ctx.cwd, session.planPath),
    readWorkfile(ctx.cwd, base).catch(() => ({ sections: {} }) as Workfile),
  ]);
  const measureFn = deps.measure ?? measure;

  // Baseline: a throwaway worktree with the full iteration lifecycle, so the baseline is
  // measured exactly as an iteration is and never contaminates the user's tree. The baseline is
  // NEVER a success — SUCCESS requires a child's own `Status: complete` verdict.
  handle.status("kanban implement: measuring the baseline");
  const baselinePath = iterationWorktreePath(ctx.cwd, base, BASELINE_ITERATION);
  const created = await createDetachedWorktree(ctx.cwd, baseCommit, baselinePath);
  if (!created.ok) {
    await disarm(handle);
    return refuse(
      ctx,
      `The Kanban implement loop could not create its baseline worktree: ${created.error ?? "git worktree add failed"}.`,
      "error",
    );
  }
  await registerWorktree(ctx.cwd, base, {
    path: baselinePath,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  let baseline: MeasureOutcome;
  try {
    baseline = await measureFn(baselinePath, loop, handle.signal);
  } finally {
    try {
      await removeWorktreeForce(ctx.cwd, baselinePath);
    } finally {
      await unregisterWorktree(ctx.cwd, base, baselinePath).catch(() => undefined);
    }
  }
  if (handle.signal.aborted) {
    await disarm(handle);
    return { armed: false, message: "the implement loop was stopped before it started", kind: "info" };
  }
  if (loop.metric?.trim() && (baseline.metricUnmeasured || baseline.metric === undefined)) {
    await disarm(handle);
    return refuse(
      ctx,
      "The Kanban implement loop could not measure the baseline metric, so no iteration could ever be compared against it. Check loop.metric and loop.metric_name.",
      "error",
    );
  }

  const setup: LoopSetup = {
    handle,
    config: deps.config,
    loop,
    base,
    baseCommit,
    ...(workfile.sections.compose?.trim() ? { spec: workfile.sections.compose.trim() } : { spec: undefined }),
    prompt: plan?.prompt?.trim() || title,
    baseline,
    measure: measureFn,
  };

  const run = driveLoop(setup)
    .catch((error: unknown): LoopResult => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Kanban implement loop for “${title}” stopped: ${message}`,
        "error",
      );
      return { kind: "stopped", iterations: 0, landed: false, advanced: false, message };
    })
    .finally(() => {
      handle.release();
    });
  handle.track(run.then(() => undefined));
  return { armed: true, run };
}
