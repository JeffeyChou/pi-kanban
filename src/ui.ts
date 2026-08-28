import type {
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
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
const MAX_VISIBLE_SESSIONS = 6;

function conversationKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? "__ephemeral_pi_conversation__";
}

function liveWidgetState(ctx: ExtensionContext): LiveWidgetState {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const key = conversationKey(ctx);
  if (usage?.tokens != null) lastKnownTokens.set(key, usage.tokens);
  const tokens = usage?.tokens ?? lastKnownTokens.get(key) ?? 0;
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

function pad(text: string, width: number): string {
  const truncated = truncate(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - truncated.length))}`;
}

function panelLines(title: string, lines: string[], width: number): string[] {
  const outerWidth = Math.max(18, width);
  const innerWidth = Math.max(14, outerWidth - 4);
  const heading = ` ${truncate(title, Math.max(1, innerWidth - 2))} `;
  const top = `┌${heading}${"─".repeat(Math.max(0, outerWidth - 2 - heading.length))}┐`;
  const bottom = `└${"─".repeat(Math.max(0, outerWidth - 2))}┘`;
  return [top, ...lines.map((line) => `│ ${pad(line, innerWidth)} │`), bottom];
}

function matchesKey(
  keys: KeybindingsManager,
  input: string,
  name: Parameters<KeybindingsManager["matches"]>[1],
  fallback: string[],
): boolean {
  return keys.matches(input, name) || fallback.includes(input);
}

export function formatSession(session: Session): string[] {
  const stageNumber = STAGES.indexOf(session.stage) + 1;
  const externalWorking = session.agents.filter(
    (agent) => agent.name !== "Primary agent" && agent.status === "working",
  ).length;
  return [
    session.title,
    `Stage ${stageNumber}/${STAGES.length} · ${session.stage} · ${session.state} · ${externalWorking} external working`,
  ];
}

export type DashboardAction =
  | { kind: "open" | "rename" | "remove"; title: string }
  | null;

export function renderSelected(
  state: KanbanState,
  live: LiveWidgetState = { contextWindow: 0, tokens: 0, primaryWorking: false },
): string[] {
  const view = snapshot(state, live);
  if (!view) return ["No active Kanban session. Use /kanban create <prompt>."];
  return [
    `☐ ${view.title}`,
    `  ◉ Stage ${view.stageNumber}/${STAGES.length} · ${view.stage}`,
    `  Current Pi context  ${bar(view.percent)} ${view.remaining.toLocaleString()} / ${view.contextWindow.toLocaleString()} · ${view.percent}% remaining`,
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
  const view = snapshot(state, liveWidgetState(ctx));
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
        const percentage = `${view.percent}% remaining`;
        const context = `  Current Pi context  ${bar(view.percent)} ${view.remaining.toLocaleString()} / ${view.contextWindow.toLocaleString()} · ${percentage}`;
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

export async function showDashboard(
  ctx: ExtensionCommandContext,
  state: KanbanState,
): Promise<DashboardAction> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Kanban dashboard requires an interactive Pi UI.", "info");
    return null;
  }
  return ctx.ui.custom<DashboardAction>((tui, theme, keys, done) => {
    const sessions = state.sessions;
    let selected = Math.max(
      0,
      sessions.findIndex((session) => session.title === state.selectedSessionTitle),
    );
    let managing = false;
    return {
      render: (width: number) => {
        if (!sessions.length)
          return panelLines(
            "Kanban dashboard",
            ["No active Kanban sessions.", "Use /kanban create <brief> to start one.", "", "Esc to close"],
            width,
          ).map((line, index) =>
            index === 0 ? theme.fg("accent", theme.bold(line)) : line,
          );
        const windowStart = Math.max(
          0,
          Math.min(
            selected - Math.floor(MAX_VISIBLE_SESSIONS / 2),
            Math.max(0, sessions.length - MAX_VISIBLE_SESSIONS),
          ),
        );
        const visible = sessions.slice(windowStart, windowStart + MAX_VISIBLE_SESSIONS);
        const rows = visible.flatMap((session, offset) => {
          const index = windowStart + offset;
          const [name, detail] = formatSession(session);
          return [
            `${index === selected ? "●" : " "} ${name}`,
            `  ${detail}`,
          ];
        });
        const current = sessions[selected]!;
        const [title, detail] = formatSession(current);
        const external = current.agents.filter(
          (agent) => agent.name !== "Primary agent" && agent.status === "working",
        ).length;
        const status = [
          "",
          managing ? `Manage: ${title}` : `Selected: ${title}`,
          `Status: ${detail}`,
          `Agents: ${current.agents.length} recorded · ${external} external working`,
          `Plan: .kanban/${current.planPath}`,
          "",
          managing
            ? "Enter open · r rename · x remove · Tab return · Esc close"
            : "↑/↓ or j/k move · Enter open · Tab manage · Esc close",
        ];
        return panelLines(
          managing
            ? `Kanban manage · ${selected + 1}/${sessions.length}`
            : `Kanban dashboard · ${selected + 1}/${sessions.length}`,
          [...rows, ...status],
          width,
        ).map((line) =>
          line.includes(`● ${sessions[selected]!.title}`)
            ? theme.fg("accent", theme.bold(line))
            : line,
        );
      },
      invalidate: () => {},
      handleInput: (input: string) => {
        if (!sessions.length) {
          if (matchesKey(keys, input, "tui.select.cancel", ["\u001b"])) done(null);
          tui.requestRender();
          return;
        }
        if (
          matchesKey(keys, input, "tui.select.up", ["\u001b[A", "k"]) &&
          selected > 0
        )
          selected--;
        else if (
          matchesKey(keys, input, "tui.select.down", ["\u001b[B", "j"]) &&
          selected < sessions.length - 1
        )
          selected++;
        else if (input === "\t" || input === "tab") managing = !managing;
        else if (matchesKey(keys, input, "tui.select.confirm", ["\r", "\n"]))
          done({ kind: "open", title: sessions[selected]!.title });
        else if (managing && input.toLowerCase() === "r")
          done({ kind: "rename", title: sessions[selected]!.title });
        else if (managing && input.toLowerCase() === "x")
          done({ kind: "remove", title: sessions[selected]!.title });
        else if (matchesKey(keys, input, "tui.select.cancel", ["\u001b"])) done(null);
        tui.requestRender();
      },
    };
  });
}
