import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
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
  STAGES,
  advanceStage,
  createSession,
  initialize,
  load,
  mutate,
  mutateAsync,
  replaceAgents,
  requireSelectedSession,
  selectedSession,
  setConversation,
  setSelectedSession,
  type AgentRecord,
  type KanbanState,
  type Session,
} from "./store.js";
import { pickSession, refreshWidget } from "./ui.js";

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
  return `Kanban session “${session.title}” is selected at the ${session.stage} stage. Before implementation, run ./init.sh and read the selected plan. Use kanban_update only for a material checkpoint (scope, agent roster, work summary, or handoff) or explicit stage completion; never call it for each task or tool. When the final stage is complete, run ./init.sh --check. Never run git commit automatically: end with a suggested commit for the user to decide.`;
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

async function conversationExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function updateConversationIfChanged(
  ctx: ExtensionContext,
  state: KanbanState,
): Promise<KanbanState> {
  const session = selectedSession(state);
  const path = ctx.sessionManager.getSessionFile() ?? undefined;
  if (!session || session.piConversationPath === path) return state;
  const updated = await mutate(ctx.cwd, (current) => {
    const currentSession = selectedSession(current);
    if (currentSession) setConversation(currentSession, path);
  });
  return updated.state;
}

export default function kanban(pi: ExtensionAPI): void {
  const refresh = async (ctx: ExtensionContext) => {
    const state = await updateConversationIfChanged(ctx, await initialize(ctx.cwd));
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
    description: "Create, select, or resume durable Kanban sessions",
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const body = rest.join(" ").trim();
      if (verb === "create") {
        if (!body) {
          ctx.ui.notify("Usage: /kanban create <prompt>", "error");
          return;
        }
        const title = await generateTitle(ctx, body);
        let created;
        try {
          created = await mutateAsync(ctx.cwd, async (state) => {
            const session = await createSession(ctx.cwd, state, title);
            setConversation(session, ctx.sessionManager.getSessionFile() ?? undefined);
            await writePlan(ctx.cwd, session.planPath, emptyPlan(session, body));
            await writeHandoff(ctx.cwd, buildHandoff());
            return session;
          });
        } catch (error: unknown) {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Unable to create Kanban session",
            "error",
          );
          return;
        }
        pi.setSessionName(created.value.title);
        await refreshWidget(ctx, created.state);
        ctx.ui.notify(`Created ${created.value.title}; starting refine.`, "info");
        pi.sendUserMessage(kickoff(created.value), { deliverAs: "followUp" });
        return;
      }

      if (verb === "list" || verb === "select" || verb === "resume") {
        const state = await load(ctx.cwd);
        const choice = await pickSession(ctx, state.sessions);
        if (!choice) return;
        const selected = await mutate(ctx.cwd, (current) =>
          setSelectedSession(current, choice),
        );
        const session = selected.value;
        if (
          verb === "resume" &&
          (await conversationExists(session.piConversationPath)) &&
          session.piConversationPath !== ctx.sessionManager.getSessionFile()
        ) {
          await ctx.switchSession(session.piConversationPath!, {
            withSession: async (fresh) => {
              await fresh.sendUserMessage(kickoff(session));
            },
          });
          return;
        }
        if (
          verb === "resume" &&
          !(await conversationExists(session.piConversationPath))
        ) {
          const [handoff, plan] = await Promise.all([
            readHandoff(ctx.cwd),
            readPlan(ctx.cwd, session.planPath),
          ]);
          const durableContext = `Resume Kanban session “${session.title}”.\n\n${handoff || "Handoff artifact unavailable."}\n\nPlan:\n${JSON.stringify(plan ?? { planPath: session.planPath }, null, 2)}`;
          await ctx.newSession({
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
          return;
        }
        pi.setSessionName(session.title);
        await refreshWidget(ctx, selected.state);
        return;
      }

      ctx.ui.notify("Usage: /kanban create | list | select | resume", "info");
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
