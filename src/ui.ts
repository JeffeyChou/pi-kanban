import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { STAGES, selectedSession, type KanbanState, type Session } from "./store.js";

interface LiveWidgetState {
  contextWindow: number;
  tokens: number;
  primaryWorking: boolean;
}

interface WidgetSnapshot {
  title: string;
  stage: string;
  stageNumber: number;
  remaining: number;
  contextWindow: number;
  percent: number;
  agentsWorking: number;
}

const lastKnownTokens = new Map<string, number>();

function liveWidgetState(
  ctx: ExtensionContext,
  session: Session | undefined,
): LiveWidgetState {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (session && usage?.tokens != null)
    lastKnownTokens.set(session.title, usage.tokens);
  const tokens =
    usage?.tokens ?? (session ? lastKnownTokens.get(session.title) : undefined) ?? 0;
  return {
    contextWindow,
    tokens,
    primaryWorking: !ctx.isIdle(),
  };
}

function snapshot(
  state: KanbanState,
  live: LiveWidgetState,
): WidgetSnapshot | undefined {
  const session = selectedSession(state);
  if (!session) return undefined;
  const contextWindow = Math.max(0, live.contextWindow);
  const remaining = Math.max(0, contextWindow - Math.max(0, live.tokens));
  const percent = contextWindow
    ? Math.round((remaining / contextWindow) * 100)
    : 0;
  const externalWorking = session.agents.filter(
    (agent) => agent.name !== "Primary agent" && agent.status === "working",
  ).length;
  return {
    title: session.title,
    stage: session.stage,
    stageNumber: STAGES.indexOf(session.stage) + 1,
    remaining,
    contextWindow,
    percent,
    agentsWorking: externalWorking + Number(live.primaryWorking),
  };
}

function bar(percent: number, width = 12): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function truncate(text: string, width: number): string {
  return text.length > width
    ? `${text.slice(0, Math.max(0, width - 1))}…`
    : text;
}

export function renderSelected(
  state: KanbanState,
  live: LiveWidgetState = { contextWindow: 0, tokens: 0, primaryWorking: false },
): string[] {
  const view = snapshot(state, live);
  if (!view) return ["No active Kanban session. Use /kanban create <prompt>."];
  return [
    `☐ ${view.title}`,
    `  ◉ Stage ${view.stageNumber}/${STAGES.length} · ${view.stage}`,
    `  Context remaining  ${bar(view.percent)} ${view.remaining.toLocaleString()} / ${view.contextWindow.toLocaleString()} · ${view.percent}%`,
    `  ● Agents working ${view.agentsWorking}`,
  ];
}

function contextColor(percent: number): "success" | "warning" | "error" {
  if (percent <= 15) return "error";
  if (percent <= 35) return "warning";
  return "success";
}

export async function refreshWidget(
  ctx: ExtensionContext,
  state: KanbanState,
): Promise<void> {
  const view = snapshot(state, liveWidgetState(ctx, selectedSession(state)));
  if (!view) {
    ctx.ui.setWidget("kanban", ["No active Kanban session. Use /kanban create <prompt>."], {
      placement: "aboveEditor",
    });
    return;
  }
  ctx.ui.setWidget(
    "kanban",
    (_tui, theme) => ({
      render: (width: number) => {
        const percentage = `${view.percent}%`;
        const context = `  Context remaining  ${bar(view.percent)} ${view.remaining.toLocaleString()} / ${view.contextWindow.toLocaleString()} · ${percentage}`;
        const stage = `  ◉ Stage ${view.stageNumber}/${STAGES.length} · ${view.stage}`;
        const agents = `  ● Agents working ${view.agentsWorking}`;
        return [
          theme.fg("accent", theme.bold(truncate(`☐ ${view.title}`, width))),
          theme.fg("accent", truncate(stage, width)),
          theme.fg(contextColor(view.percent), truncate(context, width)),
          theme.fg(
            view.agentsWorking ? "success" : "dim",
            truncate(agents, width),
          ),
        ];
      },
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}

export async function pickSession(
  ctx: ExtensionCommandContext,
  sessions: Session[],
): Promise<string | null> {
  if (!ctx.hasUI || !sessions.length) return null;
  return ctx.ui.custom<string | null>(
    (tui, theme, _keys, done) => {
      let selected = 0;
      return {
        render: (width: number) => [
          theme.fg("accent", theme.bold(truncate("Select Kanban session", width))),
          ...sessions.map((session, index) =>
            truncate(
              `${index === selected ? ">" : " "} ${session.title} · ${session.stage} · ${session.state}`,
              width,
            ),
          ),
          theme.fg("dim", truncate("↑↓ navigate · enter select · esc cancel", width)),
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
            done(sessions[selected]!.title);
          else if (input === "\u001b") done(null);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}
