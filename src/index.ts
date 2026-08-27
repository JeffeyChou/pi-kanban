import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { persistSessionArtifacts, readArtifactText } from "./artifacts.js";
import { discoverSessionFiles } from "./sources.js";
import {
  STAGES,
  blockDependents,
  createSession,
  initialize,
  load,
  mutate,
  newTask,
  prerequisitesComplete,
  refreshProgress,
  requireSession,
  selectedSession,
  type Agent,
  type Session,
} from "./store.js";
import { pickSession, refreshWidget } from "./ui.js";

const TOOL = "kanban_update";
const integrations = (pi: ExtensionAPI) => {
  const tools = new Set(pi.getActiveTools());
  return {
    background: tools.has("bg_run"),
    subagents: tools.has("subagent"),
    questions: tools.has("ask_user_question"),
  };
};
const modelName = (ctx: ExtensionContext) =>
  ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
const primary = (ctx: ExtensionContext): Agent => ({
  id: `primary:${ctx.sessionManager.getSessionId()}`,
  kind: "primary",
  model: modelName(ctx),
  contextUsage: ctx.getContextUsage()?.tokens ?? null,
  currentTask: null,
  remainingTodos: [],
  metricsSource: "pi-context",
});
function syncPrimary(session: Session, ctx: ExtensionContext): void {
  const record = primary(ctx);
  const prior = session.agents.find((agent) => agent.id === record.id);
  if (prior) Object.assign(prior, record);
  else session.agents.push(record);
  refreshProgress(session);
}
function kickoff(session: Session): string {
  return `Kanban session “${session.title}” is selected. Run the ${session.stage} stage now. Update tasks and todos as work progresses. When, and only when, this stage is complete, call kanban_update with action "stage_complete" and this session's internal id. Do not advance stages by assumption.`;
}
async function persist(cwd: string, session: Session): Promise<void> {
  await persistSessionArtifacts(cwd, session);
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

export default function kanban(pi: ExtensionAPI): void {
  const refresh = async (ctx: ExtensionContext) => {
    await initialize(ctx.cwd, integrations(pi));
    const updated = await mutate(ctx.cwd, (current) => {
      const session = selectedSession(current);
      if (session) {
        syncPrimary(session, ctx);
        session.piConversationPath =
          ctx.sessionManager.getSessionFile() ?? undefined;
        session.piConversationId = ctx.sessionManager.getSessionId();
      }
      return current;
    });
    const session = selectedSession(updated);
    if (session) await persist(ctx.cwd, session);
    await refreshWidget(ctx, updated);
    return updated;
  };
  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const state = await mutate(ctx.cwd, (current) => {
      const session = selectedSession(current);
      if (session && session.state === "active")
        session.currentActivity = `Interrupted during ${session.stage}`;
      return current;
    });
    const session = selectedSession(state);
    if (session) await persist(ctx.cwd, session);
  });
  pi.on("agent_start", async (_event, ctx) => {
    const state = await mutate(ctx.cwd, (current) => {
      const session = selectedSession(current);
      if (session) {
        syncPrimary(session, ctx);
        session.currentActivity = `Running ${session.stage}`;
      }
      return current;
    });
    await refreshWidget(ctx, state);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    const state = await mutate(ctx.cwd, (current) => {
      const session = selectedSession(current);
      if (!session) return current;
      syncPrimary(session, ctx);
      session.currentActivity = event.isError
        ? `${event.toolName} failed`
        : `Used ${event.toolName}`;
      return current;
    });
    await refreshWidget(ctx, state);
  });

  pi.registerCommand("kanban", {
    description: "Create, select, resume, or configure durable Kanban sessions",
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const body = rest.join(" ").trim();
      if (verb === "create") {
        const [title, description] = body.split(/\s+--\s+/, 2);
        if (!title) {
          ctx.ui.notify(
            "Usage: /kanban create <title> [-- <description>]",
            "error",
          );
          return;
        }
        let created!: Session;
        const state = await mutate(ctx.cwd, (current) => {
          current.integrations = integrations(pi);
          created = createSession(current, title, description);
          syncPrimary(created, ctx);
          created.piConversationPath =
            ctx.sessionManager.getSessionFile() ?? undefined;
          created.piConversationId = ctx.sessionManager.getSessionId();
          return current;
        });
        pi.setSessionName(created.title);
        await persist(ctx.cwd, created);
        await refreshWidget(ctx, state);
        ctx.ui.notify(`Created ${created.title}; starting refine.`, "info");
        pi.sendUserMessage(kickoff(created), { deliverAs: "followUp" });
        return;
      }
      if (verb === "configure-context") {
        const [model, limit] = body.split(/\s+/, 2);
        const tokens = Number(limit);
        if (!model || !Number.isFinite(tokens) || tokens <= 0) {
          ctx.ui.notify(
            "Usage: /kanban configure-context <provider/model> <tokens>",
            "error",
          );
          return;
        }
        const state = await mutate(ctx.cwd, (current) => {
          current.modelContextLimits[model] = tokens;
          return current;
        });
        await refreshWidget(ctx, state);
        return;
      }
      if (verb === "list" || verb === "select" || verb === "resume") {
        const state = await load(ctx.cwd);
        const choice = await pickSession(ctx, state.sessions);
        if (!choice) return;
        const selected = await mutate(ctx.cwd, (current) => {
          current.selectedSessionId = choice;
          requireSession(current, choice);
          return current;
        });
        const session = requireSession(selected, choice);
        await persist(ctx.cwd, session);
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
          const durableHandoff = await readArtifactText(
            ctx.cwd,
            session.handoffArtifact,
          );
          const handoff = `Resume durable Kanban session “${session.title}”.\n\n${durableHandoff || `Handoff artifact unavailable: ${session.handoffArtifact}`}\n\n${kickoff(session)}`;
          await ctx.newSession({
            setup: async (manager) => {
              manager.appendMessage({
                role: "user",
                content: [{ type: "text", text: handoff }],
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
        await refreshWidget(ctx, selected);
        return;
      }
      ctx.ui.notify(
        "Usage: /kanban create | list | select | resume | configure-context",
        "info",
      );
    },
  });

  pi.registerTool({
    name: TOOL,
    label: "Kanban Update",
    description:
      "Persist selected-session Kanban progress. Complete a workflow stage only with stage_complete; this starts the next stage automatically.",
    promptSnippet:
      "Record durable Kanban progress and explicitly complete stages.",
    promptGuidelines: [
      "Use stage_complete only after completing the current stage. Use session ids returned by this tool only; do not present them to users.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "stage_complete",
        "task",
        "task_state",
        "todo",
        "todo_state",
        "dependency",
        "assign",
        "review",
        "evidence",
        "block",
        "source_file",
        "context_limit",
      ] as const),
      sessionId: Type.String(),
      taskId: Type.Optional(Type.String()),
      todoId: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      state: Type.Optional(Type.String()),
      prerequisiteId: Type.Optional(Type.String()),
      agentId: Type.Optional(Type.String()),
      importantCriteria: Type.Optional(Type.Array(Type.String())),
      important: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, input, _signal, _update, ctx) {
      let nextStage: Session | undefined;
      const state = await mutate(ctx.cwd, (current) => {
        const session = requireSession(current, input.sessionId);
        syncPrimary(session, ctx);
        if (input.action === "stage_complete") {
          const index = STAGES.indexOf(session.stage);
          const next = STAGES[index + 1];
          session.evidence.push(`${session.stage} explicitly completed`);
          if (next) {
            session.stage = next;
            session.currentActivity = `Starting ${next}`;
            nextStage = session;
          } else {
            session.state = "complete";
            session.currentActivity = "Completed";
          }
        } else if (input.action === "context_limit") {
          const model = input.text ?? modelName(ctx);
          if (!model || !input.limit || input.limit <= 0)
            throw new Error(
              "context_limit requires model text and positive limit",
            );
          current.modelContextLimits[model] = input.limit;
        } else if (input.action === "source_file") {
          if (!input.text)
            throw new Error("source_file requires a repository-relative path");
          if (!session.sourceFiles.includes(input.text))
            session.sourceFiles.push(input.text);
        } else if (input.action === "task") {
          if (!input.text) throw new Error("task requires text");
          const task = newTask(crypto.randomUUID(), input.text);
          task.important = input.important ?? false;
          task.review.status = task.important ? "pending" : "not_required";
          session.tasks.push(task);
        } else {
          if (!input.taskId) throw new Error(`${input.action} requires taskId`);
          const task = session.tasks.find((item) => item.id === input.taskId);
          if (!task) throw new Error("unknown task");
          if (input.action === "task_state") {
            if (
              !input.state ||
              ![
                "pending",
                "in_progress",
                "completed",
                "failed",
                "cancelled",
              ].includes(input.state)
            )
              throw new Error("invalid task state");
            if (
              ["in_progress", "completed"].includes(input.state) &&
              !prerequisitesComplete(session, task)
            )
              throw new Error("task prerequisites are incomplete");
            task.state = input.state as typeof task.state;
            if (["failed", "cancelled"].includes(task.state))
              blockDependents(session, task.id);
          } else if (input.action === "todo") {
            if (!input.text) throw new Error("todo requires text");
            task.todos.push({
              id: crypto.randomUUID(),
              text: input.text,
              state: "pending",
              evidence: [],
            });
          } else if (input.action === "todo_state") {
            const todo = task.todos.find((item) => item.id === input.todoId);
            if (
              !todo ||
              !input.state ||
              !["pending", "in_progress", "completed"].includes(input.state)
            )
              throw new Error("todo_state requires valid todoId and state");
            todo.state = input.state as typeof todo.state;
          } else if (input.action === "dependency") {
            const prerequisite = session.tasks.find(
              (item) => item.id === input.prerequisiteId,
            );
            if (!prerequisite || prerequisite === task)
              throw new Error("dependency requires another task");
            if (!task.prerequisites.includes(prerequisite.id))
              task.prerequisites.push(prerequisite.id);
            if (!prerequisite.subsequent.includes(task.id))
              prerequisite.subsequent.push(task.id);
          } else if (input.action === "assign") {
            const agent = session.agents.find(
              (item) => item.id === input.agentId,
            );
            if (!agent) throw new Error("assign requires existing agentId");
            task.assignedAgent = agent.id;
            agent.currentTask = task.id;
            agent.remainingTodos = task.todos
              .filter((todo) => todo.state !== "completed")
              .map((todo) => todo.id);
          } else if (input.action === "evidence") {
            if (!input.text) throw new Error("evidence requires text");
            task.evidence.push(input.text);
          } else if (input.action === "review") {
            if (!task.important || !input.text)
              throw new Error("review requires an important task and evidence");
            task.review.status = input.state === "failed" ? "failed" : "passed";
            task.review.evidence.push(input.text);
            session.reviews.push(input.text);
          } else if (input.action === "block") {
            task.state = input.state === "cancelled" ? "cancelled" : "failed";
            blockDependents(session, task.id);
            session.state = "blocked";
          }
        }
        refreshProgress(session);
        return current;
      });
      const session = requireSession(state, input.sessionId);
      await persist(ctx.cwd, session);
      await refreshWidget(ctx, state);
      if (nextStage)
        pi.sendUserMessage(kickoff(nextStage), { deliverAs: "followUp" });
      return {
        content: [
          {
            type: "text",
            text: nextStage
              ? `${nextStage.title}: starting ${nextStage.stage}.`
              : "Kanban state recorded.",
          },
        ],
        details: {
          session,
          sourceFiles: await discoverSessionFiles(ctx.cwd, session),
        },
      };
    },
  });
}
