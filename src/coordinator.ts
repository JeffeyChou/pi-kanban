import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { readPlan, writePlan } from "./artifacts.js";
import { appendAttention } from "./attention.js";
import { isSingleShot } from "./capabilities.js";
import { validateLoopRevision, type LoopConfig, type NetworkConfig, type WorktreeConfig } from "./config.js";
import {
  addCoordinatorEvent, coordinationLines, observeCoordinator, readCoordination,
  turnBudgetBlocker, unresolvedJob, updateCoordination, writeCoordination,
  type CoordinationState, type JobRecord, type LaneRecord,
} from "./coordinationstore.js";
import { COORDINATOR_SYSTEM, workerSystem } from "./coordinatorprompts.js";
import { networkEnabledFor, networkTools } from "./nettools.js";
import { createIterationSession, type IterationSession, type IterationSessionFactory } from "./iterationsession.js";
import { JobManager, type RunJobCommand } from "./jobs.js";
import { appendLiveOutput, linkLoopProgress, updateLoopProgress } from "./liveprogress.js";
import { registerWorktree } from "./looplog.js";
import { measure, type MeasureOutcome } from "./measure.js";
import type { LoopRunHandle } from "./orchestrator.js";
import { readCarried, type CarryResult } from "./carry.js";
import { carryIntoWorktree, changedWorktreePaths, capturePatch, headCommit, landPatch, snapshotWorktree } from "./worktree.js";
import { writeWorkfileSection } from "./workfile.js";

export interface CoordinateInput {
  handle: LoopRunHandle;
  base: string;
  iteration: number;
  worktree: string;
  goal: string;
  spec: string;
  loop: LoopConfig;
  /** Which untracked files reach a child worktree; see carry.ts. */
  worktreeConfig: WorktreeConfig;
  /** Outbound network granted to lane children, when enabled. */
  network: NetworkConfig;
  model: Model<any>;
  bestMetric?: number;
  lessons?: string;
  hookNote?: string;
  factory?: IterationSessionFactory;
  command?: RunJobCommand;
  measure?: typeof measure;
}

export interface CoordinateResult {
  decision: "keep" | "revert";
  verdict: "complete" | "continue";
  rationale: string;
  measured: MeasureOutcome;
  revision: number;
  loop: LoopConfig;
  goal: string;
  spec: string;
  evidence: boolean;
  stop?: string;
  metricReset?: boolean;
  baselineMetric?: number;
  auditWorktree?: string;
}
export type RunCoordinator = (input: CoordinateInput) => Promise<CoordinateResult>;

const slug = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "lane";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const candidateIdentity = (lane: LaneRecord) => hash(`${lane.candidateBase ?? lane.baseCommit}\n${lane.candidate ?? ""}`);
const StringList = Type.Array(Type.String());
const LaneName = Type.String({ minLength: 1, maxLength: 100 });
function tool(name: string, description: string, parameters: any, run: (args: any, id: string) => Promise<unknown>): ToolDefinition {
  return { name, label: name, description, parameters,
    async execute(id, args) {
      try { return { content: [{ type: "text", text: JSON.stringify(await run(args, id)) }], details: {} }; }
      catch (error) { return { content: [{ type: "text", text: `Refused: ${error instanceof Error ? error.message : String(error)}` }], details: { refused: true } }; }
    },
  };
}

interface LiveCoordinator { cancelJobs(): Promise<boolean>; wake(): void }
const live = new Map<string, LiveCoordinator>();
const liveKey = (cwd: string, base: string) => JSON.stringify([cwd, base]);
export async function cancelCoordinatorJobs(cwd: string, base: string): Promise<boolean> {
  const owner = live.get(liveKey(cwd, base));
  if (owner) return owner.cancelJobs();
  const saved = await readCoordination(cwd, base);
  return !saved || !Object.values(saved.jobs).some(unresolvedJob);
}

export const runCoordinator: RunCoordinator = async (input) => {
  const runtime = new IterationCoordinator(input);
  return runtime.run();
};

/** One event consumer and one model session; children and jobs never join its turn. */
class IterationCoordinator {
  private readonly cwd: string;
  private readonly signal: AbortSignal;
  private readonly sessionDir: string;
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly childControllers = new Map<string, AbortController>();
  private readonly jobs: JobManager;
  private coordinator?: IterationSession;
  private coordinatorController = new AbortController();
  private wakeCount = 0;
  private waiter?: () => void;
  private measuring = false;
  private measurementTask?: Promise<void>;
  private measurementController?: AbortController;
  private stopping = false;
  private carriedReported = false;
  private taskController = new AbortController();
  private rosterKey?: string;

  constructor(private input: CoordinateInput) {
    this.cwd = input.handle.ctx.cwd;
    this.signal = input.handle.signal;
    this.sessionDir = join(this.cwd, ".kanban", "loop", `${input.base}.sessions`, String(input.iteration));
    this.jobs = new JobManager({
      read: () => this.read(), change: (fn) => this.change(fn), signal: this.taskController.signal,
      env: {
        KANBAN_ITERATION: String(input.iteration), KANBAN_MAX_ITERATIONS: String(input.loop.maxIterations),
        KANBAN_BASE: input.base, ...(input.bestMetric === undefined ? {} : { KANBAN_BEST_METRIC: String(input.bestMetric) }),
      }, output: (text) => appendLiveOutput(this.signal, text),
    }, input.command);
  }

  private async read(): Promise<CoordinationState> {
    const value = await readCoordination(this.cwd, this.input.base);
    if (!value || value.token !== this.input.handle.token) throw new Error("Coordinator ownership changed");
    return value;
  }

  private change<T>(fn: (state: CoordinationState) => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new Error("Coordinator suspended"));
    return updateCoordination(this.cwd, this.input.base, this.input.handle.title, this.input.handle.token, fn);
  }

  private wake = () => { this.wakeCount++; this.waiter?.(); this.waiter = undefined; };

  private async wait(count: number): Promise<void> {
    if (this.signal.aborted || this.wakeCount !== count) return;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
      if (this.signal.aborted || this.wakeCount !== count) { this.waiter = undefined; resolve(); }
    });
  }

  private async initialize(): Promise<void> {
    const result = await this.input.handle.mutate("implement", async () => {
      const previous = await readCoordination(this.cwd, this.input.base);
      let value: CoordinationState;
      if (previous && previous.iteration === this.input.iteration && previous.status !== "finished") {
        value = { ...previous, title: this.input.handle.title, token: this.input.handle.token, status: "running", worktree: this.input.worktree };
        for (const lane of Object.values(value.lanes)) {
          if (lane.state === "working") lane.state = "ready";
        }
        addCoordinatorEvent(value, "resumed", "Coordinator reattached. Reconcile saved jobs and outstanding questions before dispatching replacements.");
      } else {
        if (previous && Object.values(previous.jobs).some(unresolvedJob)) throw new Error("Unresolved jobs prevent a new iteration; resume their owner first");
        if (previous) {
          await mkdir(this.sessionDir, { recursive: true });
          await writeFile(join(this.sessionDir, "previous-iteration.json"), `${JSON.stringify(previous)}\n`, "utf8");
        }
        value = {
          version: 1, title: this.input.handle.title, token: this.input.handle.token,
          iteration: this.input.iteration, status: "running", goal: previous?.goal ?? this.input.goal,
          spec: previous?.spec ?? this.input.spec, revision: previous?.revision ?? 1,
          loop: previous?.loop ?? this.input.loop, worktree: this.input.worktree,
          lanes: {}, jobs: previous?.jobs ?? {}, events: previous?.events.filter((event) => !event.handled) ?? [],
          ...(previous?.pendingRevision ? { pendingRevision: previous.pendingRevision } : {}),
          revisions: previous?.revisions ?? [{ revision: 1, goal: this.input.goal, at: new Date().toISOString() }],
          submissions: previous?.submissions ?? 0, childRuns: previous?.childRuns ?? 0,
          coordinatorTurns: previous?.coordinatorTurns ?? 0, updatedAt: new Date().toISOString(),
        };
        addCoordinatorEvent(value, "iteration_started", `Start iteration ${this.input.iteration}. ${this.input.lessons ?? ""}\n${this.input.hookNote ?? ""}`);
      }
      await writeCoordination(this.cwd, this.input.base, value);
    });
    if (!result.ok) throw new Error(`Coordinator could not start: ${result.reason}`);
  }

  private async sourceIdentity(source: string): Promise<string> {
    const head = await headCommit(source);
    if (!head) throw new Error("Source HEAD is missing");
    return hash(`${head}\n${await capturePatch(source, head)}`);
  }

  /**
   * Report carrying once per run.
   *
   * Carrying every untracked file is the default because a child that cannot see the operator's
   * real configuration cannot do the work. But copying files nobody named into a worktree is
   * exactly the kind of thing that should not happen quietly: an operator who did not expect their
   * local `.env` in a dozen worktrees finds out here, on the first lane, not from a diff later.
   */
  private reportCarried(result: CarryResult): void {
    if (this.carriedReported) return;
    this.carriedReported = true;
    const sample = result.carried.slice(0, 3).join(", ");
    this.input.handle.notify(
      `Kanban carried ${result.carried.length} untracked file(s) into its private worktrees (${sample}${result.carried.length > 3 ? ", …" : ""}). ` +
      `They stay out of every candidate patch and audit commit. Narrow this with worktree.carry or worktree.carryExclude in /kanban config.` +
      (result.skipped.length ? ` ${result.skipped.length} file(s) were too large and were skipped.` : ""),
      "info",
    );
  }

  private async snapshot(source: string, label: string): Promise<{ path: string; commit: string; digest: string }> {
    if (!(await this.input.handle.check("implement")).ok) throw new Error("Session no longer active");
    const path = join(this.cwd, ".kanban", "worktrees", this.input.base, `${this.input.iteration}-${slug(label)}-${randomUUID().slice(0, 8)}`);
    const digest = await this.sourceIdentity(source);
    const commit = await snapshotWorktree(this.cwd, source, path);
    // Carry before the lane starts: a child has no shell, so a file that is not here when it
    // begins is a file it can only report as missing.
    const carried = await carryIntoWorktree(this.cwd, path, this.input.worktreeConfig);
    if (carried.carried.length) this.reportCarried(carried);
    await registerWorktree(this.cwd, this.input.base, { path, pid: process.pid, startedAt: new Date().toISOString(), retain: true });
    if (digest !== await this.sourceIdentity(source)) throw new Error("Source changed while preparing its snapshot; retry with current source");
    return { path, commit, digest };
  }

  private async display(): Promise<void> {
    const state = await this.read();
    const children = Object.values(state.lanes).filter((lane) => lane.state === "working");
    updateLoopProgress(this.signal, {
      goal: state.goal, revision: state.revision, pendingRevision: Boolean(state.pendingRevision),
      target: state.loop.target, direction: state.loop.direction, metricName: state.loop.metric_name,
      maxIterations: state.loop.maxIterations, best: state.metricReset ? state.baselineMetric : this.input.bestMetric,
      childRunning: children.length > 0, childCount: children.length,
      jobCount: Object.values(state.jobs).filter(unresolvedJob).length,
      lanes: coordinationLines(state),
    });
    const roster = children.map((lane) => this.input.handle.childAgent(lane.name, lane.role));
    const key = JSON.stringify(roster);
    if (key !== this.rosterKey) {
      await this.input.handle.agents("implement", roster);
      this.rosterKey = key;
    }
  }

  private tools(): ToolDefinition[] {
    return [
      tool("iteration_delegate", "Start or retry an independent worker/reviewer lane. Returns immediately. Reviewers require reviewOf.", Type.Object({
        name: LaneName, task: Type.String({ minLength: 1 }), acceptance: Type.String({ minLength: 1 }),
        role: Type.Union([Type.Literal("worker"), Type.Literal("reviewer")]),
        dependsOn: Type.Optional(StringList), claims: Type.Optional(StringList),
        from: Type.Optional(LaneName), reviewOf: Type.Optional(LaneName),
      }), (args) => this.delegate(args)),
      tool("iteration_cancel_lane", "Stop only this child, preserving its partial source and sibling jobs. Cancel any associated job separately before replacement.", Type.Object({
        lane: LaneName, reason: Type.String({ minLength: 1 }),
      }), async (args) => {
        await this.change((state) => {
          const lane = state.lanes[args.lane];
          if (!lane || !["ready", "working", "waiting"].includes(lane.state)) throw new Error("Lane has no active child to cancel");
          lane.state = "cancelled"; lane.error = args.reason;
          delete lane.question; delete lane.reply;
          addCoordinatorEvent(state, "child_cancelled", args.reason, lane.name);
        });
        this.childControllers.get(args.lane)?.abort();
        await this.tasks.get(args.lane);
        return "Child stopped; its worktree is retained for a scoped retry or retirement.";
      }),
      tool("iteration_reply", "Answer a waiting child and resume its saved session.", Type.Object({ lane: LaneName, message: Type.String({ minLength: 1 }) }), async (args) => {
        await this.change((state) => {
          const lane = state.lanes[args.lane];
          if (!lane?.question) throw new Error("Lane has no pending question");
          lane.reply = args.message;
          addCoordinatorEvent(state, "child_answered", args.message, lane.name);
        });
        return "Answer recorded; the child resumes independently.";
      }),
      tool("iteration_job", "Run a named configured job against an immutable lane or integrated snapshot. Returns immediately. Reusing an operation name returns its original receipt; use a new name for an intentional retry.", Type.Object({
        name: LaneName, adapter: Type.String(), lane: Type.Optional(LaneName), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }), (args) => this.startJob(args)),
      tool("iteration_cancel_job", "Cancel one known job, preserving siblings. Unknown cancellation remains unresolved.", Type.Object({ name: LaneName }), async (args) => {
        const state = await this.read();
        const job = Object.values(state.jobs).find((item) => item.name === args.name);
        if (!job) throw new Error("Unknown job");
        await this.jobs.cancel(job.key);
        return "Cancellation requested; await its result before replacement.";
      }),
      tool("iteration_integrate", "Accept a reviewed worker patch, or accept a read-only/evidence lane. Requires current revision and declared validation receipts for a writer.", Type.Object({
        lane: LaneName, review: Type.Optional(LaneName), jobs: Type.Optional(StringList), rationale: Type.String({ minLength: 1 }),
      }), (args) => this.integrate(args)),
      tool("iteration_retire", "Retire terminal work superseded by a user revision or an accepted replacement. Retains its evidence.", Type.Object({
        lane: LaneName, replacement: Type.Optional(LaneName), rationale: Type.String({ minLength: 1 }),
      }), async (args) => {
        await this.change((state) => {
          const lane = state.lanes[args.lane];
          if (!lane || ["ready", "working", "waiting"].includes(lane.state) || Object.values(state.jobs).some((job) => job.lane === lane.name && unresolvedJob(job)))
            throw new Error("Resolve active work before retiring its lane");
          if (lane.revision === state.revision && (!args.replacement || state.lanes[args.replacement]?.state !== "accepted"))
            throw new Error("Retirement requires a newer user revision or an accepted replacement");
          lane.state = "retired";
          addCoordinatorEvent(state, "lane_retired", args.rationale, lane.name);
        });
        return "Superseded work retired; its receipts remain available.";
      }),
      tool("iteration_measure", "Run legacy validate then metric on an immutable integrated snapshot. Completion wakes this coordinator.", Type.Object({}), async () => {
        await this.startMeasurement(); return "Measurement registered; keep independent work moving or yield.";
      }),
      tool("iteration_cancel_measurement", "Stop the currently running legacy measurement process group; preserve named jobs and all source snapshots.", Type.Object({ reason: Type.String({ minLength: 1 }) }), async (args) => {
        if (!this.measuring) throw new Error("No legacy measurement is running");
        this.measurementController?.abort();
        await this.measurementTask;
        await this.change((state) => { delete state.measurement; addCoordinatorEvent(state, "measurement_cancelled", args.reason); });
        return "Legacy measurement stopped. Named scheduler jobs were not cancelled.";
      }),
      tool("iteration_apply_revision", "Apply the latest user goal revision with a replacement composed plan. Budget changes come only from the recorded user request.", Type.Object({
        request: Type.String(), goal: Type.String({ minLength: 1 }), spec: Type.String({ minLength: 1 }),
        inScope: Type.Optional(StringList), outOfScope: Type.Optional(StringList),
      }), (args) => this.applyRevision(args)),
      tool("iteration_revalidate", "Carry useful older lane/job evidence to the latest revision after checking the revised acceptance criteria.", Type.Object({
        lane: Type.Optional(LaneName), jobs: StringList, rationale: Type.String({ minLength: 1 }),
      }), async (args) => {
        await this.change((state) => {
          if (state.pendingRevision) throw new Error("Apply the pending revision first");
          const lane = args.lane ? state.lanes[args.lane] : undefined;
          if (args.lane && (!lane || !["candidate", "accepted"].includes(lane.state))) throw new Error("Lane is not ready for revalidation");
          if (!lane && !args.jobs.length) throw new Error("Name a lane or job to revalidate");
          for (const name of args.jobs) {
            const job = Object.values(state.jobs).find((item) => item.name === name);
            if (!job?.collected || !job.accepted) throw new Error(`Job ${name} has no accepted evidence`);
            // Preserve the original submission revision; acceptance revision is explicit.
            job.acceptanceRevision = state.revision;
          }
          if (lane) lane.revision = state.revision;
          addCoordinatorEvent(state, "evidence_revalidated", args.rationale, lane?.name);
        });
        return "Reuse decision recorded against the current goal.";
      }),
      tool("iteration_finish", "Explicitly close the iteration after acceptance/measurement. Complete requires all lanes accepted and no pending work or revisions.", Type.Object({
        decision: Type.Union([Type.Literal("keep"), Type.Literal("revert")]),
        verdict: Type.Union([Type.Literal("complete"), Type.Literal("continue")]),
        rationale: Type.String({ minLength: 1 }),
        resultJob: Type.Optional(LaneName),
      }), (args) => this.finish(args)),
      tool("iteration_block", "Record a specific missing decision or exhausted resource; independent work remains live.", Type.Object({
        reason: Type.String({ minLength: 1 }), lane: Type.Optional(LaneName),
      }), async (args) => {
        await this.change((state) => {
          if (args.lane) {
            const lane = state.lanes[args.lane];
            if (!lane || lane.state === "working") throw new Error("Cannot block an unknown or actively writing lane");
            lane.state = "blocked"; lane.error = args.reason;
          } else { state.status = "blocked"; state.blocker = args.reason; }
        });
        this.input.handle.notify(`Kanban needs attention: ${args.reason}`, "warning");
        await appendAttention(this.cwd, this.input.base, {
          source: args.lane ?? "coordinator",
          message: args.reason,
          remedy: "/kanban say <message> to steer, or /kanban answer <lane> <message> for a lane question.",
        });
        return "Blocker recorded. Continue independent work; a user answer will wake this session.";
      }),
    ];
  }

  private async delegate(args: { name: string; task: string; acceptance: string; role: "worker" | "reviewer"; dependsOn?: string[]; claims?: string[]; from?: string; reviewOf?: string }): Promise<string> {
    await this.change((state) => {
      if (state.pendingRevision || this.stopping) throw new Error("Apply the pending revision before dispatching");
      const previous = state.lanes[args.name];
      if (previous && ["ready", "working", "waiting"].includes(previous.state)) throw new Error("This lane already has an owner");
      if (Object.values(state.jobs).some((job) => job.lane === args.name && unresolvedJob(job)))
        throw new Error("Resolve this lane's existing job before dispatching a replacement");
      for (const dependency of args.dependsOn ?? [])
        if (!state.lanes[dependency] || dependency === args.name) throw new Error(`Invalid dependency ${dependency}`);
      if (args.role === "reviewer" && (!args.reviewOf || state.lanes[args.reviewOf]?.state !== "candidate"))
        throw new Error("Review requires a completed candidate lane");
      if (args.from && !state.lanes[args.from]?.worktree) throw new Error("Unknown source lane");
      if (state.loop.maxChildRuns !== undefined && state.childRuns >= state.loop.maxChildRuns) throw new Error("Campaign child-run budget exhausted");
      const source = args.from ?? (previous?.worktree ? args.name : undefined);
      const sourceRecord = source === args.name ? previous : source ? state.lanes[source] : undefined;
      state.lanes[args.name] = {
        name: args.name, task: args.task, acceptance: args.acceptance, role: args.role,
        dependsOn: args.dependsOn ?? [], claims: args.claims ?? [], state: "ready", revision: state.revision,
        attempt: (previous?.attempt ?? 0) + 1, worktree: "", baseCommit: "",
        ...(source ? { sourceLane: source } : {}), ...(args.reviewOf ? { reviewOf: args.reviewOf } : {}),
        // A retry snapshots partial work instead of repeating from an empty checkout.
        ...(source === args.name && previous ? { sourceWorktree: previous.worktree } : {}),
        ...(sourceRecord ? { sourceBase: sourceRecord.candidateBase ?? sourceRecord.baseCommit } : {}),
      };
      state.childRuns++;
      addCoordinatorEvent(state, "child_queued", `${args.role}: ${args.task}`, args.name);
    });
    await this.startReady();
    return `Lane ${args.name} queued; it will report completion, failure, or a question.`;
  }

  private async startReady(): Promise<void> {
    const state = await this.read();
    if (state.pendingRevision || this.stopping) return;
    for (const lane of Object.values(state.lanes)) {
      if (this.tasks.size >= (state.loop.maxConcurrentChildren ?? 3)) break;
      if (this.tasks.has(lane.name)) continue;
      if (!(lane.state === "ready" || (lane.state === "waiting" && lane.reply))) continue;
      if (!lane.dependsOn.every((name) => state.lanes[name]?.state === "accepted")) continue;
      const task = this.runLane(lane.name, lane.attempt).catch(async (error) => {
        if (this.signal.aborted) return;
        await this.change((value) => {
          const current = value.lanes[lane.name];
          if (current?.attempt !== lane.attempt || current.state === "cancelled") return;
          current.state = "failed"; current.error = String(error).slice(0, 2000);
          addCoordinatorEvent(value, "child_failed", current.error, lane.name);
        }).catch(() => undefined);
        await appendAttention(this.cwd, this.input.base, {
          source: lane.name,
          message: `Lane failed: ${String(error).slice(0, 2000)}`,
        });
      }).finally(() => { this.tasks.delete(lane.name); this.wake(); });
      this.tasks.set(lane.name, task);
    }
  }

  private async runLane(name: string, attempt: number): Promise<void> {
    let state = await this.read(), lane = state.lanes[name];
    if (!lane.worktree) {
      const source = lane.reviewOf ? state.lanes[lane.reviewOf].worktree
        : lane.sourceWorktree || (lane.sourceLane ? state.lanes[lane.sourceLane].worktree : state.worktree);
      const snapshot = await this.snapshot(source, name);
      await this.change((value) => {
        const current = value.lanes[name];
        if (current.attempt !== attempt || current.state === "cancelled") throw new Error("Lane attempt was replaced or cancelled");
        current.worktree = snapshot.path; current.baseCommit = snapshot.commit;
        current.candidateBase = current.role === "reviewer" ? snapshot.commit : current.sourceBase || snapshot.commit;
        if (current.reviewOf) current.reviewedCandidate = candidateIdentity(value.lanes[current.reviewOf]);
      });
      state = await this.read(); lane = state.lanes[name];
    }
    const controller = new AbortController();
    this.childControllers.set(name, controller);
    const abort = () => controller.abort();
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    const customTools = [tool("iteration_question", "Ask the coordinator for a decision or missing command evidence, then end your response.", Type.Object({ question: Type.String({ minLength: 1 }) }), async (args) => {
      await this.change((value) => {
        const current = value.lanes[name];
        if (current.attempt !== attempt || current.state === "cancelled") throw new Error("Lane attempt was replaced or cancelled");
        current.state = "waiting"; current.question = args.question; delete current.reply;
        addCoordinatorEvent(value, "child_question", args.question, name);
      });
      return "Question recorded. End this response now; the coordinator will resume this session with its answer.";
    })];
    if (lane.role === "reviewer") customTools.push(tool("iteration_review", "Record the verdict for the exact supplied snapshot.", Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), findings: Type.String(),
    }), async (args) => {
      await this.change((value) => {
        if (value.lanes[name].attempt !== attempt) throw new Error("Review attempt was replaced");
        value.lanes[name].reviewVerdict = args.verdict;
        value.lanes[name].output = args.findings.slice(0, 12000);
      });
      return "Verdict recorded; end your response.";
    }));
    // A lane that must acquire an upstream source has no shell and no other way out of the
    // worktree. Granting the tools here, per lane, keeps that an explicit configuration choice.
    if (networkEnabledFor(this.input.network, name))
      customTools.push(...networkTools({
        cwd: this.cwd, base: this.input.base, lane: name,
        config: this.input.network, signal: controller.signal,
      }));
    let session: IterationSession | undefined;
    try {
      session = await (this.input.factory ?? createIterationSession)({
        cwd: lane.worktree, sessionDir: join(this.sessionDir, slug(name), String(attempt)),
        sessionFile: lane.sessionFile, systemPrompt: workerSystem(lane.role), label: name,
        model: this.input.model, tools: lane.role === "reviewer" ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "edit", "write"],
        customTools, signal: controller.signal, runSignal: this.signal,
        output: (text) => appendLiveOutput(this.signal, `[${name}] ${text}`),
        activity: (text) => updateLoopProgress(this.signal, { activity: text }),
      });
      // Naming the carried files matters more than it looks: they are untracked, so nothing in the
      // checkout's history hints that they exist, and a child that does not know to look for a
      // site profile will report the configuration as missing and stop.
      const carried = await readCarried(lane.worktree);
      const carriedNote = carried.length
        ? `\nLocal files copied into this worktree (untracked in git, present and readable here): ${carried.join(", ")}`
        : "";
      const message = lane.reply
        ? `Coordinator answer: ${lane.reply}\nContinue your task under goal revision ${state.revision}.`
        : `Goal revision ${lane.revision}: ${state.goal}\nPlan:\n${state.spec}\nLane: ${name}\nTask: ${lane.task}\nAcceptance: ${lane.acceptance}\nClaims: ${lane.claims.join(", ") || "this private worktree"}${carriedNote}\n${lane.sessionFile ? "Resume the saved session; inspect partial work before proceeding." : ""}`;
      await this.change((value) => {
        const current = value.lanes[name];
        if (current.attempt !== attempt || current.state === "cancelled") throw new Error("Lane attempt was cancelled");
        current.state = "working"; current.sessionFile = session!.sessionFile;
        delete current.question; delete current.reply;
      });
      await this.display();
      const output = await session.send(message);
      if (this.signal.aborted || controller.signal.aborted) return;
      state = await this.read(); lane = state.lanes[name];
      if (lane.state === "waiting") return;
      const changed = await changedWorktreePaths(lane.worktree);
      if (lane.role === "reviewer" && changed.length) throw new Error("Reviewer snapshot changed; review is invalid");
      if (lane.claims.length && changed.some((path) => !lane.claims.some((claim) => path === claim || path.startsWith(`${claim.replace(/\/$/, "")}/`))))
        throw new Error("Candidate changed paths outside its declared claims; inspect before retrying");
      const candidate = await capturePatch(lane.worktree, lane.candidateBase ?? lane.baseCommit);
      await this.change((value) => {
        const current = value.lanes[name];
        if (current.attempt !== attempt) return;
        current.state = "candidate"; current.candidate = candidate;
        current.output = `${current.output ?? ""}\n${output}`.trim().slice(-12000);
        if (current.role === "reviewer" && !current.reviewVerdict) { current.state = "failed"; current.error = "Reviewer returned without an explicit verdict"; }
        addCoordinatorEvent(value, current.state === "failed" ? "child_failed" : "child_completed", current.output || current.error || "Candidate ready", name);
      });
    } finally {
      this.signal.removeEventListener("abort", abort);
      await session?.close();
      this.childControllers.delete(name);
      if (!this.signal.aborted) await this.display();
    }
  }

  private async startJob(args: { name: string; adapter: string; lane?: string; params?: Record<string, unknown> }): Promise<unknown> {
    const before = await this.read();
    const existing = Object.values(before.jobs).find((job) => job.name === args.name);
    if (existing) { this.jobs.watch(existing.key); return existing; }
    if (before.pendingRevision || this.stopping) throw new Error("Apply pending revision before submitting jobs");
    const adapter = before.loop.jobs?.[args.adapter];
    if (!adapter) throw new Error("Unknown configured job adapter");
    if (adapter.kind === "scheduled" && Object.values(before.jobs).some((job) => ["unknown", "blocked"].includes(job.state)))
      throw new Error("Reconcile unknown scheduler work before authorizing another submission");
    if (adapter.kind === "scheduled" && before.loop.maxSubmissions !== undefined && before.submissions >= before.loop.maxSubmissions)
      throw new Error("Campaign submission budget exhausted");
    const lane = args.lane ? before.lanes[args.lane] : undefined;
    if (args.lane && (!lane || !["candidate", "accepted"].includes(lane.state))) throw new Error("Job source lane must be a finished candidate");
    if (lane && lane.revision !== before.revision) throw new Error("Revalidate the lane against the revised goal first");
    if (lane && Object.values(before.jobs).some((job) => job.lane === lane.name && unresolvedJob(job))) throw new Error("Resolve the lane's outstanding job before replacing it");
    const snapshot = await this.snapshot(lane?.worktree ?? before.worktree, `job-${args.name}`);
    const key = randomUUID();
    await this.change((state) => {
      if (state.pendingRevision || state.revision !== before.revision || this.stopping) throw new Error("Goal changed while preparing the job");
      if (adapter.kind === "scheduled" && Object.values(state.jobs).some((job) => ["unknown", "blocked"].includes(job.state)))
        throw new Error("Scheduler ownership became uncertain while preparing the job; reconcile it first");
      if (Object.values(state.jobs).some((job) => job.name === args.name)) throw new Error("Job name was already reserved");
      if (adapter.kind === "scheduled" && state.loop.maxSubmissions !== undefined && state.submissions >= state.loop.maxSubmissions)
        throw new Error("Campaign submission budget exhausted");
      if (adapter.kind === "scheduled") state.submissions++;
      const now = Date.now();
      state.jobs[key] = {
        key, name: args.name, lane: args.lane ?? "integration", adapterName: args.adapter, adapter: structuredClone(adapter),
        params: args.params ?? {}, revision: state.revision, sourceCommit: snapshot.commit, sourceDigest: snapshot.digest, worktree: snapshot.path,
        env: {
          KANBAN_ITERATION: String(state.iteration), KANBAN_MAX_ITERATIONS: String(state.loop.maxIterations), KANBAN_BASE: this.input.base,
          ...((state.metricReset ? state.baselineMetric : this.input.bestMetric) === undefined ? {}
            : { KANBAN_BEST_METRIC: String(state.metricReset ? state.baselineMetric : this.input.bestMetric) }),
        },
        state: "intent", submitted: false, startedAt: now, deadline: now + (adapter.timeoutMs ?? state.loop.measureTimeoutMs),
        candidateHash: lane ? candidateIdentity(lane) : undefined,
      };
      addCoordinatorEvent(state, "job_registered", `${args.name} reserved through ${args.adapter}`, args.lane);
    });
    this.jobs.watch(key);
    return { name: args.name, state: "intent", message: "Registered independently; completion or failure will wake the coordinator." };
  }

  private async integrate(args: { lane: string; review?: string; jobs?: string[]; rationale: string }): Promise<string> {
    const state = await this.read();
    if (state.pendingRevision) throw new Error("Apply pending goal revision first");
    const lane = state.lanes[args.lane];
    if (!lane || lane.state !== "candidate" || lane.revision !== state.revision) throw new Error("A current-revision candidate is required");
    if (lane.role === "worker") {
      const review = args.review ? state.lanes[args.review] : undefined;
      if (!review || review.reviewOf !== lane.name || review.reviewVerdict !== "pass" || review.state !== "candidate" ||
        review.reviewedCandidate !== candidateIdentity(lane) || review.revision !== state.revision)
        throw new Error("A passing review of this exact current candidate is required");
      if ((args.jobs ?? []).length === 0 && Object.keys(state.loop.jobs ?? {}).length)
        throw new Error("Supply the configured validation job receipts for this candidate");
      for (const name of args.jobs ?? []) {
        const job = Object.values(state.jobs).find((item) => item.name === name);
        if (!job?.accepted || !job.collected || job.candidateHash !== candidateIdentity(lane) ||
          (job.acceptanceRevision ?? job.revision) !== state.revision)
          throw new Error(`Validation ${name} does not accept this exact candidate under the current goal`);
      }
    } else if (lane.reviewVerdict !== "pass") throw new Error("Cannot accept a failing reviewer");
    // Serialize integration with the same lock used by goal changes, so a revision cannot
    // cross the source acceptance boundary. No child or command runs under this lock.
    await this.change(async (value) => {
      if (value.pendingRevision || value.revision !== state.revision) throw new Error("Goal revision changed");
      if (lane.candidate?.trim()) {
        const applied = await landPatch(value.worktree, lane.candidate);
        if (!applied.ok) throw new Error(`Integration conflict; delegate a repair using the latest integration source: ${applied.error}`);
      }
      value.lanes[lane.name].state = "accepted";
      if (args.review) value.lanes[args.review].state = "accepted";
      delete value.measurement;
      addCoordinatorEvent(value, "lane_accepted", args.rationale, lane.name);
    });
    return "Candidate integrated in the private iteration worktree; user checkout unchanged.";
  }

  private async startMeasurement(): Promise<void> {
    const state = await this.read();
    if (this.measuring) throw new Error("A measurement is already running");
    if (state.pendingRevision || this.stopping) throw new Error("Apply the pending revision first");
    if (!state.loop.validate && !state.loop.metric) throw new Error("No legacy measurement configured; use named jobs");
    const snapshot = await this.snapshot(state.worktree, "measurement");
    this.measuring = true;
    const controller = new AbortController();
    this.measurementController = controller;
    const cancel = () => controller.abort();
    this.taskController.signal.addEventListener("abort", cancel, { once: true });
    if (this.taskController.signal.aborted) cancel();
    const unlink = linkLoopProgress(this.signal, controller.signal);
    this.measurementTask = (async () => {
      const outcome = await (this.input.measure ?? measure)(snapshot.path, state.loop, controller.signal, {
        KANBAN_ITERATION: String(this.input.iteration), KANBAN_MAX_ITERATIONS: String(state.loop.maxIterations), KANBAN_BASE: this.input.base,
        KANBAN_GOAL_REVISION: String(state.revision),
        ...((state.metricReset ? state.baselineMetric : this.input.bestMetric) === undefined ? {}
          : { KANBAN_BEST_METRIC: String(state.metricReset ? state.baselineMetric : this.input.bestMetric) }),
      });
      if (controller.signal.aborted) return;
      await this.change((current) => {
        current.measurement = { ...outcome, tail: outcome.tail.slice(-8000), revision: state.revision, sourceCommit: snapshot.commit, worktree: snapshot.path };
        // The patch identity, rather than HEAD, distinguishes uncommitted integrations.
        current.measurementPatch = snapshot.digest;
        addCoordinatorEvent(current, "measurement_finished", JSON.stringify(outcome));
      });
    })().catch(async (error) => {
      if (!controller.signal.aborted) await this.change((value) => { addCoordinatorEvent(value, "measurement_failed", String(error)); });
    }).finally(() => { unlink(); this.taskController.signal.removeEventListener("abort", cancel); this.measuring = false; this.wake(); });
  }

  private async applyRevision(args: { request: string; goal: string; spec: string; inScope?: string[]; outOfScope?: string[] }): Promise<string> {
    if (args.spec.replace(/\r\n/g, "\n").split("\n").length > 299) throw new Error("Revised compose section must fit within 300 lines including its heading");
    const result = await this.input.handle.mutate("implement", async (_board, session) => {
      const value = await this.read();
      const pending = value.pendingRevision;
      if (!pending || pending.id !== args.request) throw new Error("Apply the current pending request, not an obsolete revision");
      const patch = pending.request.loop ?? {};
      validateLoopRevision(patch);
      const reset = ["metric", "metric_name", "direction"].some((field) => field in patch && patch[field as keyof LoopConfig] !== value.loop[field as keyof LoopConfig]);
      value.loop = { ...value.loop, ...patch };
      value.goal = args.goal; value.spec = args.spec; value.revision++;
      delete value.measurement;
      if (reset) {
        value.metricReset = true; value.baselineMetric = patch.baselineMetric;
        delete value.measurement;
      }
      value.revisions.push({ revision: value.revision, goal: value.goal, at: new Date().toISOString() });
      delete value.pendingRevision; delete value.finish; delete value.blocker;
      value.status = "running";
      const plan = await readPlan(this.cwd, session.planPath);
      if (!plan) throw new Error("Selected plan is missing");
      await writePlan(this.cwd, session.planPath, {
        ...plan, prompt: args.goal, inScope: args.inScope ?? pending.request.inScope ?? plan.inScope,
        outOfScope: args.outOfScope ?? pending.request.outOfScope ?? plan.outOfScope, updatedAt: new Date().toISOString(),
      });
      await writeWorkfileSection(this.cwd, this.input.base, "compose", args.spec);
      addCoordinatorEvent(value, "goal_applied", `Applied goal revision ${value.revision}: ${value.goal}`);
      await writeCoordination(this.cwd, this.input.base, value);
    });
    if (!result.ok) throw new Error(`Goal revision refused: ${result.reason}`);
    this.wake();
    return "Goal and plan applied. Reconcile running work; old results require explicit revalidation.";
  }

  private async finish(args: { decision: "keep" | "revert"; verdict: "complete" | "continue"; rationale: string; resultJob?: string }): Promise<string> {
    if (this.measuring || this.tasks.size) throw new Error("Children or measurement still running");
    await this.change(async (state) => {
      if (state.pendingRevision || this.stopping) throw new Error("A pending control change prevents completion");
      if (Object.values(state.jobs).some(unresolvedJob)) throw new Error("Outstanding/unknown jobs must be reconciled before finishing");
      if (Object.values(state.lanes).some((lane) => ["ready", "working", "waiting"].includes(lane.state))) throw new Error("Unfinished child work remains");
      if (args.verdict === "complete" && Object.values(state.lanes).some((lane) => lane.state !== "retired" && (lane.state !== "accepted" || lane.revision !== state.revision)))
        throw new Error("Complete requires every required lane accepted under the current goal");
      if (args.decision === "keep" && (state.loop.validate || state.loop.metric)) {
        if (state.measurement?.revision !== state.revision) throw new Error("Measure the current revision before keeping it");
        if (!state.measurement.validationPass || (state.loop.metric && state.measurement.metricUnmeasured)) throw new Error("The current measurement failed");
        if (state.measurementPatch !== await this.sourceIdentity(state.worktree)) throw new Error("Integrated source changed since measurement; remeasure it");
      }
      if (!state.loop.validate && !state.loop.metric && args.decision === "keep") {
        const evidence = Object.values(state.jobs).find((job) => job.name === args.resultJob);
        if (!evidence?.accepted || !evidence.collected || (evidence.acceptanceRevision ?? evidence.revision) !== state.revision ||
          evidence.sourceDigest !== await this.sourceIdentity(state.worktree))
          throw new Error("Supply resultJob: an accepted final validation job for the current integrated source and goal");
        if (state.loop.target !== undefined && evidence.metric === undefined) throw new Error("The result job must report the configured target metric");
      }
      state.finish = { ...args, revision: state.revision };
      state.status = "finished";
      addCoordinatorEvent(state, "iteration_finished", args.rationale);
    });
    return "Iteration finish recorded; the host still enforces fitness and landing checks.";
  }

  private async packet(state: CoordinationState, events: CoordinationState["events"]): Promise<string> {
    return JSON.stringify({
      iteration: state.iteration, revision: state.revision, goal: state.goal, plan: state.spec,
      pendingRevision: state.pendingRevision, blocker: state.blocker,
      configuredJobs: state.loop.jobs ?? {}, legacyMeasurement: { validate: state.loop.validate, metric: state.loop.metric, target: state.loop.target },
      fitness: { direction: state.loop.direction, decisionPolicy: state.loop.decisionPolicy, metricName: state.loop.metric_name,
        target: state.loop.target, bestMetric: state.metricReset ? state.baselineMetric : this.input.bestMetric },
      budgets: { maxIterations: state.loop.maxIterations, maxConcurrentChildren: state.loop.maxConcurrentChildren ?? 3,
        submissions: state.submissions, maxSubmissions: state.loop.maxSubmissions, childRuns: state.childRuns, maxChildRuns: state.loop.maxChildRuns,
        coordinatorTurns: state.coordinatorTurns, maxCoordinatorTurns: state.loop.maxCoordinatorTurns },
      lanes: Object.values(state.lanes).map((lane) => { const { candidate, ...rest } = lane; return { ...rest, changed: Boolean(candidate), candidateHash: candidateIdentity(lane) }; }),
      jobs: Object.values(state.jobs).map(({ adapter, ...job }) => job),
      measurement: state.measurement, events,
    });
  }

  private async result(stop?: string): Promise<CoordinateResult> {
    const state = await this.read();
    const accepted = Object.values(state.jobs).filter((job) => job.accepted && job.collected && (job.acceptanceRevision ?? job.revision) === state.revision);
    const measurement = state.measurement?.revision === state.revision && (state.loop.validate || state.loop.metric) ? state.measurement : undefined;
    const finalJob = accepted.find((job) => job.name === state.finish?.resultJob);
    const metric = measurement?.metric ?? finalJob?.metric;
    const measured = measurement ?? { validationPass: Boolean(finalJob), metricUnmeasured: false, tail: "Accepted managed job evidence", ...(metric === undefined ? {} : { metric }) };
    return {
      decision: state.finish?.decision ?? "revert", verdict: state.finish?.verdict ?? "continue",
      rationale: state.finish?.rationale ?? stop ?? "Iteration suspended",
      measured: state.finish?.decision === "revert" ? { ...measured, validationPass: false, tail: state.finish.rationale } : measured,
      revision: state.revision, loop: state.loop, goal: state.goal, spec: state.spec,
      evidence: accepted.some((job) => Boolean(job.artifacts?.length)) || metric !== undefined,
      ...(stop ? { stop } : {}), metricReset: state.metricReset, baselineMetric: state.baselineMetric,
      auditWorktree: measurement?.worktree ?? finalJob?.worktree,
    };
  }

  async run(): Promise<CoordinateResult> {
    await this.initialize();
    const unsubscribe = observeCoordinator(this.cwd, this.input.base, this.wake);
    const abort = () => {
      this.taskController.abort();
      this.coordinatorController.abort();
      for (const controller of this.childControllers.values()) controller.abort();
      this.wake();
    };
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    const registration: LiveCoordinator = { wake: this.wake, cancelJobs: async () => {
      this.stopping = true;
      for (const job of Object.values((await this.read()).jobs)) if (unresolvedJob(job)) await this.jobs.cancel(job.key);
      await this.jobs.settled();
      const clean = !Object.values((await this.read()).jobs).some(unresolvedJob);
      if (!clean) { this.stopping = false; this.wake(); }
      if (!clean) this.input.handle.notify("Some scheduler cancellations remain unknown. Job identities and worktrees have been retained.", "warning");
      return clean;
    } };
    live.set(liveKey(this.cwd, this.input.base), registration);
    let noProgress = 0;
    try {
      const state = await this.read();
      this.coordinator = await (this.input.factory ?? createIterationSession)({
        cwd: this.input.worktree, sessionDir: join(this.sessionDir, "coordinator"), sessionFile: state.sessionFile,
        systemPrompt: COORDINATOR_SYSTEM, label: "Iteration coordinator", model: this.input.model,
        tools: ["read", "grep", "find", "ls"], customTools: this.tools(),
        signal: this.coordinatorController.signal, runSignal: this.signal,
        output: (text) => appendLiveOutput(this.signal, `[coordinator] ${text}`),
        activity: (text) => updateLoopProgress(this.signal, { activity: text }),
      });
      await this.change((value) => { value.sessionFile = this.coordinator!.sessionFile; });
      await this.jobs.reconnect();
      while (!this.signal.aborted) {
        const count = this.wakeCount;
        await this.startReady();
        let current = await this.read();
        if (current.finish && !current.pendingRevision) return this.result();
        const events = current.events.filter((event) => !event.handled);
        // A user control is the operator's escape hatch out of an exhausted campaign. Charging it
        // against the same budget that stranded the campaign makes the budget a one-way trap: the
        // one instruction that could raise the limit is the one the limit refuses to deliver.
        const userDriven = events.some((event) => event.kind.startsWith("user_"));
        if (events.length && !this.stopping) {
          const wakeBudget = current.pendingRevision?.request.loop?.maxCoordinatorTurns ?? current.loop.maxCoordinatorTurns;
          if (!userDriven && wakeBudget !== undefined && current.coordinatorTurns >= wakeBudget) {
            // Leave every event unhandled: a budget top-up must resume exactly where this stopped.
            const reason = turnBudgetBlocker(current.coordinatorTurns, wakeBudget);
            await this.change((value) => { value.status = "blocked"; value.blocker = reason; });
            this.input.handle.notify(`Kanban needs attention: ${reason}`, "warning");
            await appendAttention(this.cwd, this.input.base, {
              source: "coordinator",
              message: `${reason} ${events.length} event(s) are held unhandled and will be delivered on resume.`,
              remedy: "/kanban go --more",
            });
            return this.result(reason);
          }
          await this.change((value) => { value.coordinatorTurns++; if (userDriven) { value.status = "running"; delete value.blocker; } });
          await this.coordinator.send(await this.packet(current, events));
          await this.change((value) => {
            const ids = new Set(events.map((event) => event.id));
            for (const event of value.events) if (ids.has(event.id)) event.handled = true;
          });
          await this.startReady();
          current = await this.read();
          if (current.finish && !current.pendingRevision) return this.result();
          const active = this.tasks.size || this.jobs.running || this.measuring;
          if (!active && current.status !== "blocked" && !current.events.some((event) => !event.handled)) {
            if (++noProgress >= 2) {
              await this.change((value) => { value.status = "blocked"; value.blocker = "Coordinator returned without a finish, registered work, or a concrete blocker"; });
              return this.result("Coordinator stalled; use kanban_control to supply direction or resume");
            }
            await this.change((value) => { addCoordinatorEvent(value, "needs_action", "The goal is unfinished and no future work event is registered. Dispatch an actionable lane/job, finish explicitly, or record the concrete blocker."); });
          } else noProgress = 0;
          await this.display();
          continue;
        }
        if (current.status === "blocked" && !this.tasks.size && !this.jobs.running && !this.measuring && isSingleShot(this.input.handle.ctx))
          return this.result(current.blocker ?? "Waiting for a user decision");
        await this.wait(count);
      }
      return this.result("Iteration suspended; saved jobs will be reconciled on resume");
    } catch (error) {
      if (!this.signal.aborted) {
        await this.change((value) => { value.status = "blocked"; value.blocker = String(error).slice(0, 2000); }).catch(() => undefined);
        this.input.handle.notify(`Kanban coordinator stopped: ${String(error)}. Saved scheduler jobs remain recoverable.`, "error");
      }
      return this.result(String(error));
    } finally {
      unsubscribe(); this.signal.removeEventListener("abort", abort); abort();
      await this.coordinator?.close();
      await Promise.allSettled([...this.tasks.values()]);
      await this.jobs.settled();
      if (this.measurementTask) await this.measurementTask;
      if (live.get(liveKey(this.cwd, this.input.base)) === registration) live.delete(liveKey(this.cwd, this.input.base));
      // Suspend under the token even after the AbortSignal fires. Never resurrect a replaced run.
      if (this.signal.aborted) await updateCoordination(this.cwd, this.input.base, this.input.handle.title, this.input.handle.token,
        (value) => { if (value.status !== "finished") value.status = "paused"; }, { allowPaused: true }).catch(() => undefined);
    }
  }
}
