/** Process-local notifications. No timers, polling, model calls, or durable state. */
export type ProgressEvent = "live" | "usage" | "records" | "selection";
const listeners = new Map<string, Set<(events: ReadonlySet<ProgressEvent>) => void>>();
const pending = new Map<string, Set<ProgressEvent>>();

export function publishProgress(cwd: string, event: ProgressEvent): void {
  if (!listeners.get(cwd)?.size) return;
  const batch = pending.get(cwd);
  if (batch) { batch.add(event); return; }
  const events = new Set([event]);
  pending.set(cwd, events);
  queueMicrotask(() => {
    pending.delete(cwd);
    for (const listener of listeners.get(cwd) ?? []) {
      try { listener(events); } catch { /* Display observers cannot fail work. */ }
    }
  });
}

export function subscribeProgress(
  cwd: string,
  listener: (events: ReadonlySet<ProgressEvent>) => void,
): () => void {
  const group = listeners.get(cwd) ?? new Set();
  group.add(listener);
  listeners.set(cwd, group);
  return () => {
    group.delete(listener);
    if (!group.size && listeners.get(cwd) === group) listeners.delete(cwd);
  };
}
