/** Ephemeral progress only: never writes state, plans, or handoffs. */
const timings = new Map<string, number[]>();

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export class PipelineProgress {
  private readonly started: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly children = new Map<string, { done: boolean; failed: boolean; activity: string; at: number }>();
  private waiting?: string;
  private stopped = false;

  constructor(
    private readonly stage: string,
    private readonly next: string,
    private readonly key: string,
    private readonly timeoutMs: number,
    private readonly publish: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref();
  }

  start(label: string): void {
    this.children.set(label, { done: false, failed: false, activity: "starting", at: this.now() });
    this.render();
  }

  activity(label: string, line: string): void {
    const child = this.children.get(label);
    if (!child || child.done || this.stopped) return;
    child.activity = line.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100);
    child.at = this.now();
    // The heartbeat renders streaming updates at most once a second.
  }

  finish(label: string, failed: boolean): void {
    const child = this.children.get(label);
    if (!child || child.done || this.stopped) return;
    child.done = true;
    child.failed = failed;
    this.render();
  }

  question(index: number, total: number): void {
    this.waiting = `waiting for answer ${index}/${total}`;
    this.render();
  }

  render(): void {
    if (this.stopped) return;
    const elapsed = this.now() - this.started;
    const children = [...this.children.entries()];
    const active = children.filter(([, child]) => !child.done);
    const done = children.length - active.length;
    const failed = children.filter(([, child]) => child.failed).length;
    const samples = timings.get(this.key) ?? [];
    const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    const eta = this.waiting ? "ETA waits for you" : !samples.length
      ? "ETA unknown (no history)"
      : elapsed >= average * 1.3 ? "longer than recent runs; ETA uncertain"
        : `~${duration(Math.max(0, average * 0.7 - elapsed))}–${duration(average * 1.3 - elapsed)} left (recent runs)`;
    const activity = this.waiting ?? (active.length
      ? active.map(([label, child]) => `${label}: ${child.activity} (${duration(this.now() - child.at)} ago)`).join("; ")
      : "recording findings");
    this.publish(`kanban ${this.stage} → ${this.next} · ${duration(elapsed)} elapsed · ${active.length} running · ${done}/${children.length} finished${failed ? ` (${failed} failed)` : ""} · ${eta} · child limit ${duration(this.timeoutMs)} · ${activity}`);
  }

  stop(success: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    // Human response time is not a model-duration sample.
    if (success && !this.waiting && this.children.size && [...this.children.values()].every((child) => child.done && !child.failed)) {
      const samples = timings.get(this.key) ?? [];
      timings.delete(this.key);
      timings.set(this.key, [...samples, this.now() - this.started].slice(-5));
      if (timings.size > 32) timings.delete(timings.keys().next().value!);
    }
  }
}
