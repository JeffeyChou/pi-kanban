import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverSessionFiles } from "./sources.js";
import { selectedSession, type KanbanState, type Session } from "./store.js";

function contextLine(state: KanbanState, session: Session): string {
  const agent = session.agents.find((item) => item.kind === "primary");
  const model = agent?.model ?? "unavailable";
  const limit = state.modelContextLimits[model];
  if (!limit || agent?.contextUsage == null)
    return `context: unavailable (${model})`;
  const remaining = Math.max(0, limit - agent.contextUsage);
  const width = 12;
  const filled = Math.round((remaining / limit) * width);
  return `context: [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${remaining.toLocaleString()}/${limit.toLocaleString()}`;
}

export async function renderSelected(
  cwd: string,
  state: KanbanState,
): Promise<string[]> {
  const session = selectedSession(state);
  if (!session)
    return ["Kanban – no selected session. Use /kanban create <title>."];
  const files = await discoverSessionFiles(cwd, session);
  const agent = session.agents.find((item) => item.kind === "primary");
  const remaining = session.tasks.flatMap((task) =>
    task.todos
      .filter((todo) => todo.state !== "completed")
      .map((todo) => todo.text),
  );
  return [
    `Kanban · ${session.title} [${session.stage}/${session.state}]`,
    `model: ${agent?.model ?? "unavailable"} · activity: ${session.currentActivity}`,
    contextLine(state, session),
    `progress: ${session.liveProgress.completed}/${session.liveProgress.total} · remaining: ${remaining.join("; ") || "none"}`,
    `source files: ${files.join(", ") || "none"}`,
  ];
}

export async function refreshWidget(
  ctx: ExtensionContext,
  state: KanbanState,
): Promise<void> {
  ctx.ui.setWidget("kanban", await renderSelected(ctx.cwd, state), {
    placement: "aboveEditor",
  });
}

export async function pickSession(
  ctx: ExtensionCommandContext,
  sessions: Session[],
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<string | null>(
    (tui, theme, _keys, done) => {
      let selected = 0;
      const truncate = (line: string, width: number) =>
        line.length > width
          ? `${line.slice(0, Math.max(0, width - 1))}…`
          : line;
      return {
        render: (width: number) => [
          truncate(
            theme.fg("accent", theme.bold("Select Kanban session")),
            width,
          ),
          ...sessions.map((session, index) =>
            truncate(
              `${index === selected ? ">" : " "} ${session.title} · ${session.stage} · ${session.state}`,
              width,
            ),
          ),
          truncate(
            theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
            width,
          ),
        ],
        invalidate: () => {},
        handleInput: (input: string) => {
          if ((input === "\u001b[A" || input === "k") && selected > 0)
            selected--;
          else if (
            (input === "\u001b[B" || input === "j") &&
            selected < sessions.length - 1
          )
            selected++;
          else if (input === "\r" || input === "\n")
            done(sessions[selected]!.id);
          else if (input === "\u001b") done(null);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}
