import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readPlan } from "./artifacts.js";
import type { KanbanConfig, LoopConfig } from "./config.js";
import {
  appendLoopLog,
  iterationWorktreePath,
  readLandedMarker,
  readLoopLog,
  readLoopRun,
  registerWorktree,
  renderLivingSummary,
  unregisterWorktree,
  writeBestPatch,
  writeLandedMarker,
  writeLoopRun,
  type LoopIterationRecord,
  type LoopRunManifest,
} from "./looplog.js";
import { measure, type MeasureOutcome } from "./measure.js";
import { beginLoopProgress, updateLoopProgress } from "./liveprogress.js";
import { startLoopWidget } from "./ui.js";
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
  capturePatch,
  commitAudit,
  commitExperiment,
  createDetachedWorktree,
  ensureExperimentBranch,
  experimentBranchHead,
  headCommit,
  landPatch,
  modifiedTrackedFiles,
  patchBetweenCommits,
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
  branch: string;
  /** The per-iteration evidence ref; undefined when `loop.audit` is off. */
  auditRef: string | undefined;
  manifest: LoopRunManifest;
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
  agentDecision: "keep" | "revert" = "keep",
): Decision {
  if (!outcome.validationPass)
    return { keep: false, failureReason: "the validation command failed" };
  if (loop.metric?.trim() && (outcome.metricUnmeasured || outcome.metric === undefined))
    return { keep: false, failureReason: "the metric could not be measured" };
  if (loop.decisionPolicy === "agent-with-validation")
    return agentDecision === "keep"
      ? { keep: true }
      : { keep: false, failureReason: "the experiment agent chose revert" };
  if (!loop.metric?.trim()) return { keep: true };
  const metric = outcome.metric;
  if (metric === undefined || !better(metric, bestMetric, loop.direction))
    return {
      keep: false,
      failureReason: `the metric did not improve (${metric ?? "unmeasured"} vs best ${bestMetric ?? "none"}, ${loop.direction} is better)`,
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

/** Create an iteration worktree from the best accepted experiment commit. */
async function openWorktree(
  setup: LoopSetup,
  iteration: number,
  bestCommit: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const cwd = setup.handle.ctx.cwd;
  const path = iterationWorktreePath(cwd, setup.base, iteration);
  const created = await createDetachedWorktree(cwd, bestCommit, path);
  if (!created.ok) return { ok: false, error: created.error ?? "git worktree add failed" };
  await registerWorktree(cwd, setup.base, {
    path,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
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
    `Outcome: ${kind}. Private experiment branch: \`${setup.branch}\`. Best result ${landed ? "landed as uncommitted, unstaged working-tree changes" : "was NOT landed"}.`,
  ];
  if (setup.auditRef)
    lines.push(
      `Per-iteration evidence ref: \`${setup.auditRef}\` (one commit per attempt, kept or discarded).`,
    );
  if (setup.loop.validate) lines.push(`Validation: \`${setup.loop.validate}\``);
  if (setup.loop.metric)
    lines.push(
      `Metric: \`${setup.loop.metric}\`${setup.loop.metric_name ? ` (${setup.loop.metric_name})` : ""}, ${setup.loop.direction} is better${setup.loop.target === undefined ? "" : `, target ${setup.loop.target}`}.`,
    );
  lines.push("", "### Iterations", "");
  for (const record of records)
    lines.push(
      `- ${record.iteration}. ${record.decision}${record.agentDecision ? ` (agent: ${record.agentDecision})` : ""}${metricText(record)}${record.verdict ? ` · ${record.verdict}` : ""}${record.commit ? ` · ${record.commit.slice(0, 12)}` : ""}${record.failureReason ? ` — ${record.failureReason}` : ""}${record.changed ? `\n  ${record.changed.replace(/\n/g, "\n  ")}` : ""}`,
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
  bestCommit: string;
  bestMetric: number | undefined;
  lessons: string | undefined;
  hookNote: string | undefined;
  /** Tip of the audit ref, so audit commits form one chain; absent before the first one. */
  auditParent: string | undefined;
}

interface IterationOutput {
  record: LoopIterationRecord;
  candidate: string;
  metric?: number;
  verdict: "complete" | "continue";
  validationPass: boolean;
  commit?: string;
  /** New tip of the audit ref, when this iteration was snapshotted. */
  auditCommit?: string;
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

  const opened = await openWorktree(setup, input.iteration, input.bestCommit);
  if (!opened.ok) return discarded(opened.error, `Could not set up the experiment: ${opened.error}.`);
  const worktree = opened.path;
  try {
    updateLoopProgress(setup.handle.signal, { iteration: input.iteration, best: input.bestMetric });
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
              decisionPolicy: setup.loop.decisionPolicy,
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
    await setup.handle.agents("implement", []);
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
    setup.handle.status(`kanban implement: iteration ${input.iteration}/${setup.loop.maxIterations} — measuring candidate`);
    const measured = await setup.measure(worktree, setup.loop, setup.handle.signal, {
      KANBAN_ITERATION: String(input.iteration),
      KANBAN_MAX_ITERATIONS: String(setup.loop.maxIterations),
      KANBAN_BASE: setup.base,
      ...(input.bestMetric === undefined ? {} : { KANBAN_BEST_METRIC: String(input.bestMetric) }),
    });
    if (setup.handle.signal.aborted)
      return { ...discarded("the run was aborted"), stop: "aborted" };
    const decision = decide(setup.loop, measured, input.bestMetric, parsed.decision);
    const stat = candidate.trim() ? await patchStat(worktree, candidate) : "";
    const changed = [stat.trim(), parsed.rationale].filter(Boolean).join("\n") || undefined;
    // The audit snapshot is taken for every measured attempt, before the keep/discard split:
    // a rejected iteration's evidence is exactly the evidence worth keeping, and its worktree
    // is about to be destroyed.
    const auditCommit = await snapshotAudit(setup, {
      iteration: input.iteration,
      worktree,
      parent: input.auditParent ?? input.bestCommit,
      decision: decision.keep ? "keep" : "discard",
      ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      validation: measured.validationPass,
    });

    if (!candidate.trim())
      return {
        record: {
          iteration: input.iteration,
          decision: "discard",
          agentDecision: parsed.decision,
          ...(changed ? { changed } : {}),
          validation: measured.validationPass,
          failureReason: "the iteration changed nothing",
          lesson: `Iteration ${input.iteration} produced no file changes${parsed.rationale ? ` (${parsed.rationale})` : ""}; a different approach is needed.`,
          ...(auditCommit ? { auditCommit } : {}),
          verdict: parsed.verdict,
          at,
        },
        candidate: "",
        verdict: parsed.verdict,
        validationPass: measured.validationPass,
        ...(auditCommit ? { auditCommit } : {}),
        ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      };

    const record: LoopIterationRecord = {
      iteration: input.iteration,
      decision: decision.keep ? "keep" : "discard",
      agentDecision: parsed.decision,
      ...(changed ? { changed } : {}),
      validation: measured.validationPass,
      ...(decision.keep ? {} : { validationTail: measured.tail }),
      ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      ...(auditCommit ? { auditCommit } : {}),
      ...(decision.failureReason ? { failureReason: decision.failureReason } : {}),
      ...(decision.keep
        ? {}
        : {
            lesson: `Iteration ${input.iteration}${parsed.rationale ? ` tried: ${parsed.rationale}.` : "."} Discarded because ${decision.failureReason}.`,
          }),
      verdict: parsed.verdict,
      at,
    };
    let commit: string | undefined;
    if (decision.keep) {
      const committed = await commitExperiment(
        worktree,
        setup.handle.ctx.cwd,
        setup.branch,
        `kanban-autoresearch: ${setup.handle.title} (iteration ${input.iteration})`,
      );
      if (!committed.ok || !committed.commit) {
        record.decision = "discard";
        record.failureReason = `the accepted experiment could not be committed (${committed.error ?? "unknown git error"})`;
        record.validationTail = measured.tail;
        record.lesson = `Iteration ${input.iteration} passed its fitness gate but Kanban could not checkpoint it on ${setup.branch}.`;
      } else {
        commit = committed.commit;
        record.commit = commit;
      }
    }
    return {
      record,
      candidate,
      verdict: parsed.verdict,
      validationPass: measured.validationPass,
      ...(measured.metric === undefined ? {} : { metric: measured.metric }),
      ...(auditCommit ? { auditCommit } : {}),
      ...(commit ? { commit } : {}),
    };
  } finally {
    await closeWorktree(setup, worktree);
  }
}

/**
 * One `kanban-audit/<base>` commit for this attempt. Best-effort by design: a failed audit
 * write is reported on the status line and never changes the iteration's outcome, because the
 * evidence trail must not be able to fail an experiment.
 */
async function snapshotAudit(
  setup: LoopSetup,
  input: {
    iteration: number;
    worktree: string;
    parent: string;
    decision: "keep" | "discard";
    metric?: number;
    validation: boolean;
  },
): Promise<string | undefined> {
  if (!setup.auditRef) return undefined;
  const summary = [
    `iteration ${input.iteration}`,
    input.decision,
    `validation ${input.validation ? "pass" : "fail"}`,
    ...(input.metric === undefined ? [] : [`metric ${input.metric}`]),
  ].join(", ");
  const written = await commitAudit(
    input.worktree,
    setup.handle.ctx.cwd,
    setup.auditRef,
    input.parent,
    `kanban-audit: ${setup.handle.title} (${summary})`,
    setup.loop.auditPaths ?? [],
  ).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!written.ok || !written.commit) {
    setup.handle.status(
      `kanban implement: audit snapshot failed (${written.error ?? "unknown git error"})`,
    );
    return undefined;
  }
  return written.commit;
}

async function driveLoop(setup: LoopSetup): Promise<LoopResult> {
  const cwd = setup.handle.ctx.cwd;
  const records = await readLoopLog(cwd, setup.base);
  let bestCommit = setup.manifest.bestCommit;
  let bestMetric = setup.manifest.bestMetric ?? setup.baseline.metric;
  let bestPatch = bestCommit === setup.baseCommit
    ? ""
    : await patchBetweenCommits(cwd, setup.baseCommit, bestCommit);
  let lessons = records.length
    ? await renderLivingSummary(cwd, setup.base, records)
    : undefined;
  let auditCommit = setup.manifest.auditCommit;
  let streak = [...records].reverse().findIndex((record) => record.decision === "keep");
  if (streak === -1) streak = records.length;
  let success = false;
  let stopped: { kind: LoopOutcomeKind; message?: string } | undefined;
  let hookNote: string | undefined;

  const checkpoint = async (
    status: LoopRunManifest["status"],
    nextIteration: number,
  ) => {
    setup.manifest = {
      ...setup.manifest,
      bestCommit,
      ...(setup.auditRef === undefined ? {} : { auditRef: setup.auditRef }),
      ...(auditCommit === undefined ? {} : { auditCommit }),
      ...(setup.baseline.metric === undefined ? {} : { baselineMetric: setup.baseline.metric }),
      ...(bestMetric === undefined ? {} : { bestMetric }),
      nextIteration,
      status,
      updatedAt: new Date().toISOString(),
    };
    await writeLoopRun(cwd, setup.base, setup.manifest);
  };

  for (
    let iteration = setup.manifest.nextIteration;
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
      bestCommit,
      bestMetric,
      lessons,
      hookNote,
      auditParent: auditCommit,
    });
    if (outcome.auditCommit) auditCommit = outcome.auditCommit;
    records.push(outcome.record);
    await appendLoopLog(cwd, setup.base, outcome.record);
    lessons = await renderLivingSummary(cwd, setup.base, await readLoopLog(cwd, setup.base));

    if (outcome.record.decision === "keep" && outcome.commit) {
      bestCommit = outcome.commit;
      bestPatch = await patchBetweenCommits(cwd, setup.baseCommit, bestCommit);
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
    await checkpoint("running", iteration + 1);
    updateLoopProgress(setup.handle.signal, {
      latest: outcome.metric, best: bestMetric,
      comment: `${outcome.record.decision}: ${outcome.record.failureReason ?? outcome.record.changed?.split("\n").at(-1) ?? outcome.record.lesson ?? "no rationale provided"}`,
      activity: success ? "target met; preparing landing" : "iteration recorded",
    });

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
  if (aborted) {
    await checkpoint("paused", setup.manifest.nextIteration);
    return {
      kind: "aborted",
      iterations: records.length,
      landed: false,
      advanced: false,
      message: "the implement loop was stopped; nothing was landed",
    };
  }
  if (stopped && stopped.kind !== "failure" && stopped.kind !== "exhausted") {
    await checkpoint("paused", setup.manifest.nextIteration);
    return {
      kind: "stopped",
      iterations: records.length,
      landed: false,
      advanced: false,
      ...(stopped.message ? { message: stopped.message } : {}),
    };
  }
  if (!bestPatch.trim()) {
    await checkpoint("failure", setup.manifest.nextIteration);
    const message =
      stopped?.message ??
      `no iteration improved on the baseline after ${records.length} attempt(s); the lessons are in .kanban/loop/${setup.base}.md`;
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "warning");
    return { kind: "failure", iterations: records.length, landed: false, advanced: false, message };
  }

  const kind: LoopOutcomeKind = success ? "success" : "exhausted";
  const landing = await land(setup, bestPatch);
  if (!landing.landed) {
    await checkpoint(kind === "success" ? "paused" : "exhausted", setup.manifest.nextIteration);
    const message = `could not land the winning patch (${landing.reason ?? "unknown reason"}); apply .kanban/loop/${setup.base}.patch yourself`;
    setup.handle.notify(`Kanban implement loop for “${setup.handle.title}”: ${message}.`, "error");
    return { kind, iterations: records.length, landed: false, advanced: false, message };
  }

  if (kind === "exhausted") {
    await checkpoint("exhausted", setup.manifest.nextIteration);
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
  await checkpoint("success", setup.manifest.nextIteration);
  const message = `implemented in ${records.length} iteration(s) on ${setup.branch}; the accepted patch is in your working tree (uncommitted) and the session moved to critique — run /kanban open to review it`;
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
 * FIRE-AND-FORGET: the returned promise resolves as soon as the run is registered, and
 * `LoopStart.run` settles when the whole run finishes. A caller whose process exits with the
 * command — print mode — must await `run`, or the armed loop dies with the runtime.
 *
 * Every kept iteration is committed to the private `kanban-autoresearch/<base>` branch; the
 * user's checkout remains clean until the final accepted patch is explicitly landed for
 * critique. With `loop.audit`, every attempt — kept or discarded — is additionally snapshotted
 * on the separate `kanban-audit/<base>` ref, which is the only durable record of evidence a
 * disposable iteration worktree produced.
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

  const currentHead = await headCommit(ctx.cwd);
  if (!currentHead)
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

  const base = workfileBase(session.planPath);
  const existing = await readLoopRun(ctx.cwd, base);
  const baseCommit = existing?.baseCommit ?? currentHead;
  if (existing && currentHead !== baseCommit)
    return refuse(
      ctx,
      `The saved autoresearch run is based on ${baseCommit.slice(0, 12)}, but HEAD is now ${currentHead.slice(0, 12)}. Restore that base or start a new Kanban session rather than mixing histories.`,
    );
  const branch = existing?.branch ?? `kanban-autoresearch/${base}`;
  // Config decides whether an audit trail is kept; a saved run only decides its ref name.
  const auditRef = loop.audit ? (existing?.auditRef ?? `kanban-audit/${base}`) : undefined;
  const branchReady = await ensureExperimentBranch(ctx.cwd, branch, baseCommit);
  if (!branchReady.ok)
    return refuse(
      ctx,
      `Kanban could not create the private experiment branch ${branch}: ${branchReady.error ?? "git branch failed"}.`,
      "error",
    );
  if (existing) {
    const branchHead = await experimentBranchHead(ctx.cwd, branch);
    if (branchHead !== existing.bestCommit)
      return refuse(
        ctx,
        `The private experiment branch ${branch} no longer points at the saved best commit. Resolve the branch manually before resuming.`,
        "error",
      );
  }

  const armed = await armImplementLoop(ctx, title, deps);
  if (!armed.ok) return refuse(ctx, armed.message, armed.kind);
  const handle = armed.handle;

  // Everything after arming, including slow baseline measurement, belongs to the task.
  // The interactive command returns its handle while promises wait for child/process events.
  const execute = async (): Promise<LoopResult> => {
    const abortedBeforeIteration = (): LoopResult => ({ kind: "aborted", iterations: 0, landed: false, advanced: false, message: "the implement loop was stopped during preparation" });
    const [plan, workfile] = await Promise.all([
      readPlan(ctx.cwd, session.planPath),
      readWorkfile(ctx.cwd, base).catch(() => ({ sections: {} }) as Workfile),
    ]);
    const measureFn = deps.measure ?? measure;
    if (handle.signal.aborted) return abortedBeforeIteration();
    beginLoopProgress(ctx.cwd, base, handle.signal, {
      title, goal: plan?.prompt?.trim() || title, maxIterations: loop.maxIterations,
      direction: loop.direction, target: loop.target, metricName: loop.metric_name,
    });
    startLoopWidget(ctx, base, handle.signal);

    let baseline: MeasureOutcome;
    let manifest: LoopRunManifest;
    if (existing) {
      baseline = {
        validationPass: true,
        tail: "",
        ...(existing.baselineMetric === undefined ? {} : { metric: existing.baselineMetric }),
        metricUnmeasured: false,
      };
      manifest = { ...existing, status: "running", updatedAt: new Date().toISOString() };
    } else if (loop.baselineMetric !== undefined) {
      // A configured baseline is already-recorded evidence. Re-deriving it would spend another
      // full measurement — for an expensive fitness command, hours of wall-clock or a scheduler
      // allocation — to learn a number the operator already supplied.
      handle.status(`kanban implement: baseline ${loop.baselineMetric} taken from config`);
      baseline = {
        validationPass: true,
        tail: "",
        metric: loop.baselineMetric,
        metricUnmeasured: false,
      };
      const now = new Date().toISOString();
      manifest = {
        schemaVersion: 1,
        base,
        branch,
        baseCommit,
        bestCommit: baseCommit,
        ...(auditRef === undefined ? {} : { auditRef }),
        baselineMetric: loop.baselineMetric,
        bestMetric: loop.baselineMetric,
        nextIteration: 1,
        status: "running",
        startedAt: now,
        updatedAt: now,
      };
      await writeLoopRun(ctx.cwd, base, manifest);
    } else {
      // Baseline: a throwaway worktree with the full iteration lifecycle, so the baseline is
      // measured exactly as an iteration is and never contaminates the user's tree.
      handle.status("kanban implement: measuring the baseline");
      const baselinePath = iterationWorktreePath(ctx.cwd, base, BASELINE_ITERATION);
      const created = await createDetachedWorktree(ctx.cwd, baseCommit, baselinePath);
      if (!created.ok) {
        throw new Error(`The Kanban implement loop could not create its baseline worktree: ${created.error ?? "git worktree add failed"}.`);
      }
      await registerWorktree(ctx.cwd, base, {
        path: baselinePath,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      try {
        baseline = await measureFn(baselinePath, loop, handle.signal, {
          KANBAN_ITERATION: String(BASELINE_ITERATION),
          KANBAN_MAX_ITERATIONS: String(loop.maxIterations),
          KANBAN_BASE: base,
        });
      } finally {
        try {
          await removeWorktreeForce(ctx.cwd, baselinePath);
        } finally {
          await unregisterWorktree(ctx.cwd, base, baselinePath).catch(() => undefined);
        }
      }
      if (handle.signal.aborted) return abortedBeforeIteration();
      const now = new Date().toISOString();
      manifest = {
        schemaVersion: 1,
        base,
        branch,
        baseCommit,
        bestCommit: baseCommit,
        ...(auditRef === undefined ? {} : { auditRef }),
        ...(baseline.metric === undefined ? {} : { baselineMetric: baseline.metric, bestMetric: baseline.metric }),
        nextIteration: 1,
        status: "running",
        startedAt: now,
        updatedAt: now,
      };
      await writeLoopRun(ctx.cwd, base, manifest);
    }
    if (handle.signal.aborted) {
      await disarm(handle);
      return { kind: "aborted", iterations: 0, landed: false, advanced: false, message: "the implement loop was stopped during preparation" };
    }
    if (loop.metric?.trim() && (baseline.metricUnmeasured || baseline.metric === undefined)) {
      throw new Error("The Kanban implement loop could not measure the baseline metric. Check loop.metric and loop.metric_name.");
    }

    const setup: LoopSetup = {
      handle,
      config: deps.config,
      loop,
      base,
      baseCommit,
      branch,
      auditRef,
      manifest,
      ...(workfile.sections.compose?.trim() ? { spec: workfile.sections.compose.trim() } : { spec: undefined }),
      prompt: plan?.prompt?.trim() || title,
      baseline,
      measure: measureFn,
    };
    updateLoopProgress(handle.signal, { baseline: baseline.metric, best: manifest.bestMetric });

    return driveLoop(setup);
  };

  const run = execute()
    .catch(async (error: unknown): Promise<LoopResult> => {
      const message = error instanceof Error ? error.message : String(error);
      const saved = await readLoopRun(ctx.cwd, base).catch(() => undefined);
      const ownsRun = await handle.check("implement").then((checked) => checked.ok, () => false);
      if (saved && ownsRun)
        await writeLoopRun(ctx.cwd, base, { ...saved, status: "failure", updatedAt: new Date().toISOString() }).catch(() => undefined);
      updateLoopProgress(handle.signal, { activity: `failure: ${message}` });
      await disarm(handle);
      ctx.ui.notify(
        `Kanban implement loop for “${title}” stopped: ${message}`,
        "error",
      );
      return { kind: handle.signal.aborted ? "aborted" : "failure", iterations: 0, landed: false, advanced: false, message };
    })
    .then((result) => {
      updateLoopProgress(handle.signal, { activity: `${result.kind}: ${result.message ?? (result.landed ? "best result landed" : "nothing landed")}` });
      return result;
    })
    .finally(() => {
      handle.release();
    });
  handle.track(run.then(() => undefined));
  ctx.ui.notify(`Kanban implement task started in the background for “${title}”. Ask for progress or use /kanban status; no monitoring turn is needed.`, "info");
  return { armed: true, run };
}
