import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  buildHandoff,
  buildIdleHandoff,
  emptyPlan,
  readHandoff,
  readPlan,
  writeHandoff,
  writePlan,
  type PlanSnapshot,
  type WorkSummary,
} from "./artifacts.js";
import { detectExternalTools } from "./capabilities.js";
import { loadConfig, type KanbanConfig } from "./config.js";
import {
  abortPipelineFor,
  clearPipelineRegistry,
  runCritiqueGate,
  startPipeline,
  type OrchestratorDeps,
} from "./orchestrator.js";
import {
  completionText,
  implementKickoff,
  parseStageOutput,
  stagePrompt,
} from "./prompts.js";
import { selectRunner } from "./runner.js";
import {
  advanceStage,
  createSession,
  initialize,
  kanbanPaths,
  load,
  mutate,
  mutateAsync,
  removeSession,
  renameSession,
  replaceAgents,
  requireSelectedSession,
  setSelectedSession,
  setSessionState,
  type AgentRecord,
  type KanbanState,
  type Session,
  type SessionState,
  type Stage,
} from "./store.js";
import { refreshWidget, showDashboard } from "./ui.js";
import {
  deleteWorkfile,
  readWorkfile,
  sweepOrphanWorkfiles,
  workfileBase,
} from "./workfile.js";

const TOOL = "kanban_update";
const CONFIRM_TIMEOUT_MS = 120_000;
const DIFF_MAX_LINES = 3000;
const CRITIQUE_ATTEMPT_CAP = 2;
const PIPELINE_STAGES: Stage[] = ["refine", "research", "grill", "compose"];

const execFileAsync = promisify(execFile);

interface CheckpointInput {
  action: "checkpoint" | "stage_complete";
  inScope?: string[];
  outOfScope?: string[];
  agents?: AgentRecord[];
  work?: Partial<WorkSummary>;
  handoff?: string;
  rerunCritique?: boolean;
  acceptRemainingIssues?: boolean;
  critiqueSummary?: string;
}

const AgentSchema = Type.Object({
  name: Type.String(),
  role: Type.String(),
  status: StringEnum(["working", "idle", "blocked"] as const),
});
const WorkSchema = Type.Object({
  done: Type.Optional(Type.Array(Type.String())),
  current: Type.Optional(Type.Array(Type.String())),
  next: Type.Optional(Type.Array(Type.String())),
});

function fallbackTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return (words || "Kanban session").slice(0, 72);
}

function normalizeGeneratedTitle(text: string): string | undefined {
  const firstLine = text
    .split(/\r?\n/, 1)[0]
    ?.replace(/^\s*(?:title\s*:\s*)?/i, "")
    .replace(/["'`]/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (!firstLine) return undefined;
  const title = firstLine.split(/\s+/).slice(0, 6).join(" ").slice(0, 72);
  return title || undefined;
}

async function generateTitle(
  ctx: ExtensionContext,
  prompt: string,
): Promise<string> {
  if (!ctx.model) return fallbackTitle(prompt);
  try {
    const response = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt:
        "Generate a concise Kanban session title. Reply with only a readable title of at most six words; do not use quotes, Markdown, or punctuation at the end.",
      messages: [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    });
    const title = response.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return normalizeGeneratedTitle(title) ?? fallbackTitle(prompt);
  } catch {
    return fallbackTitle(prompt);
  }
}

const warnedConfigDirs = new Set<string>();

async function configFor(ctx: ExtensionContext): Promise<KanbanConfig> {
  const loaded = await loadConfig(ctx.cwd);
  if (loaded.warnings.length && !warnedConfigDirs.has(ctx.cwd)) {
    warnedConfigDirs.add(ctx.cwd);
    ctx.ui.notify(`Kanban config: ${loaded.warnings.join("; ")}`, "warning");
  }
  return loaded.config;
}

function safeDetectExternalTools(pi: ExtensionAPI): string[] {
  try {
    return detectExternalTools(pi);
  } catch {
    return [];
  }
}

async function sections(
  cwd: string,
  session: Session,
): Promise<Partial<Record<Stage, string>>> {
  try {
    return (await readWorkfile(cwd, workfileBase(session.planPath))).sections;
  } catch {
    return {};
  }
}

async function stageInputsFor(cwd: string, session: Session) {
  const plan = await readPlan(cwd, session.planPath);
  return {
    prompt: plan?.prompt?.trim() || session.title,
    title: session.title,
    sections: await sections(cwd, session),
  };
}

function sessionMode(session: Session): "pipeline" | "manual" {
  return session.mode === "pipeline" ? "pipeline" : "manual";
}

async function computeDiff(cwd: string): Promise<string> {
  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const parts = [
    "### git status --short",
    (await run(["status", "--short"])) || "(clean)",
    "",
    "### git diff",
    (await run(["diff"])) || "(no unstaged changes)",
    "",
    "### git diff --cached",
    (await run(["diff", "--cached"])) || "(no staged changes)",
    "",
    "### untracked files",
    (await run(["ls-files", "--others", "--exclude-standard"])) || "(none)",
  ];
  const lines = parts.join("\n").split("\n");
  if (lines.length <= DIFF_MAX_LINES) return lines.join("\n");
  return [...lines.slice(0, DIFF_MAX_LINES), "[diff truncated]"].join("\n");
}

function checkpointHasContent(input: CheckpointInput): boolean {
  return Boolean(
    input.inScope ||
      input.outOfScope ||
      input.agents ||
      input.work ||
      input.handoff !== undefined,
  );
}

function mergePlan(
  existing: PlanSnapshot | undefined,
  session: Session,
  input: CheckpointInput,
  status: PlanSnapshot["status"] = session.state,
): PlanSnapshot {
  const plan = existing ?? emptyPlan(session, session.title);
  return {
    ...plan,
    title: session.title,
    stage: session.stage,
    status,
    agents: session.agents,
    ...(input.inScope ? { inScope: input.inScope } : {}),
    ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
    work: {
      ...plan.work,
      ...(input.work?.done ? { done: input.work.done } : {}),
      ...(input.work?.current ? { current: input.work.current } : {}),
      ...(input.work?.next ? { next: input.work.next } : {}),
    },
    updatedAt: session.updatedAt,
  };
}

async function writeCheckpointArtifacts(
  cwd: string,
  session: Session,
  input: CheckpointInput,
  status?: PlanSnapshot["status"],
  patch?: (plan: PlanSnapshot) => PlanSnapshot,
): Promise<void> {
  const current = await readPlan(cwd, session.planPath);
  const merged = mergePlan(current, session, input, status);
  await writePlan(cwd, session.planPath, patch ? patch(merged) : merged);
  if (input.handoff !== undefined)
    await writeHandoff(cwd, buildHandoff(input.handoff));
}

async function writeSessionPlan(
  cwd: string,
  session: Session,
  status: PlanSnapshot["status"] = session.state,
): Promise<void> {
  const plan = await readPlan(cwd, session.planPath);
  if (!plan) throw new Error(`plan is missing for Kanban session “${session.title}”`);
  await writePlan(cwd, session.planPath, {
    ...plan,
    title: session.title,
    stage: session.stage,
    status,
    agents: session.agents,
    updatedAt: session.updatedAt,
  });
}

function safePlanFile(cwd: string, session: Session): string {
  const board = resolve(kanbanPaths(cwd).root);
  const path = resolve(board, session.planPath);
  const withinBoard = relative(board, path);
  if (!withinBoard.startsWith("plans/") || withinBoard.startsWith("../"))
    throw new Error(`unsafe plan path for Kanban session “${session.title}”`);
  return path;
}

async function selectTitle(cwd: string, title: string): Promise<{
  state: KanbanState;
  session: Session;
}> {
  const selected = await mutate(cwd, (state) => setSelectedSession(state, title));
  return { state: selected.state, session: selected.value };
}

async function durableSeed(cwd: string, session: Session): Promise<string> {
  const [handoff, plan] = await Promise.all([
    readHandoff(cwd),
    readPlan(cwd, session.planPath),
  ]);
  return [
    `Open Kanban session “${session.title}”.`,
    "Kanban sessions are independent from Pi conversation files. A new Pi conversation is being started for this work.",
    "The global handoff below may describe a previously selected session. The current selected session and its plan are authoritative.",
    "",
    "Global handoff:",
    handoff || "Handoff artifact unavailable.",
    "",
    "Current session plan (authoritative):",
    JSON.stringify(plan ?? { planPath: session.planPath }, null, 2),
  ].join("\n");
}

/** Fresh-conversation contexts in tests are minimal stubs; only run the pipeline on a real one. */
function isCommandContext(value: unknown): value is ExtensionCommandContext {
  return Boolean(
    value &&
      typeof (value as ExtensionCommandContext).cwd === "string" &&
      typeof (value as ExtensionCommandContext).ui === "object",
  );
}

function pipelineDeps(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: KanbanConfig,
): OrchestratorDeps {
  return {
    runChild: selectRunner(config),
    config,
    openImplementConversation: (session, spec) =>
      openImplementConversation(pi, ctx, session, config, spec),
  };
}

/**
 * Open a fresh conversation seeded with the durable context. `kickoff` (when given) is sent
 * as the first user message; `afterSwitch` runs against the replacement context.
 */
async function startCleanConversation(
  ctx: ExtensionCommandContext,
  session: Session,
  options: {
    kickoff?: string;
    afterSwitch?: (fresh: ExtensionCommandContext) => Promise<void>;
  } = {},
): Promise<{ cancelled: boolean }> {
  const durableContext = await durableSeed(ctx.cwd, session);
  const result = await ctx.newSession({
    setup: async (manager) => {
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: durableContext }],
        timestamp: Date.now(),
      });
    },
    withSession: async (fresh) => {
      if (options.kickoff) await fresh.sendUserMessage(options.kickoff);
      if (options.afterSwitch && isCommandContext(fresh))
        await options.afterSwitch(fresh);
    },
  });
  if (result.cancelled)
    ctx.ui.notify(`Kanban session “${session.title}” is selected but was not opened.`, "info");
  return result;
}

async function openImplementConversation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  session: Session,
  config: KanbanConfig,
  spec: string | undefined,
): Promise<{ cancelled: boolean }> {
  return startCleanConversation(ctx, session, {
    kickoff: implementKickoff(config, safeDetectExternalTools(pi), spec),
  });
}

function manualCritiqueInstruction(): string {
  return "Critique stage: perform an adversarial review of the change against the plan and its validation evidence, then call kanban_update stage_complete with critiqueSummary (what was reviewed, the verdict, and any remaining issues).";
}

async function findActiveSession(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<Session | undefined> {
  const state = await load(ctx.cwd);
  const session = state.sessions.find((candidate) => candidate.title === title);
  if (!session)
    ctx.ui.notify(`Kanban session “${title}” is no longer active.`, "error");
  return session;
}

async function openSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  title: string,
): Promise<void> {
  const candidate = await findActiveSession(ctx, title);
  if (!candidate) return;
  if (candidate.state === "blocked") {
    ctx.ui.notify(`Kanban session “${candidate.title}” is paused. Use /kanban unpause first.`, "info");
    return;
  }
  // Any live run for this title (pipeline or critique gate) is aborted before reopening.
  abortPipelineFor(candidate.title);
  const selected = await selectTitle(ctx.cwd, candidate.title);
  await refreshWidget(ctx, selected.state);
  const session = selected.session;
  const config = await configFor(ctx);

  if (sessionMode(session) === "pipeline" && PIPELINE_STAGES.includes(session.stage)) {
    await startCleanConversation(ctx, session, {
      afterSwitch: async (fresh) => {
        await startPipeline(fresh, session.title, pipelineDeps(pi, fresh, config));
      },
    });
    return;
  }

  if (session.stage === "implement") {
    const recorded = await sections(ctx.cwd, session);
    await openImplementConversation(pi, ctx, session, config, recorded.compose);
    return;
  }
  if (session.stage === "critique") {
    await startCleanConversation(ctx, session, {
      kickoff: manualCritiqueInstruction(),
    });
    return;
  }
  // Manual mode at a pre-implement stage: the agent owns the stage.
  const inputs = await stageInputsFor(ctx.cwd, session);
  await startCleanConversation(ctx, session, {
    kickoff: stagePrompt(session.stage, inputs),
  });
}

async function renameDashboardSession(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Renaming a Kanban session requires an interactive Pi UI.", "info");
    return;
  }
  const candidate = await findActiveSession(ctx, title);
  if (!candidate) return;
  const nextTitle = await ctx.ui.input("Rename Kanban session", candidate.title);
  if (nextTitle === undefined) return;
  // Renaming a live run cancels it: the registry is keyed by title.
  abortPipelineFor(candidate.title);
  const renamed = await mutateAsync(ctx.cwd, async (state) => {
    const current = state.sessions.find((session) => session.title === candidate.title);
    if (!current) throw new Error("Kanban session changed before it could be renamed");
    delete current.pipelineToken;
    renameSession(state, current, nextTitle);
    await writeSessionPlan(ctx.cwd, current);
    return current;
  });
  await refreshWidget(ctx, renamed.state);
  ctx.ui.notify(`Renamed Kanban session to “${renamed.value.title}”.`, "info");
}

async function removeSessionPermanently(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Removing a Kanban session requires an interactive Pi UI.", "info");
    return;
  }
  const candidate = await findActiveSession(ctx, title);
  if (!candidate) return;
  const confirmed = await ctx.ui.confirm(
    "Delete Kanban session?",
    `Remove “${candidate.title}” from the board and permanently delete its plan file? This cannot be undone.`,
  );
  if (!confirmed) return;
  abortPipelineFor(candidate.title);
  const removed = await mutate(ctx.cwd, (state) => {
    const current = state.sessions.find((session) => session.title === candidate.title);
    if (!current) throw new Error("Kanban session changed before it could be removed");
    removeSession(state, current);
    return current;
  });
  try {
    await rm(safePlanFile(ctx.cwd, removed.value), { force: true });
    await deleteWorkfile(ctx.cwd, workfileBase(removed.value.planPath));
  } catch (error) {
    ctx.ui.notify(
      `Removed “${removed.value.title}” from the board, but its plan could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    await refreshWidget(ctx, removed.state);
    return;
  }
  await refreshWidget(ctx, removed.state);
  ctx.ui.notify(`Deleted Kanban session “${removed.value.title}”.`, "info");
}

async function runDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  for (;;) {
    const action = await showDashboard(ctx, await load(ctx.cwd));
    if (!action) return;
    if (action.kind === "open") {
      await openSession(pi, ctx, action.title);
      return;
    }
    if (action.kind === "rename") await renameDashboardSession(ctx, action.title);
    else await removeSessionPermanently(ctx, action.title);
  }
}

interface ToolText {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function toolResult(text: string, details: Record<string, unknown> = {}): ToolText {
  return { content: [{ type: "text", text }], details };
}

/** Locked single-transition advance for agent-owned stages, with the blocked/stage guard. */
async function advanceOnce(
  cwd: string,
  expectedTitle: string,
  expectedStage: Stage,
  input: CheckpointInput,
  patch?: (plan: PlanSnapshot) => PlanSnapshot,
): Promise<{ state: KanbanState; session: Session }> {
  const advanced = await mutateAsync(cwd, async (state) => {
    const session = requireSelectedSession(state);
    if (session.title !== expectedTitle || session.stage !== expectedStage)
      throw new Error(
        `Kanban session moved while the stage was completing; re-check /kanban and retry`,
      );
    if (session.state !== "active")
      throw new Error(`Kanban session “${session.title}” is paused; unpause it first`);
    if (input.agents) replaceAgents(session, input.agents);
    session.updatedAt = new Date().toISOString();
    advanceStage(state, session);
    await writeCheckpointArtifacts(cwd, session, input, undefined, patch);
    return session;
  });
  return { state: advanced.state, session: advanced.value };
}

interface CompletionRecord {
  critique: "pass" | "accepted-issues" | "manual" | "skipped";
  note?: string;
}

/** The one shared final-completion path: archive, clear the board, delete the workfile. */
async function completeSession(
  ctx: ExtensionContext,
  config: KanbanConfig,
  expectedTitle: string,
  input: CheckpointInput,
  completion: CompletionRecord,
  expectedToken?: string,
): Promise<ToolText> {
  let archivedPlan: PlanSnapshot | undefined;
  const done = await mutateAsync(ctx.cwd, async (state) => {
    const session = requireSelectedSession(state);
    if (session.title !== expectedTitle)
      throw new Error("Kanban selection changed while completing; retry");
    if (session.state !== "active")
      throw new Error(`Kanban session “${session.title}” is paused; unpause it first`);
    if (session.stage !== "critique")
      throw new Error("final completion is only valid at the critique stage");
    if (expectedToken !== undefined && session.pipelineToken !== expectedToken)
      throw new Error(
        "critique gate finished but the session was paused; nothing was recorded — re-run after unpausing",
      );
    if (input.agents) replaceAgents(session, input.agents);
    session.updatedAt = new Date().toISOString();
    const base = workfileBase(session.planPath);
    advanceStage(state, session);
    const current = await readPlan(ctx.cwd, session.planPath);
    const plan = mergePlan(current, session, input, "complete");
    delete plan.pendingCompletion;
    delete plan.gateFailure;
    plan.completion = completion;
    archivedPlan = plan;
    await writePlan(ctx.cwd, session.planPath, plan);
    if (input.handoff !== undefined)
      await writeHandoff(ctx.cwd, buildHandoff(input.handoff, config.init));
    if (!state.sessions.length)
      await writeHandoff(
        ctx.cwd,
        buildIdleHandoff({ title: session.title, planPath: session.planPath }),
      );
    return base;
  });
  await deleteWorkfile(ctx.cwd, done.value);
  await refreshWidget(ctx, done.state);
  return toolResult(
    completionText(config, archivedPlan!),
    { title: expectedTitle, status: "complete" },
  );
}

async function patchPlan(
  cwd: string,
  session: Session,
  patch: (plan: PlanSnapshot) => PlanSnapshot,
): Promise<void> {
  const plan = (await readPlan(cwd, session.planPath)) ?? emptyPlan(session, session.title);
  await writePlan(cwd, session.planPath, patch(plan));
}

/** Bounded issue note derived from the workfile's recorded critique section. */
async function issuesNote(cwd: string, session: Session): Promise<string> {
  const recorded = await sections(cwd, session);
  const body = recorded.critique;
  if (!body) return "accepted with unresolved critique issues (list unavailable)";
  const parsed = parseStageOutput("critique", `## critique\n${body}`);
  const issues = parsed.issues?.length ? parsed.issues : undefined;
  return issues
    ? issues.map((issue) => `- ${issue}`).join("\n")
    : "accepted with unresolved critique issues (list unavailable)";
}

async function confirmWithTimeout(
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<boolean> {
  try {
    return await ctx.ui.confirm(title, message, { timeout: CONFIRM_TIMEOUT_MS });
  } catch {
    return false;
  }
}

export default function kanban(pi: ExtensionAPI): void {
  const refresh = async (ctx: ExtensionContext) => {
    const state = await initialize(ctx.cwd);
    await refreshWidget(ctx, state);
    return state;
  };

  pi.on("session_start", async (_event, ctx) => {
    const state = await refresh(ctx);
    try {
      await sweepOrphanWorkfiles(
        ctx.cwd,
        state.sessions.map((session) => workfileBase(session.planPath)),
      );
    } catch {
      // Sweeping is best-effort cleanup; never block startup on it.
    }
  });
  pi.on("session_shutdown", async () => {
    clearPipelineRegistry();
  });
  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("agent_start", async (_event, ctx) => {
    await refreshWidget(ctx, await load(ctx.cwd));
  });
  pi.on("agent_end", async (_event, ctx) => {
    await refreshWidget(ctx, await load(ctx.cwd));
  });
  pi.on("tool_execution_end", async (_event, ctx) => {
    await refreshWidget(ctx, await load(ctx.cwd));
  });

  async function completeCommand(ctx: ExtensionCommandContext): Promise<void> {
    const state = await load(ctx.cwd);
    const session = requireSelectedSession(state);
    if (session.state !== "active") {
      ctx.ui.notify(`Kanban session “${session.title}” is paused. Use /kanban unpause first.`, "info");
      return;
    }
    if (session.stage !== "critique") {
      ctx.ui.notify("Kanban /kanban complete is only valid at the critique stage.", "info");
      return;
    }
    const plan = await readPlan(ctx.cwd, session.planPath);
    const pending = plan?.pendingCompletion;
    if (!pending) {
      ctx.ui.notify(
        "Nothing is pending completion. Finish the critique gate with kanban_update first; the tool directs you here only when a confirmation could not be shown.",
        "info",
      );
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Completing a Kanban session here requires an interactive Pi UI.", "info");
      return;
    }
    const confirmed = await confirmWithTimeout(
      ctx,
      "Complete Kanban session?",
      `Archive “${session.title}” with the recorded ${pending.critique} completion?`,
    );
    if (!confirmed) return;
    const config = await configFor(ctx);
    const result = await completeSession(
      ctx,
      config,
      session.title,
      { action: "stage_complete" },
      { critique: pending.critique, note: pending.note },
    );
    ctx.ui.notify(result.content[0]!.text.split("\n", 1)[0]!, "info");
  }

  async function configCommand(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Editing the Kanban config requires an interactive Pi UI.", "info");
      return;
    }
    const loaded = await loadConfig(ctx.cwd);
    const edited = await ctx.ui.editor(
      "Kanban config (.kanban/config.json)",
      JSON.stringify(loaded.config, null, 2),
    );
    if (edited === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(edited);
    } catch (error) {
      ctx.ui.notify(
        `Kanban config not saved: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const path = join(ctx.cwd, ".kanban", "config.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    warnedConfigDirs.delete(ctx.cwd);
    const reloaded = await loadConfig(ctx.cwd);
    if (reloaded.warnings.length)
      ctx.ui.notify(`Kanban config saved with warnings: ${reloaded.warnings.join("; ")}`, "warning");
    else ctx.ui.notify("Kanban config saved.", "info");
  }

  pi.registerCommand("kanban", {
    description:
      "Open the durable Kanban dashboard, create a session, open/resume one, edit config, complete a pending archive, or pause/remove the current session",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [verb, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const body = rest.join(" ").trim();
      try {
        if (!verb) {
          await runDashboard(pi, ctx);
          return;
        }

        if (verb === "create") {
          if (!body) {
            ctx.ui.notify("Usage: /kanban create <brief>", "error");
            return;
          }
          const config = await configFor(ctx);
          const title = await generateTitle(ctx, body);
          const created = await mutateAsync(ctx.cwd, async (state) => {
            const session = await createSession(ctx.cwd, state, title);
            session.mode = "pipeline";
            await writePlan(ctx.cwd, session.planPath, emptyPlan(session, body));
            if (!(await readHandoff(ctx.cwd)))
              await writeHandoff(ctx.cwd, buildHandoff(undefined, config.init));
            return session;
          });
          await refreshWidget(ctx, created.state);
          ctx.ui.notify(
            `Created ${created.value.title}; opening a clean Pi conversation while the pipeline runs.`,
            "info",
          );
          await startCleanConversation(ctx, created.value, {
            afterSwitch: async (fresh) => {
              await startPipeline(
                fresh,
                created.value.title,
                pipelineDeps(pi, fresh, config),
              );
            },
          });
          return;
        }

        if (verb === "open") {
          const title = body || requireSelectedSession(await load(ctx.cwd)).title;
          await openSession(pi, ctx, title);
          return;
        }

        if (verb === "config") {
          if (body) {
            ctx.ui.notify("Usage: /kanban config", "error");
            return;
          }
          await configCommand(ctx);
          return;
        }

        if (verb === "complete") {
          if (body) {
            ctx.ui.notify("Usage: /kanban complete", "error");
            return;
          }
          await completeCommand(ctx);
          return;
        }

        if (verb === "pause" || verb === "unpause") {
          if (body) {
            ctx.ui.notify(`Usage: /kanban ${verb}`, "error");
            return;
          }
          const nextState: SessionState = verb === "pause" ? "blocked" : "active";
          const updated = await mutateAsync(ctx.cwd, async (state) => {
            const current = requireSelectedSession(state);
            if (current.state === nextState)
              throw new Error(
                nextState === "blocked"
                  ? `Kanban session “${current.title}” is already paused`
                  : `Kanban session “${current.title}” is already active`,
              );
            if (nextState === "blocked") {
              abortPipelineFor(current.title);
              delete current.pipelineToken;
            }
            setSessionState(current, nextState);
            await writeSessionPlan(ctx.cwd, current);
            return current;
          });
          await refreshWidget(ctx, updated.state);
          ctx.ui.notify(
            `Kanban session “${updated.value.title}” is ${nextState === "blocked" ? "paused" : "active"}.`,
            "info",
          );
          return;
        }

        if (verb === "remove") {
          if (body) {
            ctx.ui.notify("Usage: /kanban remove", "error");
            return;
          }
          const state = await load(ctx.cwd);
          await removeSessionPermanently(ctx, requireSelectedSession(state).title);
          return;
        }

        ctx.ui.notify(
          "Unknown Kanban command. Use /kanban, /kanban create, /kanban open, /kanban config, /kanban complete, /kanban pause, /kanban unpause, or /kanban remove.",
          "error",
        );
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Unable to manage Kanban session",
          "error",
        );
      }
    },
  });

  /** stage_complete at the critique stage: the gate. */
  async function completeCritique(
    ctx: ExtensionContext,
    input: CheckpointInput,
    session: Session,
    signal: AbortSignal | undefined,
    onUpdate: ((line: string) => void) | undefined,
  ): Promise<ToolText> {
    const config = await configFor(ctx);
    const mode = sessionMode(session);
    const plan = await readPlan(ctx.cwd, session.planPath);
    const attempts = plan?.critiqueAttempts ?? 0;

    if (input.critiqueSummary !== undefined) {
      if (mode === "pipeline" && !plan?.gateFailure)
        throw new Error(
          "a healthy critique gate cannot be bypassed with a summary; call stage_complete to run the gate (or fix its reported issues first)",
        );
      const note = input.critiqueSummary.trim();
      if (!note) throw new Error("critiqueSummary must not be empty");
      if (ctx.hasUI) {
        const confirmed = await confirmWithTimeout(
          ctx,
          "Complete Kanban session?",
          `Complete “${session.title}”? The critique gate was manual.`,
        );
        if (!confirmed) {
          await patchPlan(ctx.cwd, session, (current) => ({
            ...current,
            pendingCompletion: { critique: "manual", note },
          }));
          return toolResult(
            "Completion was not confirmed. The manual critique summary was recorded as pending; run /kanban complete to confirm and archive.",
          );
        }
      }
      return completeSession(ctx, config, session.title, input, {
        critique: "manual",
        note,
      });
    }

    if (mode === "manual")
      return toolResult(
        `Manual critique requires a critiqueSummary. ${manualCritiqueInstruction()}`,
      );

    if (input.acceptRemainingIssues) {
      if (attempts < CRITIQUE_ATTEMPT_CAP)
        return toolResult(
          "acceptRemainingIssues is not available yet: fix or re-run the gate first (the accept path opens after the second failed gate run).",
        );
      const note = await issuesNote(ctx.cwd, session);
      if (ctx.hasUI) {
        const confirmed = await confirmWithTimeout(
          ctx,
          "Archive despite unresolved critique issues?",
          `Complete “${session.title}” accepting the remaining critique issues?`,
        );
        if (!confirmed) {
          await patchPlan(ctx.cwd, session, (current) => ({
            ...current,
            pendingCompletion: { critique: "accepted-issues", note },
          }));
          return toolResult(
            "Completion was not confirmed. The accepted issues were recorded as pending; run /kanban complete to confirm and archive.",
          );
        }
      }
      return completeSession(ctx, config, session.title, input, {
        critique: "accepted-issues",
        note,
      });
    }

    if (!config.critique)
      return completeSession(ctx, config, session.title, input, {
        critique: "skipped",
      });

    if (!input.rerunCritique && attempts >= CRITIQUE_ATTEMPT_CAP)
      return toolResult(
        `The critique gate failed ${attempts} times and the attempts cap is reached. Pass rerunCritique: true to run it again after fixing the issues, or acceptRemainingIssues: true to archive with the remaining issues recorded.`,
      );

    // Mint the gate's own CAS generation before running the child.
    const token = randomUUID();
    await mutateAsync(ctx.cwd, async (state) => {
      const current = requireSelectedSession(state);
      if (current.title !== session.title || current.stage !== "critique")
        throw new Error("Kanban selection changed while arming the critique gate; retry");
      if (current.state !== "active")
        throw new Error(`Kanban session “${current.title}” is paused; unpause it first`);
      current.pipelineToken = token;
      current.updatedAt = new Date().toISOString();
    });

    const diff = await computeDiff(ctx.cwd);
    const outcome = await runCritiqueGate(ctx, session, {
      runChild: selectRunner(config),
      config,
      diff,
      signal: signal ?? new AbortController().signal,
      ...(onUpdate ? { onUpdate } : {}),
    });

    if (outcome.kind === "aborted")
      return toolResult("Critique gate aborted; call stage_complete to re-run it.");

    if (outcome.kind === "child-failed") {
      await mutateAsync(ctx.cwd, async (state) => {
        const current = requireSelectedSession(state);
        if (
          current.title !== session.title ||
          current.stage !== "critique" ||
          current.state !== "active" ||
          current.pipelineToken !== token
        )
          throw new Error(
            "critique gate finished but the session was paused; nothing was recorded — re-run after unpausing",
          );
        await patchPlan(ctx.cwd, current, (currentPlan) => ({
          ...currentPlan,
          gateFailure: {
            errorKind: outcome.errorKind ?? "other",
            ...(outcome.error ? { error: outcome.error } : {}),
          },
        }));
      });
      return toolResult(
        `The critique gate child failed (${outcome.errorKind ?? "other"}${outcome.error ? `: ${outcome.error}` : ""}). The gate cannot run; complete the critique manually by calling stage_complete with critiqueSummary (what you reviewed, the verdict, remaining issues).`,
      );
    }

    if (outcome.kind === "fail") {
      const failed = await mutateAsync(ctx.cwd, async (state) => {
        const current = requireSelectedSession(state);
        if (
          current.title !== session.title ||
          current.stage !== "critique" ||
          current.state !== "active" ||
          current.pipelineToken !== token
        )
          throw new Error(
            "critique gate finished but the session was paused; nothing was recorded — re-run after unpausing",
          );
        const { writeWorkfileSection } = await import("./workfile.js");
        await writeWorkfileSection(
          ctx.cwd,
          workfileBase(current.planPath),
          "critique",
          outcome.body,
        );
        if (input.agents) replaceAgents(current, input.agents);
        current.updatedAt = new Date().toISOString();
        let total = 0;
        await writeCheckpointArtifacts(ctx.cwd, current, input, undefined, (currentPlan) => {
          total = (currentPlan.critiqueAttempts ?? 0) + 1;
          const next = { ...currentPlan, critiqueAttempts: total };
          delete next.pendingCompletion;
          delete next.gateFailure;
          return next;
        });
        return total;
      });
      const total = failed.value;
      await refreshWidget(ctx, failed.state);
      const issueLines = outcome.issues.map((issue) => `- ${issue}`).join("\n");
      const acceptOffer =
        total >= CRITIQUE_ATTEMPT_CAP
          ? "\n\nThe attempts cap is reached: after fixing, pass rerunCritique: true to run the gate again, or acceptRemainingIssues: true to archive with the issues recorded."
          : "\n\nFix the issues and call stage_complete again to re-run the gate.";
      return toolResult(
        `Critique gate: FAIL (attempt ${total}).\n\n${issueLines}${acceptOffer}`,
        { title: session.title, stage: "critique" },
      );
    }

    return completeSession(
      ctx,
      config,
      session.title,
      input,
      { critique: "pass" },
      token,
    );
  }

  pi.registerTool({
    name: TOOL,
    label: "Kanban Checkpoint",
    description:
      "Record one concise checkpoint for the selected Kanban session, or explicitly complete its current stage. Use only at material milestones, never for individual tasks or tool calls.",
    promptSnippet: "Record concise Kanban checkpoints and explicit stage completion.",
    promptGuidelines: [
      "The tool always updates the selected session; never invent or request session, task, or todo IDs.",
      "Use checkpoint only for material scope, agent, work-summary, or handoff changes.",
      "Use stage_complete only after the current stage is complete. Follow the transition and completion instructions carried in the tool result; never run git commit automatically.",
    ],
    parameters: Type.Object({
      action: StringEnum(["checkpoint", "stage_complete"] as const),
      inScope: Type.Optional(Type.Array(Type.String())),
      outOfScope: Type.Optional(Type.Array(Type.String())),
      agents: Type.Optional(Type.Array(AgentSchema)),
      work: Type.Optional(WorkSchema),
      handoff: Type.Optional(Type.String()),
      rerunCritique: Type.Optional(Type.Boolean()),
      acceptRemainingIssues: Type.Optional(Type.Boolean()),
      critiqueSummary: Type.Optional(Type.String()),
    }),
    async execute(_id, input: CheckpointInput, signal, update, ctx) {
      if (input.rerunCritique && input.acceptRemainingIssues)
        return toolResult(
          "rerunCritique and acceptRemainingIssues are mutually exclusive; pass exactly one.",
        );

      if (input.action === "checkpoint") {
        if (!checkpointHasContent(input))
          throw new Error("checkpoint requires scope, agents, work, or handoff content");
        const updated = await mutateAsync(ctx.cwd, async (state) => {
          const session = requireSelectedSession(state);
          if (session.state !== "active")
            throw new Error(`Kanban session “${session.title}” is paused; unpause it first`);
          if (input.agents) replaceAgents(session, input.agents);
          session.updatedAt = new Date().toISOString();
          await writeCheckpointArtifacts(ctx.cwd, session, input);
          return session;
        });
        await refreshWidget(ctx, updated.state);
        return toolResult(`Checkpoint recorded for ${updated.value.title}.`, {
          title: updated.value.title,
          stage: updated.value.stage,
        });
      }

      // stage_complete
      const state = await load(ctx.cwd);
      const session = requireSelectedSession(state);
      if (session.state !== "active")
        throw new Error(`Kanban session “${session.title}” is paused; unpause it first`);
      const mode = sessionMode(session);

      if (mode === "pipeline" && PIPELINE_STAGES.includes(session.stage))
        throw new Error(
          `the ${session.stage} stage is run by the Kanban pipeline; use /kanban open to resume it`,
        );

      if (session.stage === "critique") {
        const onUpdate = update
          ? (line: string) => {
              try {
                update({ content: [{ type: "text", text: line }] } as never);
              } catch {
                // Progress streaming is best-effort.
              }
            }
          : undefined;
        return completeCritique(ctx, input, session, signal, onUpdate);
      }

      // Agent-owned single transition (implement in both modes; every stage in manual mode).
      const config = await configFor(ctx);
      const advanced = await advanceOnce(
        ctx.cwd,
        session.title,
        session.stage,
        input,
      );
      await refreshWidget(ctx, advanced.state);
      const next = advanced.session.stage;
      let transition: string;
      if (next === "critique") {
        transition =
          mode === "pipeline"
            ? "Critique gate armed — call kanban_update stage_complete to run the adversarial critique of the change against the spec."
            : `Critique gate armed — ${manualCritiqueInstruction()}`;
      } else if (next === "implement") {
        const recorded = await sections(ctx.cwd, advanced.session);
        transition = implementKickoff(
          config,
          safeDetectExternalTools(pi),
          recorded.compose,
        );
      } else {
        const inputs = await stageInputsFor(ctx.cwd, advanced.session);
        transition = stagePrompt(next, inputs);
      }
      return toolResult(
        `${advanced.session.title}: starting ${next}.\n\n${transition}`,
        { title: advanced.session.title, stage: next },
      );
    },
  });
}
