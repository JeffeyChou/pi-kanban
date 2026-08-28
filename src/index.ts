import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
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
} from "./store.js";
import { refreshWidget, showDashboard } from "./ui.js";

const TOOL = "kanban_update";

interface CheckpointInput {
  action: "checkpoint" | "stage_complete";
  inScope?: string[];
  outOfScope?: string[];
  agents?: AgentRecord[];
  work?: Partial<WorkSummary>;
  handoff?: string;
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

function kickoff(session: Session): string {
  return `Kanban session “${session.title}” is selected at the ${session.stage} stage. This durable Kanban session is independent from Pi conversation files. Before implementation, run ./init.sh and read the selected plan. Use kanban_update only for a material checkpoint (scope, agent roster, work summary, or handoff) or explicit stage completion; never call it for each task or tool. When the final stage is complete, run ./init.sh --check. Never run git commit automatically: end with a suggested commit for the user to decide.`;
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
): Promise<void> {
  const current = await readPlan(cwd, session.planPath);
  await writePlan(cwd, session.planPath, mergePlan(current, session, input, status));
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

async function startCleanConversation(
  ctx: ExtensionCommandContext,
  session: Session,
): Promise<void> {
  const [handoff, plan] = await Promise.all([
    readHandoff(ctx.cwd),
    readPlan(ctx.cwd, session.planPath),
  ]);
  const durableContext = [
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
  const result = await ctx.newSession({
    setup: async (manager) => {
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: durableContext }],
        timestamp: Date.now(),
      });
    },
    withSession: async (fresh) => {
      await fresh.sendUserMessage(kickoff(session));
    },
  });
  if (result.cancelled)
    ctx.ui.notify(`Kanban session “${session.title}” is selected but was not opened.`, "info");
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
  ctx: ExtensionCommandContext,
  title: string,
): Promise<void> {
  const candidate = await findActiveSession(ctx, title);
  if (!candidate) return;
  if (candidate.state === "blocked") {
    ctx.ui.notify(`Kanban session “${candidate.title}” is paused. Use /kanban unpause first.`, "info");
    return;
  }
  const selected = await selectTitle(ctx.cwd, candidate.title);
  await refreshWidget(ctx, selected.state);
  await startCleanConversation(ctx, selected.session);
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
  const renamed = await mutateAsync(ctx.cwd, async (state) => {
    const current = state.sessions.find((session) => session.title === candidate.title);
    if (!current) throw new Error("Kanban session changed before it could be renamed");
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
  const removed = await mutate(ctx.cwd, (state) => {
    const current = state.sessions.find((session) => session.title === candidate.title);
    if (!current) throw new Error("Kanban session changed before it could be removed");
    removeSession(state, current);
    return current;
  });
  try {
    await rm(safePlanFile(ctx.cwd, removed.value), { force: true });
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

async function runDashboard(ctx: ExtensionCommandContext): Promise<void> {
  for (;;) {
    const action = await showDashboard(ctx, await load(ctx.cwd));
    if (!action) return;
    if (action.kind === "open") {
      await openSession(ctx, action.title);
      return;
    }
    if (action.kind === "rename") await renameDashboardSession(ctx, action.title);
    else await removeSessionPermanently(ctx, action.title);
  }
}

export default function kanban(pi: ExtensionAPI): void {
  const refresh = async (ctx: ExtensionContext) => {
    const state = await initialize(ctx.cwd);
    await refreshWidget(ctx, state);
    return state;
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
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

  pi.registerCommand("kanban", {
    description: "Open the durable Kanban dashboard, create a session, or pause/remove the current session",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [verb, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const body = rest.join(" ").trim();
      try {
        if (!verb) {
          await runDashboard(ctx);
          return;
        }

        if (verb === "create") {
          if (!body) {
            ctx.ui.notify("Usage: /kanban create <brief>", "error");
            return;
          }
          const title = await generateTitle(ctx, body);
          const created = await mutateAsync(ctx.cwd, async (state) => {
            const session = await createSession(ctx.cwd, state, title);
            await writePlan(ctx.cwd, session.planPath, emptyPlan(session, body));
            if (!(await readHandoff(ctx.cwd))) await writeHandoff(ctx.cwd, buildHandoff());
            return session;
          });
          await refreshWidget(ctx, created.state);
          ctx.ui.notify(`Created ${created.value.title}; opening a clean Pi conversation.`, "info");
          await startCleanConversation(ctx, created.value);
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
          "Unknown Kanban command. Use /kanban, /kanban create, /kanban pause, /kanban unpause, or /kanban remove.",
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

  pi.registerTool({
    name: TOOL,
    label: "Kanban Checkpoint",
    description:
      "Record one concise checkpoint for the selected Kanban session, or explicitly complete its current stage. Use only at material milestones, never for individual tasks or tool calls.",
    promptSnippet: "Record concise Kanban checkpoints and explicit stage completion.",
    promptGuidelines: [
      "The tool always updates the selected session; never invent or request session, task, or todo IDs.",
      "Use checkpoint only for material scope, agent, work-summary, or handoff changes.",
      "Use stage_complete only after the current stage is complete. At final completion, run ./init.sh --check and provide a suggested commit without committing.",
    ],
    parameters: Type.Object({
      action: StringEnum(["checkpoint", "stage_complete"] as const),
      inScope: Type.Optional(Type.Array(Type.String())),
      outOfScope: Type.Optional(Type.Array(Type.String())),
      agents: Type.Optional(Type.Array(AgentSchema)),
      work: Type.Optional(WorkSchema),
      handoff: Type.Optional(Type.String()),
    }),
    async execute(_id, input: CheckpointInput, _signal, _update, ctx) {
      if (input.action === "checkpoint" && !checkpointHasContent(input))
        throw new Error("checkpoint requires scope, agents, work, or handoff content");

      let completed: Session | undefined;
      let nextStage: Session | undefined;
      const updated = await mutateAsync(ctx.cwd, async (state) => {
        const session = requireSelectedSession(state);
        if (input.agents) replaceAgents(session, input.agents);
        session.updatedAt = new Date().toISOString();

        if (input.action === "stage_complete") {
          const next = advanceStage(state, session);
          if (next) {
            nextStage = session;
            await writeCheckpointArtifacts(ctx.cwd, session, input);
          } else {
            completed = session;
            await writeCheckpointArtifacts(ctx.cwd, session, input, "complete");
            if (!state.sessions.length)
              await writeHandoff(
                ctx.cwd,
                buildIdleHandoff({
                  title: session.title,
                  planPath: session.planPath,
                }),
              );
          }
        } else {
          await writeCheckpointArtifacts(ctx.cwd, session, input);
        }
        return session;
      });

      await refreshWidget(ctx, updated.state);
      if (nextStage)
        pi.sendUserMessage(kickoff(nextStage), { deliverAs: "followUp" });
      if (completed)
        return {
          content: [
            {
              type: "text",
              text: `Completed ${completed.title}. Run ./init.sh --check; do not commit automatically. Suggested commit: kanban: ${completed.title}`,
            },
          ],
          details: { title: completed.title, status: "complete" },
        };
      return {
        content: [
          {
            type: "text",
            text: nextStage
              ? `${nextStage.title}: starting ${nextStage.stage}.`
              : `Checkpoint recorded for ${updated.value.title}.`,
          },
        ],
        details: {
          title: updated.value.title,
          stage: nextStage?.stage ?? updated.value.stage,
        },
      };
    },
  });
}
