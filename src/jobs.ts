/** Configured command execution and independent, recoverable scheduler observation. */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { addCoordinatorEvent, unresolvedJob, type CoordinationState, type JobRecord, type JobState } from "./coordinationstore.js";

export interface CommandResult { code: number | null; stdout: string; output: string; aborted?: boolean; timedOut?: boolean }
export type RunJobCommand = (input: {
  cwd: string; command: string; payload: Record<string, unknown>; env: Record<string, string>;
  timeoutMs: number; signal: AbortSignal; output?: (text: string) => void;
}) => Promise<CommandResult>;

/** Bounded public output; command text is configured, parameters are never interpolated. */
export const runJobCommand: RunJobCommand = (input) => new Promise((resolve) => {
  if (input.signal.aborted) { resolve({ code: null, stdout: "", output: "", aborted: true }); return; }
  let stdout = "", output = "", aborted = false, timedOut = false;
  const child = spawn("bash", ["-c", input.command], {
    cwd: input.cwd, env: { ...process.env, ...input.env }, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { /* Already gone. */ }
  };
  const stop = () => {
    kill("SIGTERM");
    if (!escalation) escalation = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const abort = () => { aborted = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const append = (kind: "stdout" | "stderr", text: string) => {
    if (kind === "stdout") stdout = (stdout + text).slice(-65536);
    output = (output + text).slice(-8000);
    input.output?.(text);
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", decoders.stdout.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", decoders.stderr.write(chunk)));
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => { output = String(error); });
  child.on("close", (code) => {
    append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    // Even a shell which exits promptly on TERM may have a surviving descendant.
    if (aborted || timedOut) kill("SIGKILL");
    input.signal.removeEventListener("abort", abort);
    resolve({ code, stdout, output, ...(aborted ? { aborted } : {}), ...(timedOut ? { timedOut } : {}) });
  });
  child.stdin.end(`${JSON.stringify(input.payload)}\n`);
});

export interface AdapterResult {
  state?: "missing" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown" | "blocked";
  externalId?: string;
  accepted?: boolean;
  artifacts?: string[];
  metric?: number;
  message?: string;
}

export function parseAdapterResult(stdout: string): AdapterResult {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("Adapter returned no JSON result");
  const value = JSON.parse(line) as AdapterResult;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Adapter result must be an object");
  if (value.state !== undefined && !["missing", "queued", "running", "succeeded", "failed", "cancelled", "unknown", "blocked"].includes(value.state))
    throw new Error("Adapter returned an invalid job state");
  if (value.externalId !== undefined && (typeof value.externalId !== "string" || !value.externalId.trim()))
    throw new Error("Adapter externalId must be a nonempty string");
  if (value.metric !== undefined && (typeof value.metric !== "number" || !Number.isFinite(value.metric)))
    throw new Error("Adapter metric must be finite");
  if (value.accepted !== undefined && typeof value.accepted !== "boolean") throw new Error("Adapter accepted must be boolean");
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length > 64 || value.artifacts.some((path) => typeof path !== "string" || !path.trim())))
    throw new Error("Adapter artifacts must be at most 64 paths");
  return value;
}

export interface JobHost {
  read(): Promise<CoordinationState>;
  change<T>(change: (state: CoordinationState) => T | Promise<T>): Promise<T>;
  signal: AbortSignal;
  env: Record<string, string>;
  output(text: string): void;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export class JobManager {
  private active = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  constructor(private host: JobHost, private command: RunJobCommand = runJobCommand) {}

  get running(): number { return this.active.size; }

  /** Idempotent in-process attachment; the durable key also guards repeated model tool calls. */
  watch(key: string): void {
    if (this.active.has(key) || this.host.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.host.signal.addEventListener("abort", abort, { once: true });
    this.controllers.set(key, controller);
    const task = this.drive(key, controller.signal).catch(async (error) => {
      if (!this.host.signal.aborted) await this.update(key, "unknown", String(error)).catch(() => undefined);
    }).finally(() => {
      this.host.signal.removeEventListener("abort", abort);
      this.controllers.delete(key); this.active.delete(key);
    });
    this.active.set(key, task);
  }

  async reconnect(): Promise<void> {
    for (const job of Object.values((await this.host.read()).jobs))
      if (unresolvedJob(job) || (job.adapter.kind === "scheduled" && !job.collected)) this.watch(job.key);
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.active.values()]); }

  private async update(key: string, state: JobState, error?: string, patch: Partial<JobRecord> = {}): Promise<void> {
    const previous = (await this.host.read()).jobs[key];
    if (!previous) return;
    if (previous.state === state && previous.error === error &&
      Object.entries(patch).every(([field, value]) => JSON.stringify(previous[field as keyof JobRecord]) === JSON.stringify(value))) return;
    await this.host.change((value) => {
      const job = value.jobs[key];
      if (!job) return;
      const changed = job.state !== state || job.error !== error || patch.collected !== undefined;
      Object.assign(job, patch, { state });
      if (error) job.error = error.slice(0, 2000); else delete job.error;
      if (changed) addCoordinatorEvent(value, patch.collected ? "job_result" : "job_state",
        `${job.name}: ${state}${error ? `: ${error}` : ""}${patch.collected ? `; evidence accepted=${job.accepted}` : ""}`,
        job.lane, `job:${key}:${state}:${patch.collected ? "collected" : error ?? ""}`);
    });
  }

  private async invoke(job: JobRecord, operation: "command" | "submit" | "status" | "cancel" | "collect", signal: AbortSignal): Promise<CommandResult> {
    const command = job.adapter[operation];
    if (!command) throw new Error(`Adapter ${job.adapterName} has no ${operation} command`);
    return this.command({
      cwd: job.worktree, command, signal,
      timeoutMs: operation === "command" ? Math.max(1, job.deadline - Date.now()) : job.adapter.operationTimeoutMs ?? 30000,
      payload: { operation, key: job.key, externalId: job.externalId, params: job.params, revision: job.revision, sourceCommit: job.sourceCommit },
      env: { ...(job.env ?? this.host.env), KANBAN_JOB_KEY: job.key, KANBAN_JOB_NAME: job.name, KANBAN_GOAL_REVISION: String(job.revision), ...(job.externalId ? { KANBAN_JOB_ID: job.externalId } : {}) },
      output: (text) => this.host.output(`[${job.name}/${operation}] ${text}`),
    });
  }

  private async result(job: JobRecord, operation: "submit" | "status" | "cancel" | "collect", signal: AbortSignal): Promise<AdapterResult> {
    const outcome = await this.invoke(job, operation, signal);
    if (outcome.aborted) throw new Error("Adapter operation interrupted; reconcile before retrying");
    if (outcome.timedOut || outcome.code !== 0) throw new Error(`${operation} ${outcome.timedOut ? "timed out" : `exited ${outcome.code}`}: ${outcome.output}`);
    return parseAdapterResult(outcome.stdout);
  }

  private async drive(key: string, signal: AbortSignal): Promise<void> {
    let job = (await this.host.read()).jobs[key];
    if (!job) return;
    if (job.collected && !unresolvedJob(job)) return;
    if (job.adapter.kind === "local") {
      if (job.submitted) {
        await this.update(key, "failed", "Local command was interrupted; its output cannot establish acceptance. Request a fresh attempt.");
        return;
      }
      await this.host.change((value) => { value.jobs[key].submitted = true; });
      await this.update(key, "running");
      const result = await this.invoke(job, "command", signal);
      if (this.host.signal.aborted) return;
      const pass = result.code === 0 && !result.timedOut && !result.aborted;
      let evidence: AdapterResult = {}, evidenceError: string | undefined;
      try { evidence = parseAdapterResult(result.stdout); } catch (error) { evidenceError = `Invalid local adapter result: ${String(error)}`; }
      await this.update(key, result.aborted ? "cancelled" : pass ? "succeeded" : "failed",
        pass ? evidenceError : result.timedOut ? "Local command timed out" : result.output,
        { collected: true, accepted: pass && evidence.accepted === true && !evidenceError, artifacts: evidence.artifacts, metric: evidence.metric, output: result.output });
      return;
    }

    // Reconcile first, even for a recorded intent with no scheduler receipt. The adapter's
    // 'missing' verdict MUST be authoritative for this stable submission key.
    let result = await this.result(job, "status", signal);
    if (result.state === "missing") {
      if (job.externalId) { await this.update(key, "unknown", "Scheduler cannot find the recorded job; do not resubmit"); return; }
      const allowed = await this.host.change((value) => {
        const current = value.jobs[key];
        if (value.pendingRevision || current.cancelRequested) return false;
        current.submitted = true;
        return true;
      });
      if (!allowed) { await this.update(key, "cancelled", "Submission deferred by goal revision or stop"); return; }
      result = await this.result(job, "submit", signal);
      if (!result.externalId) throw new Error("Submit did not return an externalId; reconcile its key before retrying");
    }
    for (;;) {
      if (signal.aborted) return;
      if (!result.state || result.state === "missing") throw new Error("Status did not establish a scheduler state");
      if (result.externalId) {
        if (job.externalId && job.externalId !== result.externalId) throw new Error("Adapter changed the scheduler identity for an existing job");
        job.externalId = result.externalId;
      }
      await this.update(key, result.state, result.message, { ...(job.externalId ? { externalId: job.externalId } : {}) });
      job = (await this.host.read()).jobs[key];
      if (["succeeded", "failed", "cancelled"].includes(job.state)) {
        // Collection is also useful after a failed training/postprocessing command.
        let evidence: AdapterResult;
        try { evidence = await this.result(job, "collect", signal); }
        catch (error) {
          if (!this.host.signal.aborted) await this.update(key, job.state, `Collection failed: ${String(error)}`, { collected: true, accepted: false });
          return;
        }
        await this.update(key, job.state, evidence.message, {
          collected: true, accepted: evidence.accepted === true && Boolean(evidence.artifacts?.length),
          artifacts: evidence.artifacts, metric: evidence.metric,
        });
        return;
      }
      if (job.state === "unknown" || job.state === "blocked") return;
      if (job.cancelRequested || Date.now() >= job.deadline) {
        result = await this.result(job, "cancel", signal);
        if (!["cancelled", "succeeded", "failed"].includes(result.state ?? "")) {
          await this.update(key, "unknown", "Cancellation is not confirmed; preserve the job and worktree"); return;
        }
        continue;
      }
      await delay(Math.min(job.adapter.pollIntervalMs ?? 30000, Math.max(1, job.deadline - Date.now())), signal);
      if (signal.aborted) return;
      result = await this.result(job, "status", signal);
    }
  }

  /** Explicit stop differs from process shutdown, which only aborts local observers. */
  async cancel(key: string): Promise<void> {
    const job = (await this.host.read()).jobs[key];
    if (!job || !unresolvedJob(job)) return;
    await this.host.change((value) => { value.jobs[key].cancelRequested = true; });
    if (job.adapter.kind === "local") { this.controllers.get(key)?.abort(); return; }
    // Avoid a competing status/submit operation: interrupt the observer, then reconcile.
    this.controllers.get(key)?.abort();
    await this.active.get(key);
    this.watch(key);
  }
}
