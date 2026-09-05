import type { Stage } from "./store.js";
import { publishProgress } from "./progressevents.js";

/** Current context is per child; billed token/cost totals span that child's requests. */
export interface ChildUsage {
  label: string;
  model: string;
  contextWindow: number;
  contextTokens?: number;
  contextStale: boolean;
  totalTokens: number;
  cost?: number;
  active: boolean;
}

export interface UsageRun {
  cwd: string;
  stage?: Stage;
  active: boolean;
  children: ChildUsage[];
  stageCost: number;
  stageTokens: number;
  stageReports: number;
  stageChildren: number;
  totalCost: number;
  totalTokens: number;
  reports: number;
  totalChildren: number;
}

const sessions = new Map<string, UsageRun>();
const runs = new WeakMap<AbortSignal, UsageRun>();
const children = new WeakMap<AbortSignal, { run: UsageRun; child: ChildUsage }>();
const key = (cwd: string, title: string) => JSON.stringify([cwd, title]);

export function getUsage(cwd: string, title: string): UsageRun | undefined {
  return sessions.get(key(cwd, title));
}

/** Retain tracked cost across runs for this title, only in this Pi process. */
export function beginUsage(cwd: string, title: string, signal: AbortSignal): void {
  const previous = getUsage(cwd, title);
  const run: UsageRun = {
    cwd,
    active: !signal.aborted, children: [], stageCost: 0, stageTokens: 0,
    stageReports: 0, stageChildren: 0,
    totalCost: previous?.totalCost ?? 0, totalTokens: previous?.totalTokens ?? 0,
    reports: previous?.reports ?? 0, totalChildren: previous?.totalChildren ?? 0,
  };
  sessions.delete(key(cwd, title));
  sessions.set(key(cwd, title), run);
  if (sessions.size > 16) sessions.delete(sessions.keys().next().value!);
  runs.set(signal, run);
  publishProgress(cwd, "usage");
  signal.addEventListener("abort", () => endUsage(signal), { once: true });
}

export function beginChildUsage(
  runSignal: AbortSignal, childSignal: AbortSignal, stage: Stage, label: string,
  model: { provider: string; id: string; contextWindow: number },
): void {
  const run = runs.get(runSignal);
  if (!run?.active || childSignal.aborted) return;
  if (run.stage !== stage) {
    run.stage = stage;
    run.children = [];
    run.stageCost = run.stageTokens = run.stageReports = run.stageChildren = 0;
  }
  const child: ChildUsage = {
    label, model: `${model.provider}:${model.id}`, contextWindow: model.contextWindow,
    contextStale: false, totalTokens: 0, active: true,
  };
  // Keep independent live windows; never replace a coordinator with its newest worker.
  if (stage === "implement") run.children = run.children.filter((child) => child.active);
  run.children.push(child);
  run.stageChildren++;
  run.totalChildren++;
  children.set(childSignal, { run, child });
  publishProgress(run.cwd, "usage");
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** SDK totals are cumulative snapshots, so repeated events must never double count. */
export function reportUsage(signal: AbortSignal, snapshot: {
  contextTokens?: number | null;
  contextWindow?: number;
  totalTokens?: number;
  cost?: number;
}): void {
  const target = children.get(signal);
  if (!target?.run.active || !target.child.active || signal.aborted) return;
  const { run, child } = target;
  const before = [child.contextWindow, child.contextTokens, child.contextStale, child.totalTokens, child.cost];
  if (nonnegative(snapshot.contextWindow) && snapshot.contextWindow > 0)
    child.contextWindow = snapshot.contextWindow;
  if (snapshot.contextTokens === null) child.contextStale = true;
  else if (nonnegative(snapshot.contextTokens)) {
    child.contextTokens = snapshot.contextTokens;
    child.contextStale = false;
  }
  if (nonnegative(snapshot.totalTokens)) {
    const delta = Math.max(0, snapshot.totalTokens - child.totalTokens);
    child.totalTokens += delta;
    run.totalTokens += delta;
    run.stageTokens += delta;
  }
  if (nonnegative(snapshot.cost)) {
    if (child.cost === undefined) { run.reports++; run.stageReports++; }
    const delta = Math.max(0, snapshot.cost - (child.cost ?? 0));
    child.cost = (child.cost ?? 0) + delta;
    run.totalCost += delta;
    run.stageCost += delta;
  }
  const after = [child.contextWindow, child.contextTokens, child.contextStale, child.totalTokens, child.cost];
  if (after.some((value, index) => value !== before[index])) publishProgress(run.cwd, "usage");
}

export function finishChildUsage(signal: AbortSignal): void {
  const target = children.get(signal);
  if (target) target.child.active = false;
  children.delete(signal);
  if (target) publishProgress(target.run.cwd, "usage");
}

export function endUsage(signal: AbortSignal): void {
  const run = runs.get(signal);
  if (run) {
    run.active = false;
    for (const child of run.children) child.active = false;
  }
  runs.delete(signal);
  if (run) publishProgress(run.cwd, "usage");
}

export function costText(cost: number, reports: number, count: number): string {
  if (!reports) return count ? "awaiting usage" : "$0.0000";
  return `$${cost.toFixed(4)}${reports < count ? " + unreported" : ""}`;
}

export function usageLines(run: UsageRun): string[] {
  return [
    `Child cost estimate: ${run.stage ?? "stage"} ${costText(run.stageCost, run.stageReports, run.stageChildren)} · tracked total ${costText(run.totalCost, run.reports, run.totalChildren)}`,
    ...run.children.map((child) => {
      const capacity = child.contextWindow.toLocaleString();
      const context = child.contextTokens === undefined
        ? `context awaiting usage / ${capacity}`
        : `${Math.max(0, child.contextWindow - child.contextTokens).toLocaleString()} / ${capacity} remaining${child.contextStale ? " (last known; compacted)" : " (estimate)"}`;
      return `${child.label} · ${child.model} · ${context} · ${child.cost === undefined ? "cost awaiting usage" : `$${child.cost.toFixed(4)}`}`;
    }),
    `Tracked child tokens: stage ${run.stageTokens.toLocaleString()} · total ${run.totalTokens.toLocaleString()} (includes cache tokens; not context size)`,
  ];
}
