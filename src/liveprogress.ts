import { stripVTControlCharacters } from "node:util";

/** Bounded, process-local display data. Durable decisions remain in the loop log. */
export interface LiveLoopProgress {
  title: string;
  goal: string;
  iteration: number;
  maxIterations: number;
  metricName?: string;
  direction: "higher" | "lower";
  target?: number;
  baseline?: number;
  best?: number;
  latest?: number;
  comment?: string;
  activity: string;
  childRunning: boolean;
  output: string;
  startedAt: number;
  updatedAt: number;
  active: boolean;
}

const bySession = new Map<string, LiveLoopProgress>();
const bySignal = new WeakMap<AbortSignal, LiveLoopProgress>();
const key = (cwd: string, base: string) => JSON.stringify([cwd, base]);

export function displayText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function beginLoopProgress(
  cwd: string, base: string, signal: AbortSignal,
  initial: Pick<LiveLoopProgress, "title" | "goal" | "maxIterations" | "direction" | "target" | "metricName">,
): LiveLoopProgress {
  const progress: LiveLoopProgress = {
    ...initial, goal: displayText(initial.goal).slice(0, 4000), iteration: 0,
    activity: "preparing experiment", childRunning: false, output: "",
    startedAt: Date.now(), updatedAt: Date.now(), active: !signal.aborted,
  };
  bySession.delete(key(cwd, base));
  bySession.set(key(cwd, base), progress);
  if (bySession.size > 16) bySession.delete(bySession.keys().next().value!);
  bySignal.set(signal, progress);
  signal.addEventListener("abort", () => endLoopProgress(signal, "stopped"), { once: true });
  return progress;
}

export function loopProgress(cwd: string, base: string): LiveLoopProgress | undefined {
  return bySession.get(key(cwd, base));
}

export function updateLoopProgress(signal: AbortSignal, update: Partial<LiveLoopProgress>): void {
  const progress = bySignal.get(signal);
  if (!progress?.active || signal.aborted) return;
  Object.assign(progress, update, { updatedAt: Date.now() });
}

export function appendLiveOutput(signal: AbortSignal, text: string): void {
  const progress = bySignal.get(signal);
  if (!progress?.active || signal.aborted) return;
  progress.output = (progress.output + displayText(text)).slice(-8000);
  progress.updatedAt = Date.now();
}

export function endLoopProgress(signal: AbortSignal, activity?: string): void {
  const progress = bySignal.get(signal);
  if (!progress) return;
  progress.active = false;
  progress.childRunning = false;
  if (activity) progress.activity = activity;
  progress.updatedAt = Date.now();
  bySignal.delete(signal);
}
