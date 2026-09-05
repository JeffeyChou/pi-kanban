import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { emptyPlan, readPlan, writePlan } from "../src/artifacts.js";
import { loadConfig, type LoopConfig } from "../src/config.js";
import { cancelCoordinatorJobs } from "../src/coordinator.js";
import { readCoordination, requestControl, type CoordinationState } from "../src/coordinationstore.js";
import { startImplementLoop, type LoopResult } from "../src/implementloop.js";
import type { IterationSessionFactory, IterationSessionSpec } from "../src/iterationsession.js";
import type { RunJobCommand } from "../src/jobs.js";
import { readLoopLog, sweepLoopWorktrees } from "../src/looplog.js";
import { abortPipelineFor, clearPipelineRegistry, hasLiveRun } from "../src/orchestrator.js";
import { createSession, load, mutateAsync } from "../src/store.js";
import { queryStatus } from "../src/status.js";
import { workfileBase, writeWorkfileSection } from "../src/workfile.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const output = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), output: JSON.stringify(value) });
async function invoke(spec: IterationSessionSpec, name: string, args: unknown): Promise<any> {
  const tool = spec.customTools.find((tool) => tool.name === name);
  assert.ok(tool, `missing ${name}`);
  const result = await tool.execute("test-call", args as never, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  if (text.startsWith("Refused:")) throw new Error(text);
  return JSON.parse(text);
}

async function until(check: () => Promise<boolean>, message = "condition", timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface HarnessOptions {
  loop?: Partial<LoopConfig>;
  coordinator: (packet: any, session: IterationSessionSpec) => Promise<void>;
  worker?: (session: IterationSessionSpec, message: string) => Promise<string>;
  command?: RunJobCommand;
  measure?: any;
}

async function harness(options: HarnessOptions) {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-coordinator-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, ".gitignore"), ".kanban/\n");
  await writeFile(join(cwd, "app.ts"), "export const value = 0;\n");
  await git(cwd, "add", "-A"); await git(cwd, "commit", "-qm", "base");
  const original = await git(cwd, "rev-parse", "HEAD");
  const created = await mutateAsync(cwd, async (board) => {
    const session = await createSession(cwd, board, "Coordinated research");
    session.stage = "implement"; session.mode = "pipeline";
    await writePlan(cwd, session.planPath, emptyPlan(session, "Collect the required research evidence"));
    return session;
  });
  const title = created.value.title, base = workfileBase(created.value.planPath);
  await writeWorkfileSection(cwd, base, "compose", "Accept every required result with validation.");
  const config = (await loadConfig(cwd, join(cwd, "fake-agent"))).config;
  config.loop = { ...config.loop, enabled: true, baselineMetric: 0, maxIterations: 3, measureTimeoutMs: 10000,
    jobs: { check: { kind: "local", command: "check" } }, ...options.loop };
  const notifications: string[] = [], sessions: IterationSessionSpec[] = [];
  let turns = 0;
  const factory: IterationSessionFactory = async (spec) => {
    sessions.push(spec);
    await mkdir(spec.sessionDir, { recursive: true });
    const sessionFile = spec.sessionFile ?? join(spec.sessionDir, "session.jsonl");
    await writeFile(sessionFile, "test session\n");
    return {
      sessionFile,
      send: async (message) => {
        if (spec.label === "Iteration coordinator") { turns++; await options.coordinator(JSON.parse(message), spec); return "Waiting for registered work."; }
        if (options.worker) return options.worker(spec, message);
        if (spec.tools.includes("edit")) { await writeFile(join(spec.cwd, "app.ts"), "export const value = 1;\n"); return "Changed app.ts"; }
        await invoke(spec, "iteration_review", { verdict: "pass", findings: "Reviewed exact source." });
        return "Review passed.";
      },
      close: async () => {},
    };
  };
  const ctx: any = {
    cwd, mode: "tui", model: { provider: "test", id: "model", contextWindow: 100 },
    modelRegistry: { find: () => undefined }, hasUI: false, isIdle: () => true,
    getContextUsage: () => ({ tokens: 0, contextWindow: 100 }),
    sessionManager: { getSessionFile: () => "main.jsonl" },
    ui: { setStatus() {}, setWidget() {}, notify(message: string) { notifications.push(message); } },
  };
  const tasks: Promise<LoopResult>[] = [];
  return {
    cwd, title, base, original, notifications, sessions, config, ctx,
    get turns() { return turns; },
    read: () => readCoordination(cwd, base) as Promise<CoordinationState>,
    async start() {
      const started = await startImplementLoop(ctx, title, {
        config, runChild: async () => { throw new Error("Frozen one-shot runner must not execute coordinated iterations"); },
        sessionFactory: factory, jobCommand: options.command ?? (async () => output({ accepted: true })), measure: options.measure,
      });
      assert.equal(started.armed, true, JSON.stringify(started));
      if (!started.armed) throw new Error(started.message);
      tasks.push(started.run);
      return { run: started.run };
    },
    async cleanup() {
      abortPipelineFor(title);
      await Promise.allSettled(tasks);
      clearPipelineRegistry();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("default coordinator reviews, validates and lands an immutable candidate without measurement debris", { timeout: 20000 }, async () => {
  const sent = new Set<string>();
  const h = await harness({
    loop: { validate: "validate", jobs: {} },
    coordinator: async (packet, spec) => {
      const lanes = Object.fromEntries(packet.lanes.map((lane: any) => [lane.name, lane]));
      if (!lanes.writer) {
        await invoke(spec, "iteration_delegate", { name: "writer", task: "Change app.ts", role: "worker", acceptance: "value is 1", claims: ["app.ts"] }); return;
      }
      if (lanes.writer.state === "candidate" && !lanes.review) {
        await invoke(spec, "iteration_delegate", { name: "review", task: "Review app.ts", role: "reviewer", acceptance: "correct", reviewOf: "writer" }); return;
      }
      if (lanes.review?.state === "candidate") {
        await invoke(spec, "iteration_integrate", { lane: "writer", review: "review", rationale: "Reviewed source" });
        await invoke(spec, "iteration_measure", {}); sent.add("measure"); return;
      }
      if (packet.measurement?.validationPass) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", rationale: "Measured accepted source" });
    },
    measure: async (cwd: string) => {
      assert.match(await readFile(join(cwd, "app.ts"), "utf8"), /value = 1/);
      await writeFile(join(cwd, "build-debris.txt"), "never commit this");
      await writeFile(join(cwd, "app.ts"), "measurement modified source\n");
      return { validationPass: true, metricUnmeasured: false, tail: "passed" };
    },
  });
  try {
    const task = await h.start();
    const result = await task.run;
    assert.equal(result.kind, "success", JSON.stringify(h.notifications));
    assert.equal(result.advanced, true);
    assert.equal(await git(h.cwd, "rev-parse", "HEAD"), h.original);
    assert.equal(await git(h.cwd, "diff", "--cached"), "");
    assert.match(await readFile(join(h.cwd, "app.ts"), "utf8"), /value = 1/);
    await assert.rejects(access(join(h.cwd, "build-debris.txt")));
    assert.equal(h.sessions.filter((s) => s.label === "Iteration coordinator").length, 1);
    assert.ok(h.turns >= 3);
    assert.equal((await h.read()).status, "finished");
  } finally { await h.cleanup(); }
});

test("a failed MoE job is repaired and resubmitted while TP/DP stay live, without another user turn", { timeout: 30000 }, async () => {
  const scheduler = new Map<string, { id: string; profile: string; state: string }>();
  const submits: string[] = [];
  const command: RunJobCommand = async (input) => {
    const { operation, key, params } = input.payload as any;
    if (operation === "command") {
      const score = input.command === "score";
      await writeFile(join(input.cwd, "evidence.json"), JSON.stringify({ accepted: true }));
      return output({ accepted: true, artifacts: [join(input.cwd, "evidence.json")], ...(score ? { metric: 3 } : {}) });
    }
    if (operation === "status") {
      const job = scheduler.get(key);
      return output(job ? { state: job.state, externalId: job.id } : { state: "missing" });
    }
    if (operation === "submit") {
      const profile = params.profile;
      if (profile === "MoE-retry") {
        assert.equal([...scheduler.values()].find((j) => j.profile === "TP")?.state, "running");
        assert.equal([...scheduler.values()].find((j) => j.profile === "DP")?.state, "running");
        for (const job of scheduler.values()) if (job.profile === "TP" || job.profile === "DP") job.state = "succeeded";
      }
      submits.push(profile);
      const job = { id: String(submits.length), profile, state: profile === "MoE" ? "failed" : profile === "MoE-retry" ? "succeeded" : "running" };
      scheduler.set(key, job);
      return output({ state: job.state, externalId: job.id });
    }
    if (operation === "collect") {
      const job = scheduler.get(key)!;
      return output({ accepted: job.state === "succeeded", artifacts: [`/retained/${job.id}.json`] });
    }
    return output({ state: "cancelled" });
  };
  let started = false, integrated = false;
  const h = await harness({
    loop: { target: 3, maxSubmissions: 4, jobs: {
      capture: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", pollIntervalMs: 20 },
      check: { kind: "local", command: "check" }, score: { kind: "local", command: "score" },
    } }, command,
    coordinator: async (packet, spec) => {
      const jobs = Object.fromEntries(packet.jobs.map((job: any) => [job.name, job]));
      const lanes = Object.fromEntries(packet.lanes.map((lane: any) => [lane.name, lane]));
      if (!started) {
        started = true;
        for (const profile of ["TP", "DP", "MoE"]) await invoke(spec, "iteration_job", { name: profile, adapter: "capture", params: { profile } });
        return;
      }
      if (jobs.MoE?.collected && !lanes.repair) {
        await invoke(spec, "iteration_delegate", { name: "repair", role: "worker", task: "Fix MoE", acceptance: "Runtime fixed", claims: ["app.ts"] }); return;
      }
      if (lanes.repair?.state === "candidate" && !lanes.review) {
        await invoke(spec, "iteration_delegate", { name: "review", role: "reviewer", task: "Review MoE repair", acceptance: "No blockers", reviewOf: "repair" });
        await invoke(spec, "iteration_job", { name: "MoE CPU", lane: "repair", adapter: "check" }); return;
      }
      if (!integrated && lanes.review?.state === "candidate" && jobs["MoE CPU"]?.accepted) {
        integrated = true;
        await invoke(spec, "iteration_integrate", { lane: "repair", review: "review", jobs: ["MoE CPU"], rationale: "Fix passes CPU validation and review" });
        await invoke(spec, "iteration_job", { name: "MoE retry", adapter: "capture", lane: "repair", params: { profile: "MoE-retry" } }); return;
      }
      if (jobs.TP?.accepted && jobs.DP?.accepted && jobs["MoE retry"]?.accepted && !jobs.score) {
        await invoke(spec, "iteration_job", { name: "score", adapter: "score" }); return;
      }
      if (jobs.score?.accepted) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", resultJob: "score", rationale: "All three profiles accepted" });
    },
  });
  try {
    const { run } = await h.start();
    const result = await run;
    assert.equal(result.kind, "success", h.notifications.join("\n"));
    assert.deepEqual(submits, ["TP", "DP", "MoE", "MoE-retry"]);
    assert.equal((await h.read()).submissions, 4);
    assert.equal((await readLoopLog(h.cwd, h.base)).length, 1, "repairs did not spend new iterations");
  } finally { await h.cleanup(); }
});

test("evidence-only CPU recovery can finish without an empty commit or a GPU submission", { timeout: 20000 }, async () => {
  const h = await harness({
    command: async (input) => {
      assert.equal(input.payload.operation, "command");
      await writeFile(join(input.cwd, "census_validation.json"), "{\"accepted\":true}");
      return output({ accepted: true, artifacts: [join(input.cwd, "census_validation.json")] });
    },
    coordinator: async (packet, spec) => {
      if (!packet.jobs.length) await invoke(spec, "iteration_job", { name: "DP postprocess", adapter: "check", params: { retainedRun: "/retained/DP" } });
      else if (packet.jobs[0].accepted) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", resultJob: "DP postprocess", rationale: "Validated retained DP evidence on CPU" });
    },
  });
  try {
    const { run } = await h.start();
    const result = await run;
    assert.equal(result.kind, "success", h.notifications.join("\n"));
    assert.equal(await git(h.cwd, "rev-parse", `kanban-autoresearch/${h.base}`), h.original);
    assert.equal(await git(h.cwd, "status", "--porcelain"), "");
    assert.equal((await readLoopLog(h.cwd, h.base))[0].evidenceOnly, true);
    assert.equal((await h.read()).submissions, 0);
  } finally { await h.cleanup(); }
});

test("goal revisions wake an idle coordinator, block obsolete submissions and preserve an independent scheduled job", { timeout: 30000 }, async () => {
  let schedulerState = "running", submits = 0, applied = false;
  const h = await harness({
    loop: { jobs: { capture: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", pollIntervalMs: 20 } } },
    command: async (input) => {
      if (input.payload.operation === "submit") { submits++; return output({ state: schedulerState, externalId: "tp-123" }); }
      if (input.payload.operation === "status") return output(submits ? { state: schedulerState, externalId: "tp-123" } : { state: "missing" });
      if (input.payload.operation === "collect") return output({ accepted: true, artifacts: ["/retained/TP.json"] });
      return output({ state: "cancelled" });
    },
    coordinator: async (packet, spec) => {
      if (packet.pendingRevision) {
        await assert.rejects(invoke(spec, "iteration_job", { name: "obsolete", adapter: "capture" }), /pending revision/);
        await assert.rejects(invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", rationale: "old goal" }), /pending control/);
        await invoke(spec, "iteration_apply_revision", { request: packet.pendingRevision.id, goal: "TP evidence with stricter acceptance", spec: "Validate the retained TP evidence. Preserve the running job." });
        applied = true;
        await invoke(spec, "iteration_block", { reason: "Waiting for the user to approve the retained evidence criteria" });
        return;
      }
      if (!packet.jobs.length) await invoke(spec, "iteration_job", { name: "TP", adapter: "capture" });
      if (packet.events.some((event: any) => event.kind === "user_steer") && packet.jobs[0]?.accepted) {
        await assert.rejects(invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", resultJob: "TP", rationale: "Using old acceptance" }), /current integrated source and goal/);
        await invoke(spec, "iteration_revalidate", { jobs: ["TP"], rationale: "The user confirmed these retained results satisfy the revised criteria" });
        await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", resultJob: "TP", rationale: "Current goal and retained evidence accepted" });
      }
    },
  });
  try {
    const { run } = await h.start();
    await until(async () => Boolean((await h.read())?.jobs && Object.values((await h.read()).jobs).some((j) => j.state === "running")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const idleTurns = h.turns;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.turns, idleTurns, "unchanged scheduler status must not spend model turns");
    const originalJob = Object.values((await h.read()).jobs)[0];
    await requestControl(h.cwd, h.base, h.title, { action: "revise", message: "Require stricter TP acceptance", loop: { maxSubmissions: 1 }, inScope: ["TP evidence"] });
    await until(async () => applied && (await h.read()).revision === 2);
    const state = await h.read();
    assert.equal(state.pendingRevision, undefined);
    assert.equal(state.loop.maxSubmissions, 1);
    assert.equal(Object.values(state.jobs)[0].key, originalJob.key);
    assert.equal(Object.values(state.jobs)[0].revision, 1, "submission provenance is immutable");
    assert.equal(Object.values(state.jobs)[0].state, "running");
    assert.equal(submits, 1);
    const board = await load(h.cwd);
    const plan = await readPlan(h.cwd, board.sessions[0].planPath);
    assert.equal(plan?.prompt, "TP evidence with stricter acceptance");
    assert.deepEqual(plan?.inScope, ["TP evidence"]);
    assert.match(await queryStatus(h.cwd), /revision 2/);
    schedulerState = "succeeded";
    await until(async () => Object.values((await h.read()).jobs)[0].accepted === true);
    await requestControl(h.cwd, h.base, h.title, { action: "steer", message: "These retained results satisfy the revised criteria; accept and finish." });
    assert.equal((await run).kind, "success", h.notifications.join("\n"));
    assert.equal(submits, 1);
  } finally { await h.cleanup(); }
});

test("a child question resumes its saved session after the coordinator answers", { timeout: 20000 }, async () => {
  let workerTurns = 0;
  const h = await harness({
    worker: async (spec, message) => {
      workerTurns++;
      if (workerTurns === 1) {
        await invoke(spec, "iteration_question", { question: "Which retained run should I inspect?" });
        return "Waiting for a supervisor answer.";
      }
      assert.ok(spec.sessionFile, "answer must resume the original session");
      assert.match(message, /retained\/DP/);
      return "The retained files are available.";
    },
    coordinator: async (packet, spec) => {
      const lane = packet.lanes[0];
      if (!lane) await invoke(spec, "iteration_delegate", { name: "inspect", task: "Inspect retained results", acceptance: "Known input", role: "worker" });
      else if (lane.question && !lane.reply) await invoke(spec, "iteration_reply", { lane: "inspect", message: "Use /retained/DP" });
      else if (lane.state === "candidate") await invoke(spec, "iteration_block", { reason: "Inspection complete; awaiting user acceptance decision" });
    },
  });
  try {
    const { run } = await h.start();
    await until(async () => (await h.read())?.lanes.inspect?.state === "candidate");
    const sessions = h.sessions.filter((spec) => spec.label === "inspect");
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].sessionFile, join(sessions[0].sessionDir, "session.jsonl"));
    assert.equal(workerTurns, 2);
    abortPipelineFor(h.title); await run;
  } finally { await h.cleanup(); }
});

test("shutdown preserves a scheduler job and worktree, and resume reconnects without submitting again", { timeout: 30000 }, async () => {
  let externalState = "running", submissions = 0, cancellations = 0;
  const h = await harness({
    loop: { jobs: { capture: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", pollIntervalMs: 20 } } },
    command: async (input) => {
      switch (input.payload.operation) {
        case "submit": submissions++; return output({ state: externalState, externalId: "durable-42" });
        case "status": return output(submissions ? { state: externalState, externalId: "durable-42" } : { state: "missing" });
        case "cancel": cancellations++; return output({ state: "cancelled" });
        default: return output({ accepted: true, artifacts: ["/retained/capture.json"] });
      }
    },
    coordinator: async (packet, spec) => {
      if (!packet.jobs.length) await invoke(spec, "iteration_job", { name: "capture", adapter: "capture" });
      else if (packet.jobs[0].accepted) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", resultJob: "capture", rationale: "Reconnected and collected the original job" });
    },
  });
  try {
    const first = await h.start();
    await until(async () => Object.values((await h.read())?.jobs ?? {}).some((j) => j.externalId === "durable-42"));
    const before = await h.read();
    abortPipelineFor(h.title);
    assert.equal((await first.run).kind, "aborted");
    assert.equal(cancellations, 0);
    assert.equal((await h.read()).status, "paused");
    await sweepLoopWorktrees(h.cwd, () => false);
    await access(before.worktree);
    await access(Object.values(before.jobs)[0].worktree);
    externalState = "succeeded";
    const second = await h.start();
    assert.equal((await second.run).kind, "success", h.notifications.join("\n"));
    assert.equal(submissions, 1);
    assert.equal(cancellations, 0);
    assert.equal((await h.read()).iteration, 1);
    const coordinators = h.sessions.filter((spec) => spec.label === "Iteration coordinator");
    assert.equal(coordinators[1].sessionFile, before.sessionFile);
  } finally { await h.cleanup(); }
});

test("unconfirmed cancellation retains ownership and blocks replacing or removing scheduler work", { timeout: 20000 }, async () => {
  let submitted = false;
  const h = await harness({
    loop: { jobs: { capture: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", pollIntervalMs: 20 } } },
    command: async (input) => {
      if (input.payload.operation === "submit") { submitted = true; return output({ state: "running", externalId: "unknown-cancel" }); }
      if (input.payload.operation === "status") return output(submitted ? { state: "running", externalId: "unknown-cancel" } : { state: "missing" });
      return output({ state: "unknown" });
    },
    coordinator: async (packet, spec) => {
      if (!packet.jobs.length) await invoke(spec, "iteration_job", { name: "capture", adapter: "capture" });
      else if (packet.jobs[0].state === "unknown") await invoke(spec, "iteration_block", { reason: "Scheduler cancellation needs operator confirmation" });
    },
  });
  try {
    const { run } = await h.start();
    await until(async () => Object.values((await h.read())?.jobs ?? {}).some((j) => j.externalId));
    assert.equal(await cancelCoordinatorJobs(h.cwd, h.base), false);
    assert.ok(hasLiveRun(h.title));
    const saved = await h.read();
    assert.equal(Object.values(saved.jobs)[0].state, "unknown");
    await access(Object.values(saved.jobs)[0].worktree);
    abortPipelineFor(h.title); await run;
    assert.equal(await cancelCoordinatorJobs(h.cwd, h.base), false, "dormant unresolved work cannot be silently deleted");
  } finally { await h.cleanup(); }
});

test("more than three failed worker repairs stay in one iteration and preserve every inherited partial fix", { timeout: 30000 }, async () => {
  let attempts = 0;
  const h = await harness({
    loop: { validate: "check", jobs: {}, maxChildRuns: 8 },
    measure: async () => ({ validationPass: true, metricUnmeasured: false, tail: "pass" }),
    worker: async (spec) => {
      if (!spec.tools.includes("edit")) { await invoke(spec, "iteration_review", { verdict: "pass", findings: "Partial fixes and final source are correct" }); return "pass"; }
      attempts++;
      for (let previous = 1; previous < attempts; previous++) await access(join(spec.cwd, `partial-${previous}.txt`));
      if (attempts <= 4) {
        await writeFile(join(spec.cwd, `partial-${attempts}.txt`), `Useful repair ${attempts}\n`);
        throw new Error(`Need another repair after attempt ${attempts}`);
      }
      await writeFile(join(spec.cwd, "app.ts"), "export const value = 5;\n");
      return "All partial fixes retained";
    },
    coordinator: async (packet, spec) => {
      const writer = packet.lanes.find((lane: any) => lane.name === "writer");
      const review = packet.lanes.find((lane: any) => lane.name === "review");
      if (!writer || writer.state === "failed") {
        await invoke(spec, "iteration_delegate", { name: "writer", role: "worker", task: "Repair preserving useful partial source", acceptance: "All fixes present" }); return;
      }
      if (writer.state === "candidate" && !review) {
        await invoke(spec, "iteration_delegate", { name: "review", role: "reviewer", reviewOf: "writer", task: "Review all fixes", acceptance: "Correct" }); return;
      }
      if (review?.state === "candidate") {
        await invoke(spec, "iteration_integrate", { lane: "writer", review: "review", rationale: "Reviewed all inherited and new changes" });
        await invoke(spec, "iteration_measure", {}); return;
      }
      if (packet.measurement?.validationPass) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", rationale: "Validated the complete repaired source" });
    },
  });
  try {
    const { run } = await h.start();
    assert.equal((await run).kind, "success", h.notifications.join("\n"));
    assert.equal(attempts, 5);
    assert.equal((await readLoopLog(h.cwd, h.base)).length, 1);
    for (let attempt = 1; attempt <= 4; attempt++) await access(join(h.cwd, `partial-${attempt}.txt`));
    assert.match(await readFile(join(h.cwd, "app.ts"), "utf8"), /value = 5/);
  } finally { await h.cleanup(); }
});

test("a previous review cannot approve a changed retry candidate", { timeout: 30000 }, async () => {
  let attempts = 0, staleReviewRefused = false;
  const h = await harness({
    loop: { validate: "check", jobs: {} },
    measure: async () => ({ validationPass: true, metricUnmeasured: false, tail: "pass" }),
    worker: async (spec) => {
      if (!spec.tools.includes("edit")) { await invoke(spec, "iteration_review", { verdict: "pass", findings: "Reviewed supplied version" }); return "pass"; }
      attempts++;
      await writeFile(join(spec.cwd, "app.ts"), `export const value = ${attempts};\n`);
      return "Candidate ready";
    },
    coordinator: async (packet, spec) => {
      const lanes = Object.fromEntries(packet.lanes.map((lane: any) => [lane.name, lane]));
      if (!lanes.writer || (lanes.first?.state === "candidate" && lanes.writer.attempt === 1)) {
        await invoke(spec, "iteration_delegate", { name: "writer", role: "worker", task: "Produce next candidate", acceptance: "Correct value", claims: ["app.ts"] }); return;
      }
      if (lanes.writer.state === "candidate") {
        const review = lanes.writer.attempt === 1 ? "first" : "second";
        if (!lanes[review]) {
          if (review === "second") {
            await assert.rejects(invoke(spec, "iteration_integrate", { lane: "writer", review: "first", rationale: "Stale review must not approve" }), /exact current candidate/);
            staleReviewRefused = true;
          }
          await invoke(spec, "iteration_delegate", { name: review, role: "reviewer", task: "Review exact candidate", acceptance: "Correct", reviewOf: "writer" }); return;
        }
      }
      if (lanes.second?.state === "candidate") {
        await invoke(spec, "iteration_integrate", { lane: "writer", review: "second", rationale: "Current candidate reviewed" });
        await invoke(spec, "iteration_retire", { lane: "first", replacement: "second", rationale: "Superseded review retained" });
        await invoke(spec, "iteration_measure", {}); return;
      }
      if (packet.measurement?.validationPass) await invoke(spec, "iteration_finish", { decision: "keep", verdict: "complete", rationale: "Current source accepted" });
    },
  });
  try {
    const { run } = await h.start();
    assert.equal((await run).kind, "success", h.notifications.join("\n"));
    assert.ok(staleReviewRefused);
    assert.match(await readFile(join(h.cwd, "app.ts"), "utf8"), /value = 2/);
  } finally { await h.cleanup(); }
});

test("delegated children start without waiting for the coordinator's response to end", { timeout: 20000 }, async () => {
  let childStarted = false, parentObserved = false;
  const h = await harness({
    worker: async () => { childStarted = true; return "Child executed independently"; },
    coordinator: async (packet, spec) => {
      if (!packet.lanes.length) {
        await invoke(spec, "iteration_delegate", { name: "independent", role: "worker", task: "Inspect source", acceptance: "Report inspection" });
        await until(async () => childStarted, "child while coordinator turn is still active");
        parentObserved = true;
        await invoke(spec, "iteration_block", { reason: "Waiting for user acceptance of inspection" });
      }
    },
  });
  try {
    const { run } = await h.start();
    await until(async () => parentObserved);
    abortPipelineFor(h.title); await run;
  } finally { await h.cleanup(); }
});
