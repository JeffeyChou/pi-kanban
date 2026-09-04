import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPlan, writePlan, type PlanSnapshot } from "./artifacts.js";
import { isSingleShot } from "./capabilities.js";
import type { KanbanConfig, StageModelKey } from "./config.js";
import {
  RESEARCH_ANGLE_LABELS,
  parseStageOutput,
  stagePrompt,
  stageSystemPrompt,
  type ParsedStageOutput,
  type GrillQuestion,
} from "./prompts.js";
import { PipelineProgress } from "./pipelineprogress.js";
import { appendLiveOutput, endLoopProgress, updateLoopProgress } from "./liveprogress.js";
import type { ChildResult, ErrorKind, RunChild } from "./runner.js";
import {
  advanceStage,
  load,
  mutateAsync,
  replaceAgents,
  type AgentRecord,
  type KanbanState,
  type Session,
  type Stage,
} from "./store.js";
import { refreshWidget, startUsageDisplay } from "./ui.js";
import { beginUsage, beginChildUsage, finishChildUsage, endUsage } from "./usage.js";
import { readWorkfile, workfileBase, writeWorkfileSection } from "./workfile.js";

export interface OrchestratorDeps {
  runChild: RunChild;
  config: KanbanConfig;
  /**
   * W4 wraps startCleanConversation. The ORCHESTRATOR NEVER CALLS THIS — the pipeline ends
   * at the compose commit with a notify; W4's user-initiated /kanban open / dashboard Enter
   * path is the only caller. It lives in deps so tests can assert it is NOT called.
   */
  openImplementConversation: (
    session: Session,
    spec: string | undefined,
  ) => Promise<{ cancelled: boolean }>;
}

/** Read-only investigation tools every child stage gets. */
const CHILD_TOOLS = ["read", "grep", "find", "ls"] as const;
const STATUS_KEY = "kanban";
const CHILD_AGENT_PREFIX = "Kanban ";

/** Child stages the orchestrator owns, in order. */
const CHILD_STAGES: Stage[] = ["refine", "research", "grill", "compose"];

interface RunEntry {
  controller: AbortController;
  clearStatus?: () => void;
  /** Detached run promise; absent for a critique-gate registration. */
  promise?: Promise<void>;
}

/** The abort CHANNEL: one live run per title (the CAS identity is Session.pipelineToken). */
const runs = new Map<string, RunEntry>();

/** Diagnostic/test seam: the detached run promise for a title while its run is live. */
export function pipelineRunFor(title: string): Promise<void> | undefined {
  return runs.get(title)?.promise;
}

/** Liveness of the abort channel itself: the implement loop's stage_complete refusal keys on this. */
export function hasLiveRun(title: string): boolean {
  return runs.has(title);
}

/** Abort + unregister the title's live run (pipeline or critique gate). Used by pause/remove/rename/open. */
export function abortPipelineFor(title: string): boolean {
  const entry = runs.get(title);
  if (!entry) return false;
  entry.clearStatus?.();
  runs.delete(title);
  entry.controller.abort();
  return true;
}

/** W4 calls on session_shutdown/reload; orphaned children stop at their next token revalidation. */
export function clearPipelineRegistry(): void {
  const entries = [...runs.values()];
  runs.clear();
  for (const entry of entries) {
    entry.clearStatus?.();
    entry.controller.abort();
  }
}

/** ABA guard: only the run that owns the entry may unregister it. */
function unregister(title: string, entry: RunEntry): void {
  if (runs.get(title) === entry) runs.delete(title);
}

export type StopReason = "missing" | "blocked" | "manual" | "stage" | "token" | "aborted";

export type Guarded<T> =
  | { ok: true; value: T; state: KanbanState }
  | { ok: false; reason: StopReason };

interface RunContext {
  ctx: ExtensionCommandContext;
  title: string;
  token: string;
  signal: AbortSignal;
  deps: OrchestratorDeps;
  progress?: PipelineProgress;
}

function childAgent(name: string, role: string): AgentRecord {
  return { name: `${CHILD_AGENT_PREFIX}${name}`, role, status: "working" };
}

/** Everything the pipeline did not add; replaceAgents restores the primary coordinator. */
function withoutChildAgents(session: Session): AgentRecord[] {
  return session.agents.filter((agent) => !agent.name.startsWith(CHILD_AGENT_PREFIX));
}

async function syncPlan(
  cwd: string,
  session: Session,
  patch?: (plan: PlanSnapshot) => PlanSnapshot,
): Promise<void> {
  const plan = await readPlan(cwd, session.planPath);
  if (!plan) return;
  const next: PlanSnapshot = {
    ...plan,
    title: session.title,
    stage: session.stage,
    status: session.state,
    agents: session.agents,
    updatedAt: session.updatedAt,
  };
  await writePlan(cwd, session.planPath, patch ? patch(next) : next);
}

/** Every commit revalidates: exists, active, pipeline mode, expected stage, our token, not aborted. */
function revalidate(
  state: KanbanState,
  run: RunContext,
  expected: Stage | undefined,
): { ok: true; session: Session } | { ok: false; reason: StopReason } {
  if (run.signal.aborted) return { ok: false, reason: "aborted" };
  const session = state.sessions.find((item) => item.title === run.title);
  if (!session) return { ok: false, reason: "missing" };
  if (session.state !== "active") return { ok: false, reason: "blocked" };
  if ((session.mode ?? "manual") !== "pipeline") return { ok: false, reason: "manual" };
  if (expected && session.stage !== expected) return { ok: false, reason: "stage" };
  if (session.pipelineToken !== run.token) return { ok: false, reason: "token" };
  return { ok: true, session };
}

/** ONE locked mutation with the full revalidation predicate; nothing is written on mismatch. */
async function guardedMutate<T>(
  run: RunContext,
  expected: Stage | undefined,
  body: (state: KanbanState, session: Session) => Promise<T>,
): Promise<Guarded<T>> {
  const outcome = await mutateAsync(run.ctx.cwd, async (state) => {
    const checked = revalidate(state, run, expected);
    if (!checked.ok) return checked;
    return { ok: true as const, value: await body(state, checked.session) };
  });
  if (!outcome.value.ok) return outcome.value;
  return { ok: true, value: outcome.value.value, state: outcome.state };
}

function stopDetail(reason: StopReason): string | undefined {
  if (reason === "aborted" || reason === "token") return undefined;
  return reason === "missing"
    ? "the session is no longer on the board"
    : reason === "blocked"
      ? "the session is paused; unpause it and run /kanban open to resume"
      : reason === "manual"
        ? "the session moved to manual mode; run /kanban open to continue it yourself"
        : "the session moved to a different stage";
}

/** Stage-boundary stop: no stage result was pending, so nothing could be dropped. */
function notifyBoundaryStop(run: RunContext, reason: StopReason): void {
  const detail = stopDetail(reason);
  if (!detail) return;
  run.ctx.ui.notify(
    `Kanban pipeline for “${run.title}” stopped: ${detail}.`,
    "info",
  );
}

/** A child result was ready but the commit predicate failed: the result is dropped. */
function notifyStop(run: RunContext, stage: Stage, reason: StopReason): void {
  const detail = stopDetail(reason);
  if (!detail) return;
  run.ctx.ui.notify(
    `Kanban pipeline for “${run.title}” stopped at the ${stage} stage: ${detail}. Nothing was recorded.`,
    "info",
  );
}

function status(run: RunContext, line: string | undefined): void {
  // A replaced run must never overwrite or clear its successor's status.
  if (runs.get(run.title)?.controller.signal !== run.signal) return;
  run.ctx.ui.setStatus(STATUS_KEY, line);
}

function resolveModel(
  ctx: ExtensionContext,
  config: KanbanConfig,
  key: StageModelKey,
): { ok: true; model: Model<any>; name: string } | { ok: false; name: string; error: string } {
  const spec = config.models[key];
  if (spec) {
    const separator = spec.indexOf(":");
    const provider = separator > 0 ? spec.slice(0, separator).trim() : "";
    const id = separator > 0 ? spec.slice(separator + 1).trim() : "";
    const model = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
    if (model) return { ok: true, model, name: `${model.provider}:${model.id}` };
    return {
      ok: false,
      name: spec,
      error: `configured ${key} model “${spec}” did not resolve in this Pi session`,
    };
  }
  const parent = ctx.model;
  if (parent)
    return { ok: true, model: parent, name: `${parent.provider}:${parent.id}` };
  return {
    ok: false,
    name: "unset",
    error: `no model is selected for the ${key} stage`,
  };
}

interface ChildOutcome {
  result: ChildResult;
  modelName: string;
}

function childFailed(result: ChildResult): boolean {
  return result.aborted || Boolean(result.errorKind) || !result.text.trim();
}

async function runStageChild(
  ctx: ExtensionContext,
  deps: OrchestratorDeps,
  options: {
    stage: Stage;
    modelKey: StageModelKey;
    prompt: string;
    signal: AbortSignal;
    label: string;
    /** Overrides ctx.cwd — the implement loop runs each child inside its iteration worktree. */
    cwd?: string;
    /** Overrides the read-only CHILD_TOOLS — the implement loop passes the write set. */
    tools?: readonly string[];
    onStatus?: (line: string) => void;
    timeoutMs?: number;
  },
): Promise<ChildOutcome> {
  const resolved = resolveModel(ctx, deps.config, options.modelKey);
  if (!resolved.ok)
    return {
      modelName: resolved.name,
      result: { text: "", aborted: false, errorKind: "model", error: resolved.error },
    };
  const controller = new AbortController();
  const signal = options.timeoutMs
    ? AbortSignal.any([options.signal, controller.signal])
    : options.signal;
  beginChildUsage(options.signal, signal, options.stage, options.label, resolved.model);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (options.timeoutMs) {
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
    timeout.unref();
  }
  let stopWaiting: (() => void) | undefined;
  try {
    const cancelled = new Promise<ChildResult>((resolve) => {
      stopWaiting = () => resolve({ text: "", aborted: true, errorKind: "aborted" });
      signal.addEventListener("abort", stopWaiting, { once: true });
      if (signal.aborted) stopWaiting();
    });
    const child = deps.runChild({
      cwd: options.cwd ?? ctx.cwd,
      prompt: options.prompt,
      systemPrompt: stageSystemPrompt(options.stage),
      model: resolved.model,
      tools: [...(options.tools ?? CHILD_TOOLS)],
      signal,
      onStatus: (line) => {
        if (signal.aborted) return;
        if (options.onStatus) options.onStatus(line);
        else ctx.ui.setStatus(STATUS_KEY, `kanban ${options.label}: ${line}`);
      },
    });
    const result = options.timeoutMs ? await Promise.race([child, cancelled]) : await child;
    if (timedOut && !options.signal.aborted)
      return { modelName: resolved.name, result: { text: "", aborted: false, errorKind: "other", error: `child timed out after ${options.timeoutMs! / 1000}s; adjust pipeline.childTimeoutMs or reduce research.depth / compose.detail` } };
    return { result, modelName: resolved.name };
  } catch (error: unknown) {
    return {
      modelName: resolved.name,
      result: {
        text: "",
        aborted: options.signal.aborted,
        errorKind: options.signal.aborted ? "aborted" : "other",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    finishChildUsage(signal);
    if (timeout) clearTimeout(timeout);
    if (stopWaiting) signal.removeEventListener("abort", stopWaiting);
  }
}

/** Child completion is a roster milestone, never a per-tool state write. */
async function finishChild(run: RunContext, stage: Stage, name: string, failed: boolean): Promise<void> {
  run.progress?.finish(name, failed);
  const updated = await guardedMutate(run, stage, async (_state, session) => {
    const agent = session.agents.find((item) => item.name === `${CHILD_AGENT_PREFIX}${name}`);
    if (agent) agent.status = "idle";
    await syncPlan(run.ctx.cwd, session);
  });
  if (updated.ok) await refreshWidget(run.ctx, updated.state);
}

/** D5: durable flip to manual mode (locked, revalidated) + notify with errorKind and model. */
async function flipToManual(
  run: RunContext,
  stage: Stage,
  failure: { errorKind: ErrorKind; error?: string; modelName: string },
): Promise<void> {
  const flipped = await guardedMutate(run, stage, async (_state, session) => {
    session.mode = "manual";
    delete session.pipelineToken;
    session.updatedAt = new Date().toISOString();
    replaceAgents(session, withoutChildAgents(session));
    await syncPlan(run.ctx.cwd, session);
    return session;
  });
  if (!flipped.ok) {
    notifyStop(run, stage, flipped.reason);
    return;
  }
  await refreshWidget(run.ctx, flipped.state);
  run.ctx.ui.notify(
    `Kanban ${stage} child failed (${failure.errorKind}${failure.error ? `: ${failure.error}` : ""}) using model ${failure.modelName}. “${run.title}” switched to manual mode — run /kanban open to continue it yourself.`,
    "error",
  );
}

/** Roster update so the widget shows the running children; children start only after it commits. */
async function announceChildren(
  run: RunContext,
  stage: Stage,
  agents: AgentRecord[],
): Promise<boolean> {
  const announced = await guardedMutate(run, stage, async (_state, session) => {
    replaceAgents(session, [...withoutChildAgents(session), ...agents]);
    await syncPlan(run.ctx.cwd, session);
    return session;
  });
  if (!announced.ok) {
    notifyStop(run, stage, announced.reason);
    return false;
  }
  await refreshWidget(run.ctx, announced.state);
  return true;
}

/**
 * The one locked commit per child stage: revalidate, write the section INSIDE the lock, and
 * advance exactly one stage. On mismatch nothing is written at all.
 */
async function commitStage(
  run: RunContext,
  stage: Stage,
  body: string,
  patch?: (plan: PlanSnapshot) => PlanSnapshot,
): Promise<Guarded<Session>> {
  const committed = await guardedMutate(run, stage, async (state, session) => {
    await writeWorkfileSection(run.ctx.cwd, workfileBase(session.planPath), stage, body);
    advanceStage(state, session);
    replaceAgents(session, withoutChildAgents(session));
    await syncPlan(run.ctx.cwd, session, patch);
    return session;
  });
  if (!committed.ok) notifyStop(run, stage, committed.reason);
  else await refreshWidget(run.ctx, committed.state);
  return committed;
}

async function readSections(
  cwd: string,
  planPath: string,
): Promise<Partial<Record<Stage, string>>> {
  try {
    return (await readWorkfile(cwd, workfileBase(planPath))).sections;
  } catch {
    return {};
  }
}

interface StageContext {
  session: Session;
  prompt: string;
  sections: Partial<Record<Stage, string>>;
}

async function stageContext(run: RunContext, session: Session): Promise<StageContext> {
  const [plan, sections] = await Promise.all([
    readPlan(run.ctx.cwd, session.planPath),
    readSections(run.ctx.cwd, session.planPath),
  ]);
  return { session, prompt: plan?.prompt?.trim() || session.title, sections };
}

/** Runs one single-child stage end to end; undefined ⇒ the run must stop. */
async function runSingleChildStage(
  run: RunContext,
  session: Session,
  stage: "refine" | "grill" | "compose",
  extra: { grillAnswers?: string } = {},
): Promise<ParsedStageOutput | undefined> {
  const context = await stageContext(run, session);
  if (!(await announceChildren(run, stage, [childAgent(`${stage} child`, `${stage} stage`)])))
    return undefined;
  const label = `${stage} child`;
  run.progress?.start(label);
  const outcome = await runStageChild(run.ctx, run.deps, {
    stage,
    modelKey: stage,
    label: stage,
    signal: run.signal,
    timeoutMs: run.deps.config.pipeline?.childTimeoutMs ?? 300_000,
    onStatus: (line) => run.progress?.activity(label, line),
    prompt: stagePrompt(stage, {
      prompt: context.prompt,
      title: run.title,
      sections: context.sections,
      composeDetail: run.deps.config.compose?.detail ?? "plan",
      ...extra,
    }),
  });
  await finishChild(run, stage, label, childFailed(outcome.result));
  if (childFailed(outcome.result)) {
    if (outcome.result.aborted || run.signal.aborted) return undefined;
    await flipToManual(run, stage, {
      errorKind: outcome.result.errorKind ?? "other",
      error: outcome.result.error,
      modelName: outcome.modelName,
    });
    return undefined;
  }
  return parseStageOutput(stage, outcome.result.text);
}

function fastPathNote(): string {
  return "Skipped by the fast path: the refine stage returned `Verdict: simple` and the Kanban fastPath setting is enabled.";
}

/** `complexity` is an additive optional PlanSnapshot field (D10). */
function recordComplexity(
  plan: PlanSnapshot,
  verdict: "simple" | "standard" | undefined,
): PlanSnapshot {
  return verdict ? ({ ...plan, complexity: verdict } as PlanSnapshot) : plan;
}

async function driveRefine(run: RunContext, session: Session): Promise<boolean> {
  const parsed = await runSingleChildStage(run, session, "refine");
  if (!parsed) return false;
  const simple = parsed.verdict === "simple" && run.deps.config.fastPath;
  const justification = simple
    ? `Fast path: refine returned \`Verdict: simple\`, so research and grill were skipped for “${run.title}”.`
    : undefined;
  const committed = await commitStage(run, "refine", parsed.body, (plan) => ({
    ...recordComplexity(plan, parsed.verdict),
    ...(justification
      ? { work: { ...plan.work, done: [...plan.work.done, justification] } }
      : {}),
  }));
  if (!committed.ok) return false;
  if (!simple) return true;
  for (const skipped of ["research", "grill"] as const) {
    const skip = await commitStage(run, skipped, fastPathNote());
    if (!skip.ok) return false;
  }
  return true;
}

async function driveResearch(run: RunContext, session: Session): Promise<boolean> {
  const context = await stageContext(run, session);
  const workers = Math.min(
    RESEARCH_ANGLE_LABELS.length,
    Math.max(1, run.deps.config.research.workers),
  );
  const groups: Array<Array<1 | 2 | 3>> = workers === 1 ? [[1, 2, 3]]
    : workers === 2 ? [[1, 2], [3]] : [[1], [2], [3]];
  const labels = groups.map((angles) => `research angle ${angles.join("+")}`);
  if (
    !(await announceChildren(
      run,
      "research",
      groups.map((angles, index) =>
        childAgent(labels[index]!, angles.map((angle) => RESEARCH_ANGLE_LABELS[angle - 1]).join("; ")),
      ),
    ))
  )
    return false;
  for (const label of labels) run.progress?.start(label);
  const settled = await Promise.allSettled(
    groups.map(async (angles, index) => {
      const label = labels[index]!;
      const outcome = await runStageChild(run.ctx, run.deps, {
        stage: "research",
        modelKey: "research",
        label,
        signal: run.signal,
        timeoutMs: run.deps.config.pipeline?.childTimeoutMs ?? 300_000,
        onStatus: (line) => run.progress?.activity(label, line),
        prompt: stagePrompt("research", {
          prompt: context.prompt,
          title: run.title,
          sections: context.sections,
          ...(angles.length === 1 ? { researchAngle: angles[0] } : { researchAngles: angles }),
          researchDepth: run.deps.config.research.depth ?? "focused",
        }),
      });
      await finishChild(run, "research", label, childFailed(outcome.result));
      return outcome;
    }),
  );

  const parts: string[] = [];
  let succeeded = 0;
  let aborted = false;
  let failure: { errorKind: ErrorKind; error?: string; modelName: string } | undefined;
  for (const [index, angles] of groups.entries()) {
    const label = `### Angle ${angles.join("+")} — ${angles.map((angle) => RESEARCH_ANGLE_LABELS[angle - 1]).join("; ")}`;
    const item = settled[index]!;
    if (item.status === "rejected") {
      failure ??= {
        errorKind: "other",
        error: String(item.reason),
        modelName: "unknown",
      };
      parts.push(`${label}\n\nWorker failed (other): ${String(item.reason)}.`);
      continue;
    }
    const { result, modelName } = item.value;
    if (childFailed(result)) {
      if (result.aborted) aborted = true;
      else
        failure ??= {
          errorKind: result.errorKind ?? "other",
          error: result.error,
          modelName,
        };
      parts.push(
        `${label}\n\nWorker failed (${result.aborted ? "aborted" : (result.errorKind ?? "other")})${result.error ? `: ${result.error}` : ""}. This angle is not covered.`,
      );
      continue;
    }
    succeeded += 1;
    parts.push(`${label}\n\n${parseStageOutput("research", result.text).body}`);
  }

  if (!succeeded) {
    if (aborted || run.signal.aborted) return false;
    await flipToManual(
      run,
      "research",
      failure ?? { errorKind: "other", error: "every research worker failed", modelName: "unknown" },
    );
    return false;
  }
  if (succeeded < groups.length && !run.signal.aborted)
    run.ctx.ui.notify(`Kanban research: ${succeeded}/${groups.length} workers succeeded; missing coverage is recorded for grill and compose.`, "warning");
  const committed = await commitStage(run, "research", parts.join("\n\n"));
  return committed.ok;
}

const ANSWER_DIFFERENTLY = "Answer differently…";
const SKIP_QUESTION = "Skip (record assumption)";

async function collectGrillAnswers(
  run: RunContext,
  questions: GrillQuestion[],
): Promise<{ text: string; aborted: boolean }> {
  const lines: string[] = [];
  for (const [index, question] of questions.entries()) {
    run.progress?.question(index + 1, questions.length);
    if (run.signal.aborted) return { text: lines.join("\n"), aborted: true };
    lines.push(`Q: ${question.q}`);
    if (!run.ctx.hasUI) {
      lines.push(`A: ASSUMED: ${question.recommended}`, "");
      continue;
    }
    const alternatives = [...(question.options ?? [])];
    // Preserve legacy Q:/Recommended: output without inventing alternative answers.
    if (!alternatives.some((option) => option.label === question.recommended))
      alternatives.unshift({ label: question.recommended, description: "" });
    const ordered = [...alternatives].sort((a, b) => Number(b.label === question.recommended) - Number(a.label === question.recommended));
    const displays = ordered.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}${option.label === question.recommended ? " (Recommended)" : ""}${option.description ? `\n   ${option.description}` : ""}`);
    const choice = await run.ctx.ui.select(
      `Grill ${index + 1}/${questions.length}: ${question.q}`,
      [...displays, SKIP_QUESTION, ANSWER_DIFFERENTLY],
      { signal: run.signal },
    );
    if (run.signal.aborted) return { text: lines.join("\n"), aborted: true };
    if (choice === undefined || choice === SKIP_QUESTION) {
      lines.push(`A: ASSUMED: ${question.recommended}`, "");
      continue;
    }
    if (choice === ANSWER_DIFFERENTLY) {
      const typed = await run.ctx.ui.input(question.q, question.recommended, {
        signal: run.signal,
      });
      if (run.signal.aborted) return { text: lines.join("\n"), aborted: true };
      lines.push(
        typed?.trim() ? `A: ${typed.trim()}` : `A: ASSUMED: ${question.recommended}`,
        "",
      );
      continue;
    }
    const selected = ordered[displays.indexOf(choice)];
    lines.push(selected
      ? `A: ${selected.label}${selected.description ? ` — ${selected.description}` : ""}`
      : `A: ASSUMED: ${question.recommended}`, "");
  }
  return { text: lines.join("\n").trim(), aborted: false };
}

async function driveGrill(
  run: RunContext,
  session: Session,
): Promise<{ ok: boolean; answers?: string }> {
  const parsed = await runSingleChildStage(run, session, "grill");
  if (!parsed) return { ok: false };
  const questions = parsed.questions ?? [];
  if (!questions.length && !/^\s*Questions:\s*none\s*$/im.test(parsed.body))
    run.ctx.ui.notify(
      `Kanban grill for “${run.title}” produced no parseable Q:/Recommended: pairs; its findings were recorded without a user walkthrough.`,
      "warning",
    );
  const collected = await collectGrillAnswers(run, questions);
  if (collected.aborted) return { ok: false };
  const body = collected.text
    ? `${parsed.body}\n\n### Answers recorded by the pipeline\n\n${collected.text}`
    : parsed.body;
  const committed = await commitStage(run, "grill", body);
  return { ok: committed.ok, answers: collected.text || undefined };
}

async function driveCompose(
  run: RunContext,
  session: Session,
  grillAnswers: string | undefined,
): Promise<boolean> {
  const parsed = await runSingleChildStage(run, session, "compose", { grillAnswers });
  if (!parsed) return false;
  const lines = parsed.body.split(/\r?\n/).length + 1;
  if (lines > 300) {
    await flipToManual(run, "compose", {
      errorKind: "other", modelName: resolveModel(run.ctx, run.deps.config, "compose").name,
      error: `compose plan has ${lines} lines; maximum is 300 including its heading. Shorten the plan before implementation; no truncated plan was published`,
    });
    return false;
  }
  const committed = await commitStage(run, "compose", parsed.body);
  if (!committed.ok) return false;
  run.ctx.ui.notify(
    `Kanban pipeline composed the spec for “${run.title}”. Review it with /kanban plan. Run /kanban open (or press Enter on the session in /kanban) to start implementation.`,
    "info",
  );
  return true;
}

async function runPipeline(run: RunContext, entry: RunEntry): Promise<void> {
  try {
    let grillAnswers: string | undefined;
    for (;;) {
      if (run.signal.aborted) return;
      const state = await load(run.ctx.cwd);
      const checked = revalidate(state, run, undefined);
      if (!checked.ok) {
        notifyBoundaryStop(run, checked.reason);
        return;
      }
      const session = checked.session;
      if (!CHILD_STAGES.includes(session.stage)) return;
      const next = { refine: "research", research: "grill", grill: "compose", compose: "implement" }[session.stage as "refine" | "research" | "grill" | "compose"];
      const timingKey = JSON.stringify([run.ctx.cwd, session.stage, run.deps.config.models[session.stage] ?? `${run.ctx.model?.provider}:${run.ctx.model?.id}`, run.deps.config.research, run.deps.config.compose]);
      const progress = new PipelineProgress(session.stage, next, timingKey,
        run.deps.config.pipeline?.childTimeoutMs ?? 300_000, (line) => status(run, line));
      run.progress = progress;
      const stopProgress = () => progress.stop(false);
      run.signal.addEventListener("abort", stopProgress, { once: true });
      let succeeded = false;
      try {
        if (session.stage === "refine") {
          succeeded = await driveRefine(run, session);
        } else if (session.stage === "research") {
          succeeded = await driveResearch(run, session);
        } else if (session.stage === "grill") {
          const outcome = await driveGrill(run, session);
          succeeded = outcome.ok;
          grillAnswers = outcome.answers;
        } else {
          succeeded = await driveCompose(run, session, grillAnswers);
          return;
        }
        if (!succeeded) return;
      } finally {
        progress.stop(succeeded);
        run.signal.removeEventListener("abort", stopProgress);
      }
    }
  } finally {
    endUsage(run.signal);
    status(run, undefined);
    unregister(run.title, entry);
  }
}

type MintOutcome =
  | { ok: true; state: KanbanState; session: Session }
  | { ok: false; message: string; kind: "info" | "error" };

/**
 * `allowed` is the set of stages a run may be minted at: CHILD_STAGES for the pipeline, and
 * `["implement"]` for the orchestrator-owned implement loop (plan v2.5 §4, an explicit
 * AGENTS.md:41 change).
 */
async function mintPipelineToken(
  ctx: ExtensionCommandContext,
  title: string,
  token: string,
  allowed: Stage[],
): Promise<MintOutcome> {
  const minted = await mutateAsync(ctx.cwd, async (state) => {
    const session = state.sessions.find((item) => item.title === title);
    if (!session)
      return {
        ok: false as const,
        kind: "error" as const,
        message: `Kanban session “${title}” is no longer active.`,
      };
    if (session.state !== "active")
      return {
        ok: false as const,
        kind: "info" as const,
        message: `Kanban session “${title}” is paused. Use /kanban unpause first.`,
      };
    if ((session.mode ?? "manual") !== "pipeline")
      return {
        ok: false as const,
        kind: "info" as const,
        message: `Kanban session “${title}” runs in manual mode; continue it in this conversation.`,
      };
    if (!allowed.includes(session.stage))
      return {
        ok: false as const,
        kind: "info" as const,
        message: allowed.includes("implement")
          ? `Kanban session “${title}” is at the ${session.stage} stage; the implement loop runs only at the implement stage.`
          : `Kanban session “${title}” is at the ${session.stage} stage; the pipeline has nothing left to run.`,
      };
    session.pipelineToken = token;
    session.updatedAt = new Date().toISOString();
    replaceAgents(session, withoutChildAgents(session));
    await syncPlan(ctx.cwd, session);
    return { ok: true as const, session };
  });
  if (!minted.value.ok) return minted.value;
  return { ok: true, state: minted.state, session: minted.value.session };
}

/**
 * Drive the child-owned stages of the selected session's pipeline (refine → [fast path]
 * research fan-out → grill → compose), committing one stage at a time under the repository
 * lock with full revalidation (title, active, pipeline mode, expected stage, pipelineToken,
 * !signal.aborted). Children always run with no lock held.
 *
 * FIRE-AND-FORGET: command handlers call this and return once the run is registered; the
 * detached run reports failures via ctx.ui.notify.
 */
export async function startPipeline(
  ctx: ExtensionCommandContext,
  title: string,
  deps: OrchestratorDeps,
): Promise<void> {
  const other = [...runs.keys()].find((key) => key !== title);
  if (other !== undefined) {
    ctx.ui.notify(
      `A Kanban pipeline is already running for “${other}”. Pause it or let it finish first.`,
      "info",
    );
    return;
  }
  // A live run for this title is aborted and unregistered BEFORE the new token is minted.
  abortPipelineFor(title);
  const token = randomUUID();
  const minted = await mintPipelineToken(ctx, title, token, CHILD_STAGES);
  if (!minted.ok) {
    ctx.ui.notify(minted.message, minted.kind);
    return;
  }
  await refreshWidget(ctx, minted.state);
  const entry: RunEntry = { controller: new AbortController(), clearStatus: () => ctx.ui.setStatus(STATUS_KEY, undefined) };
  runs.set(title, entry);
  beginUsage(ctx.cwd, title, entry.controller.signal);
  const stopUsageDisplay = startUsageDisplay(ctx, entry.controller.signal);
  const run: RunContext = {
    ctx,
    title,
    token,
    deps,
    signal: entry.controller.signal,
  };
  entry.promise = runPipeline(run, entry).catch((error: unknown) => {
    unregister(title, entry);
    ctx.ui.notify(
      `Kanban pipeline for “${title}” stopped: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }).finally(stopUsageDisplay);
  // Single-shot (`pi -p "/kanban create …"`): print/json mode disposes the runtime as soon as
  // the command returns, so an armed-but-unawaited pipeline would be killed mid-stage. An
  // interactive session must not block here — the pipeline reports into that conversation.
  if (isSingleShot(ctx)) await entry.promise;
}

/* ------------------------------------------------------------------------------------------ *
 * The implement-loop seam (plan v2.5 §4/§5).
 *
 * The loop ALGORITHM lives in src/implementloop.ts; the orchestrator keeps ownership of run
 * identity: the title-keyed abort registry, the pipelineToken CAS, the locked one-stage commit
 * and the child-session plumbing. The loop only ever touches state through this handle, so it
 * cannot advance a stage or write a workfile section outside the revalidated locked commit.
 * ------------------------------------------------------------------------------------------ */

export interface LoopRunDeps {
  /** FORCED in-process backend (plan §4.2); never selectRunner. */
  runChild: RunChild;
  config: KanbanConfig;
}

export interface LoopChildOptions {
  prompt: string;
  /** The iteration worktree — never the user's tree. */
  cwd: string;
  tools: readonly string[];
  label: string;
}

export interface LoopRunHandle {
  readonly ctx: ExtensionCommandContext;
  readonly title: string;
  readonly token: string;
  readonly signal: AbortSignal;
  /** Read-only revalidation: the pre-land CAS and the per-iteration boundary check. */
  check(
    expected: Stage | undefined,
  ): Promise<{ ok: true; session: Session } | { ok: false; reason: StopReason }>;
  /** ONE locked, revalidated mutation. */
  mutate<T>(
    expected: Stage | undefined,
    body: (state: KanbanState, session: Session) => Promise<T>,
  ): Promise<Guarded<T>>;
  /** The one locked commit that writes the section and advances exactly one stage. */
  commit(
    stage: Stage,
    body: string,
    patch?: (plan: PlanSnapshot) => PlanSnapshot,
  ): Promise<Guarded<Session>>;
  /** Roster update so the widget shows the running iteration child. */
  agents(stage: Stage, agents: AgentRecord[]): Promise<boolean>;
  child(options: LoopChildOptions): Promise<ChildOutcome>;
  /** Loop progress goes to the status line, never to a 5th widget row (AGENTS.md:37). */
  status(line: string | undefined): void;
  notify(message: string, kind: "info" | "warning" | "error"): void;
  /** Publish the detached run promise so tests can await it. */
  track(promise: Promise<void>): void;
  /** Clear the status line and unregister the run (ABA-guarded). */
  release(): void;
  childAgent(name: string, role: string): AgentRecord;
  boundaryStop(reason: StopReason): void;
  commitStop(stage: Stage, reason: StopReason): void;
}

export type LoopArmOutcome =
  | { ok: true; handle: LoopRunHandle }
  | { ok: false; message: string; kind: "info" | "error" };

/**
 * Arm an orchestrator-owned implement-loop run: refuse when ANY live run exists in this
 * process (one loop per process), then mint a fresh pipelineToken at the implement stage and
 * register the abort channel under the title, so open/rename/remove/pause/session_shutdown
 * abort the loop for free.
 */
export async function armImplementLoop(
  ctx: ExtensionCommandContext,
  title: string,
  deps: LoopRunDeps,
): Promise<LoopArmOutcome> {
  const live = [...runs.keys()][0];
  if (live !== undefined)
    return {
      ok: false,
      kind: "info",
      message:
        live === title
          ? `A Kanban run is already live for “${title}”. Stop it with /kanban implement stop first.`
          : `A Kanban pipeline is already running for “${live}”. Pause it or let it finish first.`,
    };
  const token = randomUUID();
  const minted = await mintPipelineToken(ctx, title, token, ["implement"]);
  if (!minted.ok) return { ok: false, message: minted.message, kind: minted.kind };
  await refreshWidget(ctx, minted.state);

  const entry: RunEntry = { controller: new AbortController(), clearStatus: () => ctx.ui.setStatus(STATUS_KEY, undefined) };
  runs.set(title, entry);
  beginUsage(ctx.cwd, title, entry.controller.signal);
  const stopUsageDisplay = startUsageDisplay(ctx, entry.controller.signal);
  const run: RunContext = {
    ctx,
    title,
    token,
    signal: entry.controller.signal,
    // The loop never opens a conversation; the field exists so the shared RunContext type
    // stays one type. Calling it would violate AGENTS.md:46 and is asserted against in tests.
    deps: {
      ...deps,
      openImplementConversation: async () => {
        throw new Error("the implement loop never opens a conversation");
      },
    },
  };
  return {
    ok: true,
    handle: {
      ctx,
      title,
      token,
      signal: entry.controller.signal,
      check: async (expected) => revalidate(await load(ctx.cwd), run, expected),
      mutate: (expected, body) => guardedMutate(run, expected, body),
      commit: (stage, body, patch) => commitStage(run, stage, body, patch),
      agents: (stage, agents) => announceChildren(run, stage, agents),
      child: async (options) => {
        updateLoopProgress(run.signal, { childRunning: true, activity: options.label, output: "" });
        const outcome = await runStageChild(ctx, run.deps, {
          stage: "implement",
          modelKey: "implement",
          prompt: options.prompt,
          signal: run.signal,
          label: options.label,
          cwd: options.cwd,
          tools: options.tools,
          onStatus: (line) => updateLoopProgress(run.signal, { activity: `${options.label}: ${line}` }),
        });
        updateLoopProgress(run.signal, { childRunning: false, activity: "child finished; capturing candidate" });
        appendLiveOutput(run.signal, `\n[Final child output]\n${outcome.result.text}\n`);
        return outcome;
      },
      status: (line) => {
        if (line) updateLoopProgress(run.signal, { activity: line });
        status(run, line);
      },
      notify: (message, kind) => ctx.ui.notify(message, kind),
      track: (promise) => {
        entry.promise = promise;
      },
      release: () => {
        endUsage(run.signal);
        stopUsageDisplay();
        endLoopProgress(run.signal);
        status(run, undefined);
        unregister(title, entry);
      },
      childAgent,
      boundaryStop: (reason) => notifyBoundaryStop(run, reason),
      commitStop: (stage, reason) => notifyStop(run, stage, reason),
    },
  };
}

/** Shared with the loop driver: aborted / errored / empty child output. */
export function loopChildFailed(result: ChildResult): boolean {
  return childFailed(result);
}

export type { ChildOutcome };

export interface CritiqueGateDeps {
  runChild: RunChild;
  config: KanbanConfig;
  /** Tool-computed, bounded diff. */
  diff: string;
  /** The tool's execute signal — bridged into the gate child. */
  signal: AbortSignal;
  /** The tool's onUpdate — streams gate progress. */
  onUpdate?: (line: string) => void;
}

export interface GateOutcome {
  kind: "pass" | "fail" | "child-failed" | "aborted";
  issues: string[];
  /** Parsed `## critique` body — the W4 tool records it as the workfile section. */
  body: string;
  /** Set when kind === "child-failed" — the tool persists it into plan.gateFailure. */
  errorKind?: ErrorKind;
  error?: string;
}

/**
 * Run the critique gate child: resolves models.critique itself, registers the child's
 * controller in the title-keyed abort registry for its duration, runs lock-free, parses
 * `Gate: PASS|FAIL` + issue bullets. The W4 tool computes the diff, calls this, and owns
 * all state mutations that follow.
 */
export async function runCritiqueGate(
  ctx: ExtensionContext,
  session: Session,
  deps: CritiqueGateDeps,
): Promise<GateOutcome> {
  if (deps.signal.aborted) return { kind: "aborted", issues: [], body: "" };
  const resolved = resolveModel(ctx, deps.config, "critique");
  if (!resolved.ok)
    return {
      kind: "child-failed",
      issues: [],
      body: "",
      errorKind: "model",
      error: resolved.error,
    };
  const entry: RunEntry = { controller: new AbortController() };
  const bridge = () => entry.controller.abort();
  deps.signal.addEventListener("abort", bridge, { once: true });
  runs.set(session.title, entry);
  beginUsage(ctx.cwd, session.title, entry.controller.signal);
  beginChildUsage(entry.controller.signal, entry.controller.signal, "critique", "critique child", resolved.model);
  const stopUsageDisplay = startUsageDisplay(ctx, entry.controller.signal);
  try {
    const [plan, sections] = await Promise.all([
      readPlan(ctx.cwd, session.planPath),
      readSections(ctx.cwd, session.planPath),
    ]);
    const result = await deps.runChild({
      cwd: ctx.cwd,
      prompt: stagePrompt("critique", {
        prompt: plan?.prompt?.trim() || session.title,
        title: session.title,
        sections,
        diff: deps.diff,
      }),
      systemPrompt: stageSystemPrompt("critique"),
      model: resolved.model,
      tools: [...CHILD_TOOLS],
      signal: entry.controller.signal,
      ...(deps.onUpdate ? { onStatus: deps.onUpdate } : {}),
    });
    if (result.aborted || entry.controller.signal.aborted)
      return { kind: "aborted", issues: [], body: "" };
    if (childFailed(result))
      return {
        kind: "child-failed",
        issues: [],
        body: "",
        errorKind: result.errorKind ?? "other",
        ...(result.error ? { error: result.error } : {}),
      };
    const parsed = parseStageOutput("critique", result.text);
    return {
      kind: parsed.gate === "pass" ? "pass" : "fail",
      issues: parsed.gate === "pass" ? [] : (parsed.issues ?? []),
      body: parsed.body,
    };
  } catch (error: unknown) {
    if (entry.controller.signal.aborted) return { kind: "aborted", issues: [], body: "" };
    return {
      kind: "child-failed",
      issues: [],
      body: "",
      errorKind: "other",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    finishChildUsage(entry.controller.signal);
    endUsage(entry.controller.signal);
    stopUsageDisplay();
    deps.signal.removeEventListener("abort", bridge);
    unregister(session.title, entry);
  }
}
