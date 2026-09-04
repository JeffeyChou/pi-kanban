import type {
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { STAGES, selectedSession, type KanbanState, type Session } from "./store.js";
import {
  readLoopLog,
  readLoopRun,
  type LoopIterationRecord,
  type LoopRunManifest,
} from "./looplog.js";
import { readPlan, type PlanSnapshot } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { displayText, loopProgress, type LiveLoopProgress } from "./liveprogress.js";
import { getUsage, usageLines } from "./usage.js";
import { readWorkfile, workfileBase } from "./workfile.js";

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
const selectedForWidget = new Map<string, string | undefined>();
const loopWidgets = new Map<string, () => void>();
const widgetStates = new Map<string, KanbanState>();

function contextRow(ctx: ExtensionContext, view: WidgetSnapshot): { text: string; percent: number } {
  const usage = getUsage(ctx.cwd, view.title);
  if (usage?.active && usage.stage === view.stage && usage.children.length) {
    const active = usage.children.filter((child) => child.active);
    const candidates = active.length ? active : usage.children;
    const known = candidates.filter((child) => child.contextTokens !== undefined && child.contextWindow > 0);
    const pending = candidates.length - known.length;
    const label = `${view.stage} context${candidates.length > 1 ? " (min)" : " (child)"}`;
    if (!known.length) return { text: `  ${label} · awaiting usage`, percent: 100 };
    const child = known.reduce((worst, item) =>
      (item.contextTokens! / item.contextWindow) > (worst.contextTokens! / worst.contextWindow) ? item : worst);
    const remaining = Math.max(0, child.contextWindow - child.contextTokens!);
    const percent = Math.round(100 * remaining / child.contextWindow);
    return {
      text: `  ${label} ${bar(percent)} ${remaining.toLocaleString()} / ${child.contextWindow.toLocaleString()} · ${percent}% remaining${child.contextStale ? " · last known (compacted)" : " · est."}${pending ? ` · ${pending} awaiting usage` : ""}`,
      percent,
    };
  }
  return {
    text: `  Current Pi context  ${bar(view.percent)} ${view.remaining.toLocaleString()} / ${view.contextWindow.toLocaleString()} · ${view.percent}% remaining`,
    percent: view.percent,
  };
}

/** Read-only refresh while internal children run; no state reload or write per tick. */
export function startUsageDisplay(ctx: ExtensionContext, signal: AbortSignal): () => void {
  let stopped = false;
  const refresh = () => {
    const state = widgetStates.get(ctx.cwd);
    if (state) void refreshWidget(ctx, state).catch(() => {});
  };
  const timer = setInterval(refresh, 1000);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
    refresh();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return stop;
}

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
  widgetStates.set(ctx.cwd, state);
  selectedForWidget.set(ctx.cwd, state.selectedSessionTitle);
  const view = snapshot(state, liveWidgetState(ctx));
  const usage = view ? getUsage(ctx.cwd, view.title) : undefined;
  ctx.ui.setStatus?.("kanban-usage", usage ? usageLines(usage)[0] : undefined);
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
        const current = snapshot(state, liveWidgetState(ctx)) ?? view;
        const context = contextRow(ctx, current);
        const stage = `  ◉ Stage ${view.stageNumber}/${STAGES.length} · ${view.stage}`;
        const agents = `  ● Agents working ${view.agentsWorking}`;
        return [
          theme.fg("accent", theme.bold(truncate(`☐ ${view.title}`, width))),
          theme.fg("accent", truncate(stage, width)),
          theme.fg(contextColor(context.percent), truncate(context.text, width)),
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

function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderLoopProgress(progress: LiveLoopProgress): string[] {
  const metric = progress.metricName ?? "metric";
  return [
    `Goal: ${progress.goal.replace(/\s+/g, " ")}`,
    `Iteration ${progress.iteration}/${progress.maxIterations} (attempt budget) · ${progress.childRunning ? 1 : 0} child running · ${elapsedText((progress.active ? Date.now() : progress.updatedAt) - progress.startedAt)} elapsed`,
    `${metric}: baseline ${progress.baseline ?? "—"} · latest ${progress.latest ?? "—"} · best ${progress.best ?? "—"} · target ${progress.target ?? "not set"} · ${progress.direction} is better`,
    `${progress.activity} · activity ${elapsedText(Date.now() - progress.updatedAt)} ago`,
    progress.comment ? `Decision: ${progress.comment}` : "Awaiting the first measured decision",
    `Output: ${progress.output.trim().split("\n").at(-1) || "waiting for child or measurement output"}`,
  ].map(displayText);
}

/** A separate implement panel; the board widget stays four rows. */
export function startLoopWidget(ctx: ExtensionCommandContext, base: string, signal: AbortSignal): void {
  if (!ctx.hasUI || signal.aborted) return;
  loopWidgets.get(ctx.cwd)?.();
  let stopped = false;
  const render = () => {
    const live = loopProgress(ctx.cwd, base);
    if (!live?.active) { stop(); return; }
    if (selectedForWidget.get(ctx.cwd) !== live.title) {
      ctx.ui.setWidget("kanban-progress", undefined);
      return;
    }
    ctx.ui.setWidget("kanban-progress", (_tui, theme) => ({
      render: (width) => panelLines("Implement · /kanban progress for details", renderLoopProgress(live), width)
        .map((line, index) => index === 0 ? theme.fg("accent", line) : line),
      invalidate: () => {},
    }), { placement: "aboveEditor" });
  };
  const timer = setInterval(render, 1000);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
    if (loopWidgets.get(ctx.cwd) === stop) {
      loopWidgets.delete(ctx.cwd);
      ctx.ui.setWidget("kanban-progress", undefined);
    }
  };
  loopWidgets.set(ctx.cwd, stop);
  signal.addEventListener("abort", stop, { once: true });
  render();
}

function wrapped(text: string, width: number): string[] {
  const result: string[] = [];
  const limit = Math.max(10, width - 4);
  for (const line of displayText(text).split("\n")) {
    const chars = Array.from(line);
    if (!chars.length) result.push("");
    while (chars.length) result.push(chars.splice(0, limit).join(""));
  }
  return result;
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

/**
 * A live, explicit experiment table. It intentionally is not another selected-session widget
 * row: the compact four-line widget remains the low-noise board summary while this panel polls
 * the append-only durable experiment log.
 */
export async function showExperimentDashboard(
  ctx: ExtensionCommandContext,
  base: string,
  session?: Session,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Kanban experiment dashboard requires an interactive Pi UI.", "info");
    return;
  }
  const config = (await loadConfig(ctx.cwd)).config;
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let manifest: LoopRunManifest | undefined;
    let plan: PlanSnapshot | undefined;
    let records: LoopIterationRecord[] = [];
    let closed = false;
    let refreshing = false;
    let offset = 0;
    let outputOffset = 0;
    let outputLines = 0;
    const refresh = async () => {
      if (refreshing || closed) return;
      refreshing = true;
      const [nextManifest, nextRecords, nextPlan] = await Promise.all([
        readLoopRun(ctx.cwd, base),
        readLoopLog(ctx.cwd, base),
        session ? readPlan(ctx.cwd, session.planPath) : Promise.resolve(undefined),
      ]).catch((): [LoopRunManifest | undefined, LoopIterationRecord[], PlanSnapshot | undefined] => [undefined, [], undefined]);
      refreshing = false;
      if (closed) return;
      manifest = nextManifest;
      records = nextRecords;
      plan = nextPlan;
      tui.requestRender();
    };
    const timer = setInterval(() => void refresh(), 750);
    void refresh();
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      done(undefined);
    };
    return {
      render: (width) => {
        const live = loopProgress(ctx.cwd, base);
        const usage = session ? getUsage(ctx.cwd, session.title) : undefined;
        const latest = records.at(-1);
        const chosen = records[Math.max(0, records.length - 1 - offset)];
        const values = records.filter((record) => record.metric !== undefined).slice(-12).map((record) => record.metric!);
        const low = Math.min(...values), high = Math.max(...values);
        const trend = values.map((value) => "▁▂▃▄▅▆▇█"[high === low ? 3 : Math.round((value - low) / (high - low) * 7)]).join("");
        const output = wrapped(live?.output || latest?.validationTail || "No captured output yet.", width);
        outputLines = output.length;
        outputOffset = Math.min(outputOffset, Math.max(0, outputLines - 6));
        const rows = [
          ...wrapped(`Goal: ${live?.goal || plan?.prompt || session?.title || base}`, width).slice(0, 5),
          ...(usage ? usageLines(usage) : []),
          ...(live ? renderLoopProgress(live).slice(1, 5) : [
            manifest ? "No live child telemetry in this Pi process; showing saved results."
              : usage?.active ? `Internal ${usage.stage} children are running; usage is sampled from their Pi sessions.`
                : "Agent-owned implementation: activity and output appear in the main Pi conversation.",
            ...(plan?.work.current ?? []).map((line) => `Current checkpoint: ${line}`),
            ...(plan?.agents ?? []).map((agent) => `${agent.name}: ${agent.role} · ${agent.status}`),
          ]),
          manifest
            ? `Branch ${manifest.branch} · ${manifest.status} · next #${manifest.nextIteration}`
            : "No durable autoresearch run for this session.",
          manifest
            ? `Baseline ${manifest.baselineMetric ?? "n/a"} · latest ${latest?.metric ?? "n/a"} · best ${manifest.bestMetric ?? "n/a"} · target ${live?.target ?? config.loop.target ?? "not set"}`
            : "Checkpoints are recorded with kanban_update; external child output belongs to its scheduler.",
          ...(values.length ? [`Recent metrics ${trend} · ${live?.direction ?? config.loop.direction} is better · min ${low}, max ${high}`] : []),
          "",
          "#   decision        metric       validation  commit       rationale / reason",
          ...records.slice(Math.max(0, records.length - 6 - offset), records.length - offset).reverse().map((record) => {
            const decision = record.decision === "keep"
              ? `keep (${record.agentDecision ?? "?"})`
              : `revert (${record.agentDecision ?? "?"})`;
            const metric = record.metric === undefined ? "—" : String(record.metric);
            const validation = record.validation === undefined ? "—" : record.validation ? "pass" : "FAIL";
            const commit = record.commit?.slice(0, 10) ?? "—";
            const note = record.failureReason ?? record.changed?.split("\n").at(-1) ?? record.lesson ?? "";
            return `${String(record.iteration).padEnd(3)} ${pad(decision, 15)} ${pad(metric, 12)} ${pad(validation, 11)} ${pad(commit, 11)} ${note}`;
          }),
          ...(chosen ? wrapped(`Iteration ${chosen.iteration} comment: ${chosen.failureReason ?? chosen.changed ?? chosen.lesson ?? "No comment recorded."}`, width).slice(0, 4) : []),
          "",
          live?.active ? "Live output (bounded tail):" : "Latest output (bounded tail; live text lasts for this Pi process):",
          ...output.slice(Math.max(0, outputLines - 6 - outputOffset), outputLines - outputOffset),
          "",
          "↑/↓ attempts · PgUp/PgDn output · Esc closes · auto-refresh 0.75s",
          "Stop the loop: /kanban implement stop",
        ];
        return panelLines("Kanban implement progress", rows.map(displayText), width).map((line, index) =>
          index === 0 ? theme.fg("accent", theme.bold(line)) : line,
        );
      },
      invalidate: () => {},
      dispose: () => { closed = true; clearInterval(timer); },
      handleInput: (input) => {
        if (matchesKey(keys, input, "tui.select.cancel", ["\u001b"])) finish();
        else if (matchesKey(keys, input, "tui.select.up", ["\u001b[A", "k"])) offset = Math.min(Math.max(0, records.length - 1), offset + 1);
        else if (matchesKey(keys, input, "tui.select.down", ["\u001b[B", "j"])) offset = Math.max(0, offset - 1);
        else if (input === "\u001b[5~") outputOffset = Math.min(Math.max(0, outputLines - 6), outputOffset + 6);
        else if (input === "\u001b[6~") outputOffset = Math.max(0, outputOffset - 6);
        tui.requestRender();
      },
    };
  });
}

/** Inspect the composed Markdown plan without switching conversations or mutating it. */
export async function showComposedPlan(ctx: ExtensionCommandContext, session: Session): Promise<void> {
  const body = (await readWorkfile(ctx.cwd, workfileBase(session.planPath))).sections.compose;
  if (!body?.trim()) {
    ctx.ui.notify(`No composed plan is recorded for “${session.title}” yet.`, "info");
    return;
  }
  if (!ctx.hasUI || ctx.mode === "rpc") {
    ctx.ui.notify(`## compose\n${body}`, "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let offset = 0;
    let total = 0;
    const page = Math.max(5, Math.min(24, (tui.terminal.rows || 30) - 8));
    return {
      render: (width) => {
        const lines = wrapped(body, width);
        total = lines.length;
        offset = Math.min(offset, Math.max(0, total - page));
        return panelLines(`Plan · ${session.title}`, [
          ...lines.slice(offset, offset + page), "",
          `${offset + 1}–${Math.min(total, offset + page)} / ${total} display lines · ↑/↓ scroll · PgUp/PgDn page · Esc closes`,
        ], width).map((line, index) => index === 0 ? theme.fg("accent", theme.bold(line)) : line);
      },
      invalidate: () => {},
      handleInput: (input) => {
        if (matchesKey(keys, input, "tui.select.cancel", ["\u001b"])) done(undefined);
        else if (matchesKey(keys, input, "tui.select.up", ["\u001b[A", "k"])) offset = Math.max(0, offset - 1);
        else if (matchesKey(keys, input, "tui.select.down", ["\u001b[B", "j"])) offset = Math.min(Math.max(0, total - page), offset + 1);
        else if (input === "\u001b[5~") offset = Math.max(0, offset - page);
        else if (input === "\u001b[6~") offset = Math.min(Math.max(0, total - page), offset + page);
        tui.requestRender();
      },
    };
  });
}
