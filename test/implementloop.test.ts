import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { emptyPlan, writePlan } from "../src/artifacts.js";
import type { KanbanConfig, LoopConfig } from "../src/config.js";
import {
  IMPLEMENT_CHILD_TOOLS,
  decide,
  startImplementLoop,
  type LoopResult,
} from "../src/implementloop.js";
import type { MeasureOutcome } from "../src/measure.js";
import { abortPipelineFor, clearPipelineRegistry, hasLiveRun } from "../src/orchestrator.js";
import type { ChildResult, ChildSpec } from "../src/runner.js";
import { createSession, mutateAsync, type Session } from "../src/store.js";
import { readWorkfile, workfileBase, writeWorkfileSection } from "../src/workfile.js";
import { readLoopLog, readLoopRun } from "../src/looplog.js";

const execFileAsync = promisify(execFile);

const TITLE = "Loop session";

function loop(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    enabled: true,
    validate: "exit 0",
    direction: "higher",
    maxIterations: 3,
    noImprovementStreak: 3,
    measureTimeoutMs: 20_000,
    hooks: false,
    ...overrides,
  };
}

function config(overrides: Partial<KanbanConfig> = {}): KanbanConfig {
  return {
    models: {
      refine: null,
      research: null,
      grill: null,
      compose: null,
      implement: null,
      critique: null,
    },
    research: { workers: 3 },
    fastPath: true,
    critique: true,
    runner: "auto",
    piBin: "pi",
    init: {},
    loop: loop(),
    ...overrides,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Exit-code probe: true when the git command exits nonzero (an absent object, say). */
async function gitFails(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd });
    return false;
  } catch {
    return true;
  }
}

function sessionSync(cwd: string, title = TITLE): Session | undefined {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".kanban", "state.json"), "utf8"));
    return state.sessions.find((item: Session) => item.title === title);
  } catch {
    return undefined;
  }
}

interface ChildCall {
  spec: ChildSpec;
  iteration: number;
}

interface Harness {
  cwd: string;
  base: string;
  calls: ChildCall[];
  notifications: Array<{ message: string; type?: string }>;
  statuses: Array<string | undefined>;
  ctx: any;
  start: (overrides?: Partial<KanbanConfig>) => Promise<
    { armed: true; run: Promise<LoopResult> } | { armed: false; message: string }
  >;
  head: () => Promise<string>;
  cleanup: () => Promise<void>;
}

type ChildScript = (spec: ChildSpec, iteration: number) => Promise<ChildResult> | ChildResult;

interface HarnessOptions {
  child?: ChildScript;
  /** Extra committed files, path → content. */
  committed?: Record<string, string>;
  stage?: Session["stage"];
  mode?: "pipeline" | "manual";
  compose?: string;
  measure?: (cwd: string, config: LoopConfig, signal: AbortSignal) => Promise<MeasureOutcome>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-loop-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "loop@example.com");
  await git(cwd, "config", "user.name", "Loop Test");
  await writeFile(join(cwd, ".gitignore"), ".kanban/\n", "utf8");
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n", "utf8");
  for (const [path, content] of Object.entries(options.committed ?? {})) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, "utf8");
  }
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-qm", "base");

  await mutateAsync(cwd, async (state) => {
    const session = await createSession(cwd, state, TITLE);
    session.mode = options.mode ?? "pipeline";
    session.stage = options.stage ?? "implement";
    await writePlan(cwd, session.planPath, emptyPlan(session, "Raise the value in app.ts"));
  });
  const base = workfileBase(sessionSync(cwd)!.planPath);
  await writeWorkfileSection(
    cwd,
    base,
    "compose",
    options.compose ?? "Edit app.ts so that `value` is larger.",
  );

  const calls: ChildCall[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const runChild = async (spec: ChildSpec): Promise<ChildResult> => {
    const iteration = Number(/iteration (\d+) of/.exec(spec.prompt)?.[1] ?? 0);
    calls.push({ spec, iteration });
    if (!options.child) return { text: "Status: continue\nRationale: nothing", aborted: false };
    return options.child(spec, iteration);
  };
  const ctx: any = {
    cwd,
    hasUI: false,
    model: { provider: "test", id: "model", contextWindow: 100 },
    modelRegistry: { find: () => undefined },
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    isIdle: () => true,
    sessionManager: { getSessionFile: () => join(cwd, "chat.jsonl") },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: () => {},
    },
  };

  return {
    cwd,
    base,
    calls,
    notifications,
    statuses,
    ctx,
    start: (overrides) =>
      startImplementLoop(ctx, TITLE, {
        runChild,
        config: config(overrides),
        ...(options.measure ? { measure: options.measure as never } : {}),
      }) as never,
    head: async () => (await git(cwd, "rev-parse", "HEAD")).trim(),
    cleanup: async () => {
      clearPipelineRegistry();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Write a file inside the iteration worktree, the way the child's `write` tool would. */
async function childWrites(
  spec: ChildSpec,
  files: Record<string, string>,
  status: "complete" | "continue",
  rationale = "changed files",
): Promise<ChildResult> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(spec.cwd, path)), { recursive: true });
    await writeFile(join(spec.cwd, path), content, "utf8");
  }
  return { text: `Status: ${status}\nRationale: ${rationale}`, aborted: false };
}

async function unstagedOnly(cwd: string): Promise<{ unstaged: string; staged: string }> {
  return {
    unstaged: await git(cwd, "diff"),
    staged: await git(cwd, "diff", "--cached"),
  };
}

test("a complete iteration lands unstaged and advances the session to critique", async () => {
  const harnessed = await harness({
    child: (spec) =>
      childWrites(spec, { "app.ts": "export const value = 2;\n" }, "complete", "raised value"),
  });
  try {
    const head = await harnessed.head();
    const started = await harnessed.start();
    assert.equal(started.armed, true);
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "success");
    assert.equal(result.landed, true);
    assert.equal(result.advanced, true);
    assert.equal(result.iterations, 1);

    const diff = await unstagedOnly(harnessed.cwd);
    assert.match(diff.unstaged, /value = 2/);
    assert.equal(diff.staged, "", "the loop must never stage anything");
    assert.equal(await harnessed.head(), head, "the loop must never commit the user checkout");
    assert.equal(sessionSync(harnessed.cwd)?.stage, "critique");
    const run = await readLoopRun(harnessed.cwd, harnessed.base);
    assert.equal(run?.status, "success");
    assert.match(run?.branch ?? "", /^kanban-autoresearch\//);
    assert.notEqual(run?.bestCommit, head, "a kept candidate is committed only on the private branch");
    assert.equal(hasLiveRun(TITLE), false, "the run unregisters itself");
    assert.match(
      harnessed.notifications.map((entry) => entry.message).join("\n"),
      /moved to critique/,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("the child runs inside the iteration worktree with write tools and no shell", async () => {
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 3;\n" }, "complete"),
  });
  try {
    const started = await harnessed.start();
    await (started as { run: Promise<LoopResult> }).run;
    const call = harnessed.calls[0]!;
    assert.notEqual(call.spec.cwd, harnessed.cwd);
    assert.match(call.spec.cwd, /\.kanban\/worktrees\//);
    assert.deepEqual(call.spec.tools, [...IMPLEMENT_CHILD_TOOLS]);
    assert.equal(call.spec.tools.includes("bash"), false);
    assert.match(call.spec.prompt, /## The recorded spec/);
    assert.match(call.spec.prompt, /Status: complete/);
  } finally {
    await harnessed.cleanup();
  }
});

test("a failed validation discards the iteration and its files never land", async () => {
  const harnessed = await harness({
    child: (spec, iteration) =>
      iteration === 1
        ? childWrites(spec, { "broken.ts": "syntax error\n" }, "continue", "tried a bad edit")
        : childWrites(spec, { "app.ts": "export const value = 4;\nexport const ok = 1;\n" }, "complete", "fixed it"),
  });
  try {
    const started = await harnessed.start({
      loop: loop({ validate: "test ! -f broken.ts" }),
    });
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "success");
    assert.equal(result.iterations, 2);
    const diff = await unstagedOnly(harnessed.cwd);
    assert.match(diff.unstaged, /value = 4/);
    assert.equal(existsSync(join(harnessed.cwd, "broken.ts")), false);
    assert.equal(diff.staged, "");

    // A successful advance preserves the durable experiment history as the resume/audit source.
    const section = (await readWorkfile(harnessed.cwd, harnessed.base)).sections.implement ?? "";
    assert.match(section, /1\. discard/);
    assert.match(section, /bad edit/);
    assert.match(section, /2\. keep/);
    assert.equal(
      existsSync(join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.jsonl`)),
      true,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("a kept iteration is the base the next iteration builds on", async () => {
  const seen: string[] = [];
  const harnessed = await harness({
    child: async (spec, iteration) => {
      seen.push(await readFile(join(spec.cwd, "app.ts"), "utf8"));
      return childWrites(
        spec,
        { "app.ts": `export const value = ${iteration + 1};\n` },
        iteration === 2 ? "complete" : "continue",
      );
    },
  });
  try {
    const started = await harnessed.start();
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "success");
    assert.deepEqual(seen, ["export const value = 1;\n", "export const value = 2;\n"]);
  } finally {
    await harnessed.cleanup();
  }
});

test("no iteration kept lands nothing, keeps the stage, and leaves the lessons", async () => {
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 9;\n" }, "complete"),
  });
  try {
    const started = await harnessed.start({ loop: loop({ validate: "exit 1", maxIterations: 2 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "failure");
    assert.equal(result.landed, false);
    assert.equal(result.advanced, false);
    assert.equal(result.iterations, 2);
    assert.equal((await unstagedOnly(harnessed.cwd)).unstaged, "");
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
    assert.ok(existsSync(join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.md`)));
    assert.ok(existsSync(join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.jsonl`)));
    assert.match(
      harnessed.notifications.map((entry) => entry.message).join("\n"),
      /no iteration improved/,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("exhausted iterations land the partial best but never advance the stage", async () => {
  const harnessed = await harness({
    child: (spec, iteration) =>
      childWrites(spec, { "app.ts": `export const value = ${iteration + 1};\n` }, "continue"),
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 2 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "exhausted");
    assert.equal(result.landed, true);
    assert.equal(result.advanced, false);
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
    assert.match((await unstagedOnly(harnessed.cwd)).unstaged, /value = 3/);
    assert.match(
      harnessed.notifications.map((entry) => entry.message).join("\n"),
      /no iteration reported the spec complete/,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("the no-improvement streak stops the loop early", async () => {
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 5;\n" }, "continue"),
  });
  try {
    const started = await harnessed.start({
      loop: loop({ validate: "exit 1", maxIterations: 9, noImprovementStreak: 2 }),
    });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "failure");
    assert.equal(result.iterations, 2);
  } finally {
    await harnessed.cleanup();
  }
});

test("new files, including nested and dash-prefixed ones, survive the landing", async () => {
  const harnessed = await harness({
    child: (spec) =>
      childWrites(
        spec,
        {
          "src/nested/new file.ts": "export const nested = true;\n",
          "-dash.ts": "export const dash = true;\n",
        },
        "complete",
      ),
  });
  try {
    const started = await harnessed.start();
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "success");
    assert.equal(
      await readFile(join(harnessed.cwd, "src", "nested", "new file.ts"), "utf8"),
      "export const nested = true;\n",
    );
    assert.equal(
      await readFile(join(harnessed.cwd, "-dash.ts"), "utf8"),
      "export const dash = true;\n",
    );
    assert.equal((await unstagedOnly(harnessed.cwd)).staged, "");
  } finally {
    await harnessed.cleanup();
  }
});

test("a metric keeps only strict improvements and honours the target", async () => {
  const harnessed = await harness({
    committed: { "score.txt": "1\n" },
    child: (spec, iteration) =>
      childWrites(
        spec,
        { "score.txt": iteration === 1 ? "0\n" : "5\n" },
        "complete",
        `score attempt ${iteration}`,
      ),
  });
  try {
    const started = await harnessed.start({
      loop: loop({
        validate: "exit 0",
        metric: "echo METRIC score=$(cat score.txt)",
        metric_name: "score",
        direction: "higher",
        target: 5,
        maxIterations: 3,
      }),
    });
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "success");
    const section = (await readWorkfile(harnessed.cwd, harnessed.base)).sections.implement ?? "";
    assert.match(section, /1\. discard/);
    assert.match(section, /did not improve/);
    assert.match(section, /2\. keep \(agent: keep\) metric 5/);
    assert.match(await readFile(join(harnessed.cwd, "score.txt"), "utf8"), /5/);
  } finally {
    await harnessed.cleanup();
  }
});

test("a complete verdict short of the metric target exhausts instead of advancing", async () => {
  const harnessed = await harness({
    committed: { "score.txt": "1\n" },
    child: (spec) => childWrites(spec, { "score.txt": "2\n" }, "complete"),
  });
  try {
    const started = await harnessed.start({
      loop: loop({
        metric: "echo METRIC score=$(cat score.txt)",
        metric_name: "score",
        target: 10,
        maxIterations: 1,
      }),
    });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "exhausted");
    assert.equal(result.landed, true);
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
  } finally {
    await harnessed.cleanup();
  }
});

test("arming is refused when the loop is disabled, unarmed, dirty, or already live", async () => {
  const disabled = await harness();
  try {
    const started = await disabled.start({ loop: loop({ enabled: false }) });
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /disabled/);
  } finally {
    await disabled.cleanup();
  }

  const noFitness = await harness();
  try {
    const started = await noFitness.start({
      loop: { ...loop(), validate: undefined, metric: undefined },
    });
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /fitness signal/);
  } finally {
    await noFitness.cleanup();
  }

  const dirty = await harness();
  try {
    await writeFile(join(dirty.cwd, "app.ts"), "export const value = 99;\n", "utf8");
    const started = await dirty.start();
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /clean working tree/);
  } finally {
    await dirty.cleanup();
  }

  const wrongStage = await harness({ stage: "critique" });
  try {
    const started = await wrongStage.start();
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /implement stage/);
  } finally {
    await wrongStage.cleanup();
  }

  const manual = await harness({ mode: "manual" });
  try {
    const started = await manual.start();
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /manual mode/);
  } finally {
    await manual.cleanup();
  }
});

test("a second loop is refused while the first is live", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harnessed = await harness({
    child: async (spec) => {
      await gate;
      return childWrites(spec, { "app.ts": "export const value = 7;\n" }, "complete");
    },
  });
  try {
    const first = await harnessed.start();
    assert.equal(first.armed, true);
    const second = await harnessed.start();
    assert.equal(second.armed, false);
    assert.match((second as { message: string }).message, /already live/);
    release!();
    const result = await (first as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "success");
  } finally {
    release?.();
    await harnessed.cleanup();
  }
});

test("aborting the run lands nothing and removes every worktree", async () => {
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const harnessed = await harness({
    child: async (spec) => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (spec.signal.aborted) return { text: "", aborted: true, errorKind: "aborted" as const };
      return childWrites(spec, { "app.ts": "export const value = 8;\n" }, "complete");
    },
  });
  try {
    const arming = await harnessed.start();
    assert.equal(arming.armed, true);
    await reached;
    assert.equal(hasLiveRun(TITLE), true);
    abortPipelineFor(TITLE);
    const result = await (arming as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "aborted");
    assert.equal(result.landed, false);
    assert.equal((await unstagedOnly(harnessed.cwd)).unstaged, "");
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
    const worktrees = await git(harnessed.cwd, "worktree", "list");
    assert.equal(worktrees.trim().split("\n").length, 1, "only the main worktree remains");
  } finally {
    await harnessed.cleanup();
  }
});

test("every worktree is removed and unregistered after a normal run", async () => {
  const harnessed = await harness({
    child: (spec, iteration) =>
      childWrites(spec, { "app.ts": `export const value = ${iteration + 1};\n` }, "complete"),
  });
  try {
    const started = await harnessed.start();
    await (started as { run: Promise<LoopResult> }).run;
    const worktrees = await git(harnessed.cwd, "worktree", "list");
    assert.equal(worktrees.trim().split("\n").length, 1);
    assert.equal(
      existsSync(join(harnessed.cwd, ".kanban", "worktrees", harnessed.base, "1")),
      false,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("an unresolvable implement model stops the loop instead of burning iterations", async () => {
  const harnessed = await harness({
    child: () => ({
      text: "",
      aborted: false,
      errorKind: "model" as const,
      error: "configured implement model “x:y” did not resolve",
    }),
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 5 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.kind, "failure");
    assert.equal(result.iterations, 1);
    assert.match(String(result.message), /models\.implement/);
  } finally {
    await harnessed.cleanup();
  }
});

test("decide is the deterministic fitness rule", () => {
  const pass: MeasureOutcome = { validationPass: true, tail: "", metricUnmeasured: false };
  assert.equal(decide(loop({ metric: undefined }), pass, undefined).keep, true);
  assert.equal(
    decide(loop({ metric: undefined }), { ...pass, validationPass: false }, undefined).keep,
    false,
  );
  const withMetric = loop({ metric: "echo METRIC x=1" });
  assert.equal(decide(withMetric, { ...pass, metric: 2 }, 1).keep, true);
  assert.equal(decide(withMetric, { ...pass, metric: 1 }, 1).keep, false);
  assert.equal(decide(withMetric, { ...pass, metricUnmeasured: true }, 1).keep, false);
  assert.equal(
    decide({ ...withMetric, direction: "lower" }, { ...pass, metric: 0 }, 1).keep,
    true,
  );
  assert.equal(
    decide({ ...withMetric, direction: "lower" }, { ...pass, metric: 2 }, 1).keep,
    false,
  );
});

test("a non-git directory is refused cleanly instead of throwing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-loop-nogit-"));
  try {
    await mutateAsync(cwd, async (state) => {
      const session = await createSession(cwd, state, TITLE);
      session.mode = "pipeline";
      session.stage = "implement";
      await writePlan(cwd, session.planPath, emptyPlan(session, "no git here"));
    });
    const notifications: Array<{ message: string; type?: string }> = [];
    const ctx: any = {
      cwd,
      hasUI: false,
      model: { provider: "test", id: "model", contextWindow: 100 },
      modelRegistry: { find: () => undefined },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
      isIdle: () => true,
      sessionManager: { getSessionFile: () => join(cwd, "chat.jsonl") },
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        setStatus: () => {},
        setWidget: () => {},
      },
    };
    const started = await startImplementLoop(ctx, TITLE, {
      runChild: async () => ({ text: "Status: complete", aborted: false }),
      config: config(),
    });
    assert.equal(started.armed, false);
    assert.match(notifications.map((entry) => entry.message).join("\n"), /Git repository/);
    assert.equal(hasLiveRun(TITLE), false);
  } finally {
    clearPipelineRegistry();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("landing is refused when the repository moved under the loop, and the patch is kept", async () => {
  const harnessed = await harness({
    child: async (spec) => {
      // The user commits something else while the iteration is still running.
      await writeFile(join(harnessed.cwd, "other.ts"), "export const other = 1;\n", "utf8");
      await git(harnessed.cwd, "add", "other.ts");
      await git(harnessed.cwd, "commit", "-qm", "concurrent");
      return childWrites(spec, { "app.ts": "export const value = 6;\n" }, "complete");
    },
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 1 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.landed, false);
    assert.equal(result.advanced, false);
    assert.match(String(result.message), /different commit/);
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
    // The winning patch is always recoverable by hand.
    const patch = await readFile(
      join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.patch`),
      "utf8",
    );
    assert.match(patch, /value = 6/);
    assert.equal(
      existsSync(join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.landed`)),
      false,
    );
    assert.match(
      harnessed.notifications.map((entry) => entry.message).join("\n"),
      /couldn.t land|could not land/i,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("landing is refused when the working tree was dirtied under the loop", async () => {
  const harnessed = await harness({
    child: async (spec) => {
      await writeFile(join(harnessed.cwd, "app.ts"), "export const value = 42;\n", "utf8");
      return childWrites(spec, { "app.ts": "export const value = 7;\n" }, "complete");
    },
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 1 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.landed, false);
    assert.equal(result.advanced, false);
    assert.match(String(result.message), /uncommitted changes to tracked files/);
    // The user's own edit is untouched.
    assert.equal(
      await readFile(join(harnessed.cwd, "app.ts"), "utf8"),
      "export const value = 42;\n",
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("landing is refused when the session token goes stale under the loop", async () => {
  const harnessed = await harness({
    child: async (spec) => {
      await mutateAsync(harnessed.cwd, async (state) => {
        const record = state.sessions.find((item) => item.title === TITLE)!;
        record.pipelineToken = "someone-else";
      });
      return childWrites(spec, { "app.ts": "export const value = 11;\n" }, "complete");
    },
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 1 }) });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.landed, false);
    assert.equal(result.advanced, false);
    assert.equal((await unstagedOnly(harnessed.cwd)).unstaged, "");
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
  } finally {
    await harnessed.cleanup();
  }
});

test("arming is refused when a configured metric has no measurable baseline", async () => {
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 3;\n" }, "complete"),
  });
  try {
    const started = await harnessed.start({
      loop: loop({ metric: "echo nothing useful", metric_name: "score" }),
    });
    assert.equal(started.armed, false);
    assert.match((started as { message: string }).message, /baseline metric/);
    assert.equal(hasLiveRun(TITLE), false);
    // A refused arming must not leave a token behind for a later run to trip over.
    assert.equal(sessionSync(harnessed.cwd)?.pipelineToken, undefined);
    const worktrees = await git(harnessed.cwd, "worktree", "list");
    assert.equal(worktrees.trim().split("\n").length, 1);
  } finally {
    await harnessed.cleanup();
  }
});

test("aborting AFTER a kept iteration still lands nothing", async () => {
  let reached!: () => void;
  const first = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const harnessed = await harness({
    child: async (spec, iteration) => {
      if (iteration === 2) {
        reached();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return childWrites(
        spec,
        { "app.ts": `export const value = ${iteration + 1};\n` },
        "continue",
      );
    },
  });
  try {
    const started = await harnessed.start({ loop: loop({ maxIterations: 4 }) });
    await first;
    abortPipelineFor(TITLE);
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "aborted");
    assert.equal(result.landed, false);
    assert.equal((await unstagedOnly(harnessed.cwd)).unstaged, "");
    assert.equal(sessionSync(harnessed.cwd)?.stage, "implement");
    // The best-so-far patch from the kept first iteration survives for the user.
    assert.match(
      await readFile(join(harnessed.cwd, ".kanban", "loop", `${harnessed.base}.patch`), "utf8"),
      /value = 2/,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("loop progress is reported on the status line", async () => {
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 12;\n" }, "complete"),
  });
  try {
    const started = await harnessed.start();
    await (started as { run: Promise<LoopResult> }).run;
    const lines = harnessed.statuses.filter((line): line is string => Boolean(line));
    assert.ok(lines.some((line) => /baseline/.test(line)));
    assert.ok(lines.some((line) => /iteration 1\/3/.test(line)));
    // The status line is cleared when the run releases.
    assert.equal(harnessed.statuses.at(-1), undefined);
  } finally {
    await harnessed.cleanup();
  }
});

test("a configured baseline metric is trusted instead of measured", async () => {
  const measured: string[] = [];
  const harnessed = await harness({
    child: (spec) => childWrites(spec, { "app.ts": "export const value = 9;\n" }, "complete"),
    measure: async (cwd) => {
      measured.push(cwd);
      return { validationPass: true, tail: "", metric: 9, metricUnmeasured: false };
    },
  });
  try {
    const started = await harnessed.start({
      loop: loop({
        validate: undefined,
        metric: "echo METRIC score=9",
        metric_name: "score",
        baselineMetric: 1,
        target: 9,
      }),
    });
    assert.equal(started.armed, true);
    const result = await (started as { run: Promise<LoopResult> }).run;

    assert.equal(result.kind, "success");
    assert.equal(measured.length, 1, "only the iteration is measured; the baseline is not");
    assert.match(measured[0], /worktrees\/.+\/1$/, "the single measurement is iteration 1's");
    const run = await readLoopRun(harnessed.cwd, harnessed.base);
    assert.equal(run?.baselineMetric, 1);
    assert.match(
      harnessed.statuses.filter(Boolean).join("\n"),
      /baseline 1 taken from config/,
    );
  } finally {
    await harnessed.cleanup();
  }
});

test("the audit ref keeps every attempt and its evidence while the accepted commit stays clean", async () => {
  const harnessed = await harness({
    // `evidence/` is ignored, so it can only reach Git through the audit ref's force-add.
    committed: { ".gitignore": ".kanban/\nevidence/\n" },
    child: async (spec, iteration) => {
      await childWrites(spec, { "app.ts": `export const value = ${iteration + 1};\n` }, "continue");
      // The second attempt asks to be reverted, so the audit ref has to hold a discard too.
      return {
        text:
          iteration === 2
            ? "Status: continue\nDecision: revert\nRationale: regressed"
            : "Status: continue\nDecision: keep\nRationale: raised value",
        aborted: false,
      };
    },
    measure: async (cwd) => {
      // Stand in for a gate that submits external work and writes back what it observed.
      await mkdir(join(cwd, "evidence"), { recursive: true });
      await writeFile(join(cwd, "evidence", "gate.log"), `attempt observed in ${cwd}\n`, "utf8");
      return { validationPass: true, tail: "", metric: 1, metricUnmeasured: false };
    },
  });
  try {
    const started = await harnessed.start({
      loop: loop({
        maxIterations: 2,
        decisionPolicy: "agent-with-validation",
        audit: true,
        auditPaths: ["evidence"],
      }),
    });
    const result = await (started as { run: Promise<LoopResult> }).run;
    assert.equal(result.iterations, 2);

    const run = await readLoopRun(harnessed.cwd, harnessed.base);
    const auditRef = run?.auditRef ?? "";
    assert.equal(auditRef, `kanban-audit/${harnessed.base}`);
    const head = (await git(harnessed.cwd, "rev-parse", "HEAD")).trim();
    assert.equal(
      (await git(harnessed.cwd, "rev-list", "--count", `${head}..${auditRef}`)).trim(),
      "2",
      "one audit commit per attempt, kept and discarded alike",
    );

    const records = await readLoopLog(harnessed.cwd, harnessed.base);
    assert.deepEqual(
      records.map((record) => record.decision),
      ["keep", "discard"],
    );
    for (const record of records) {
      assert.ok(record.auditCommit, `iteration ${record.iteration} records its audit commit`);
      assert.match(
        await git(harnessed.cwd, "show", `${record.auditCommit}:evidence/gate.log`),
        /attempt observed in/,
        "the disposable worktree's evidence survives in the audit commit",
      );
    }

    assert.equal(
      await gitFails(harnessed.cwd, "cat-file", "-e", `${run?.bestCommit}:evidence/gate.log`),
      true,
      "the accepted experiment commit carries no evidence",
    );
    assert.equal(existsSync(join(harnessed.cwd, "evidence")), false, "and neither does the checkout");
  } finally {
    await harnessed.cleanup();
  }
});
