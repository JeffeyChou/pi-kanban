import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyPlan, readPlan, writePlan, type PlanSnapshot } from "../src/artifacts.js";
import type { KanbanConfig } from "../src/config.js";
import {
  abortPipelineFor,
  clearPipelineRegistry,
  pipelineRunFor,
  runCritiqueGate,
  startPipeline,
  type OrchestratorDeps,
} from "../src/orchestrator.js";
import type { ChildResult, ChildSpec } from "../src/runner.js";
import { createSession, mutateAsync, type Session, type Stage } from "../src/store.js";
import {
  readWorkfile,
  workfileBase,
  workfilePath,
  writeWorkfileSection,
} from "../src/workfile.js";

type ChildScript = (spec: ChildSpec, index: number) => ChildResult | Promise<ChildResult>;

interface ChildCall {
  spec: ChildSpec;
  stage: Stage;
  angle?: number;
  /** The stage persisted in state.json at the moment the child started. */
  persistedStage?: Stage;
  persistedToken?: string;
}

interface NotifyRecord {
  message: string;
  type?: string;
}

const DEFAULT_TEXT: Partial<Record<Stage, string>> = {
  refine: "## refine\nGoal: keep the board durable.\nVerdict: standard",
  research: "## research\nstore.ts owns the lock.",
  grill: "## grill\nQ: Cap the sections?\nRecommended: yes, 300 lines",
  compose: "## compose\nEdit src/store.ts, then run the tests.",
  critique: "## critique\nGate: PASS\nThe change matches the spec.",
};

function ok(text: string): ChildResult {
  return { text, aborted: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    loop: {
      enabled: false,
      direction: "higher",
      maxIterations: 10,
      noImprovementStreak: 3,
      measureTimeoutMs: 300_000,
      hooks: false,
    },
    ...overrides,
  };
}

function stateSync(cwd: string): { sessions: Session[] } | undefined {
  try {
    return JSON.parse(readFileSync(join(cwd, ".kanban", "state.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function sessionSync(cwd: string, title: string): Session | undefined {
  return stateSync(cwd)?.sessions.find((session) => session.title === title);
}

function stageOf(prompt: string): Stage {
  return (/^# Kanban (\w+) stage/m.exec(prompt)?.[1] ?? "refine") as Stage;
}

function angleOf(prompt: string): number | undefined {
  const match = /Your angle is (\d) of/.exec(prompt);
  return match ? Number(match[1]) : undefined;
}

interface Harness {
  cwd: string;
  title: string;
  ctx: any;
  deps: OrchestratorDeps;
  calls: ChildCall[];
  /** Stages whose child observed `.kanban/lock` held — always empty. */
  lockViolations: Stage[];
  notifications: NotifyRecord[];
  statuses: Array<string | undefined>;
  opened: Array<{ session: Session; spec: string | undefined }>;
  session: () => Session | undefined;
  plan: () => Promise<PlanSnapshot | undefined>;
  /** Recorded workfile sections, read back from `.kanban/work/<base>.md`. */
  sections: () => Promise<Partial<Record<Stage, string>>>;
  workfileText: () => string | undefined;
  run: () => Promise<void>;
  cleanup: () => Promise<void>;
}

interface HarnessOptions {
  title?: string;
  hasUI?: boolean;
  script?: Partial<Record<Stage, ChildScript>>;
  config?: Partial<KanbanConfig>;
  ui?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  /** Skip seeding a pipeline session (e.g. to seed it differently). */
  seed?: (cwd: string, title: string) => Promise<void>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-orchestrator-"));
  const title = options.title ?? "Pipeline session";

  if (options.seed) await options.seed(cwd, title);
  else
    await mutateAsync(cwd, async (state) => {
      const session = await createSession(cwd, state, title);
      session.mode = "pipeline";
      await writePlan(
        cwd,
        session.planPath,
        emptyPlan(session, "Refresh the durable board persistence"),
      );
    });
  const base = workfileBase(sessionSync(cwd, title)!.planPath);

  const calls: ChildCall[] = [];
  const lockViolations: Stage[] = [];
  const counts = new Map<Stage, number>();
  const runChild = async (spec: ChildSpec): Promise<ChildResult> => {
    const stage = stageOf(spec.prompt);
    // Children ALWAYS run outside the repository lock.
    if (existsSync(join(cwd, ".kanban", "lock"))) lockViolations.push(stage);
    const persisted = sessionSync(cwd, title);
    calls.push({
      spec,
      stage,
      ...(angleOf(spec.prompt) === undefined ? {} : { angle: angleOf(spec.prompt) }),
      ...(persisted ? { persistedStage: persisted.stage, persistedToken: persisted.pipelineToken } : {}),
    });
    const index = counts.get(stage) ?? 0;
    counts.set(stage, index + 1);
    const script = options.script?.[stage];
    if (script) return script(spec, index);
    return ok(DEFAULT_TEXT[stage] ?? `## ${stage}\nbody`);
  };

  const notifications: NotifyRecord[] = [];
  const statuses: Array<string | undefined> = [];
  const opened: Array<{ session: Session; spec: string | undefined }> = [];
  const ctx: any = {
    cwd,
    hasUI: options.hasUI ?? false,
    model: { provider: "test", id: "model", contextWindow: 100 },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "known" ? { provider, id, contextWindow: 100 } : undefined,
    },
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    isIdle: () => true,
    sessionManager: { getSessionFile: () => join(cwd, "chat.jsonl") },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: () => {},
      ...options.ui,
    },
    ...options.ctx,
  };

  const deps: OrchestratorDeps = {
    runChild,
    config: config(options.config),
    openImplementConversation: async (session, spec) => {
      opened.push({ session, spec });
      return { cancelled: false };
    },
  };

  return {
    cwd,
    title,
    ctx,
    deps,
    calls,
    lockViolations,
    notifications,
    statuses,
    opened,
    session: () => sessionSync(cwd, title),
    plan: async () => {
      const session = sessionSync(cwd, title);
      return session ? readPlan(cwd, session.planPath) : undefined;
    },
    sections: async () => (await readWorkfile(cwd, base)).sections,
    workfileText: () => {
      try {
        return readFileSync(workfilePath(cwd, base), "utf8");
      } catch {
        return undefined;
      }
    },
    run: async () => {
      await startPipeline(ctx, title, deps);
      await pipelineRunFor(title);
    },
    cleanup: async () => {
      clearPipelineRegistry();
      await rm(cwd, { recursive: true, force: true });
      assert.deepEqual(lockViolations, [], "the lock was held while a child session ran");
    },
  };
}

function messages(harnessed: Harness): string {
  return harnessed.notifications.map((item) => item.message).join("\n");
}

test("the happy path commits one stage per child and ends at implement with a /kanban open notify", async () => {
  const kanban = await harness();
  try {
    await kanban.run();

    assert.deepEqual(
      kanban.calls.map((call) => call.stage),
      ["refine", "research", "research", "research", "grill", "compose"],
    );
    // Every child observed exactly its own stage in state.json: one stage per commit.
    for (const call of kanban.calls) assert.equal(call.persistedStage, call.stage);
    assert.deepEqual(
      kanban.calls.filter((call) => call.stage === "research").map((call) => call.angle),
      [1, 2, 3],
    );

    const written = await kanban.sections();
    assert.deepEqual(Object.keys(written), ["refine", "research", "grill", "compose"]);
    for (const [stage, body] of Object.entries(written)) {
      assert.doesNotMatch(body, new RegExp(`^##\\s+${stage}`, "m"), "bodies exclude headings");
      assert.ok(body.trim().length > 0);
    }
    // writeWorkfileSection owns the heading lines; each stage has exactly one.
    const raw = kanban.workfileText()!;
    for (const stage of ["refine", "research", "grill", "compose"])
      assert.equal(raw.split("\n").filter((line) => line === `## ${stage}`).length, 1);
    assert.match(written.research!, /### Angle 1 — repository structure and conventions/);
    assert.match(written.grill!, /A: ASSUMED: yes, 300 lines/);
    assert.deepEqual(kanban.lockViolations, [], "children never run under the repository lock");
    // Recorded sections are the prompt input for every later stage.
    assert.match(
      kanban.calls.find((call) => call.stage === "compose")!.spec.prompt,
      /Goal: keep the board durable\./,
    );

    assert.equal(kanban.session()?.stage, "implement");
    assert.equal((await kanban.plan())?.stage, "implement");
    assert.match(messages(kanban), /composed the spec/);
    assert.match(messages(kanban), /\/kanban open/);
    // v6/v7: the orchestrator never switches the conversation itself.
    assert.deepEqual(kanban.opened, []);
    // The registry entry is removed when the run ends.
    assert.equal(abortPipelineFor(kanban.title), false);
    assert.equal(kanban.statuses.at(-1), undefined, "the status line is cleared at the end");
  } finally {
    await kanban.cleanup();
  }
});

test("a simple refine verdict takes the fast path and records the justification", async () => {
  const kanban = await harness({
    script: { refine: () => ok("## refine\nOne file.\nVerdict: simple") },
  });
  try {
    await kanban.run();
    assert.deepEqual(
      kanban.calls.map((call) => call.stage),
      ["refine", "compose"],
    );
    const written = await kanban.sections();
    assert.match(written.research!, /Skipped by the fast path/);
    assert.match(written.grill!, /Skipped by the fast path/);
    assert.equal(kanban.session()?.stage, "implement");
    const plan = await kanban.plan();
    assert.equal((plan as unknown as { complexity?: string }).complexity, "simple");
    assert.match(plan!.work.done.join("\n"), /Fast path: refine returned/);
  } finally {
    await kanban.cleanup();
  }
});

test("fastPath false records the verdict without skipping research or grill", async () => {
  const kanban = await harness({
    config: { fastPath: false },
    script: { refine: () => ok("## refine\nOne file.\nVerdict: simple") },
  });
  try {
    await kanban.run();
    assert.deepEqual(
      kanban.calls.map((call) => call.stage),
      ["refine", "research", "research", "research", "grill", "compose"],
    );
    assert.equal(
      (
        (await kanban.plan()) as unknown as { complexity?: string }
      ).complexity,
      "simple",
    );
    assert.doesNotMatch((await kanban.sections()).research!, /fast path/i);
  } finally {
    await kanban.cleanup();
  }
});

test("grill walks open questions through ui.select/ui.input with the run's abort signal", async () => {
  const asked: Array<{ title: string; options?: string[]; signal?: AbortSignal }> = [];
  const kanban = await harness({
    hasUI: true,
    script: {
      grill: () =>
        ok(
          [
            "## grill",
            "Q: Cap the sections?",
            "Recommended: yes, 300 lines",
            "Q: Delete the workfile at completion?",
            "Recommended: yes",
          ].join("\n"),
        ),
    },
    ui: {
      select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
        asked.push({ title, options, signal: opts?.signal });
        return asked.length === 1 ? options[0] : "Answer differently…";
      },
      input: async (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => {
        asked.push({ title, signal: opts?.signal });
        return "delete it and sweep orphans";
      },
    },
  });
  try {
    await kanban.run();
    const grillChild = kanban.calls.find((call) => call.stage === "grill")!;
    assert.equal(asked.length, 3);
    for (const dialog of asked) assert.equal(dialog.signal, grillChild.spec.signal);
    assert.deepEqual(asked[0]!.options, [
      "yes, 300 lines",
      "Answer differently…",
      "Skip (record assumption)",
    ]);
    const grill = (await kanban.sections()).grill!;
    assert.match(grill, /Q: Cap the sections\?\nA: yes, 300 lines/);
    assert.match(grill, /A: delete it and sweep orphans/);
    // The collected answers reach the compose child.
    assert.match(
      kanban.calls.find((call) => call.stage === "compose")!.spec.prompt,
      /delete it and sweep orphans/,
    );
  } finally {
    await kanban.cleanup();
  }
});

test("without a UI the grill recommendations are auto-accepted as assumptions", async () => {
  const kanban = await harness({ hasUI: false });
  try {
    await kanban.run();
    assert.match((await kanban.sections()).grill!, /A: ASSUMED: yes, 300 lines/);
  } finally {
    await kanban.cleanup();
  }
});

test("an unparseable grill keeps the body, warns, and continues", async () => {
  const kanban = await harness({
    hasUI: true,
    script: { grill: () => ok("## grill\nProse with no question pairs.") },
    ui: {
      select: async () => {
        throw new Error("no dialog may be shown without parsed questions");
      },
    },
  });
  try {
    await kanban.run();
    assert.match((await kanban.sections()).grill!, /Prose with no question pairs\./);
    assert.ok(
      kanban.notifications.some(
        (item) => item.type === "warning" && /no parseable Q:\/Recommended: pairs/.test(item.message),
      ),
    );
    assert.equal(kanban.session()?.stage, "implement");
  } finally {
    await kanban.cleanup();
  }
});

test("research advances when one worker fails and notes the gap in the section", async () => {
  const kanban = await harness({
    script: {
      research: (spec) =>
        angleOf(spec.prompt) === 2
          ? { text: "", aborted: false, errorKind: "model", error: "no auth in child" }
          : ok(`## research\nangle ${angleOf(spec.prompt)} facts`),
    },
  });
  try {
    await kanban.run();
    const research = (await kanban.sections()).research!;
    assert.match(research, /angle 1 facts/);
    assert.match(research, /Worker failed \(model\): no auth in child\./);
    assert.match(research, /angle 3 facts/);
    assert.equal(kanban.session()?.stage, "implement");
    assert.equal(kanban.session()?.mode, "pipeline");
  } finally {
    await kanban.cleanup();
  }
});

test("all research workers failing flips the session to manual mode durably", async () => {
  const kanban = await harness({
    script: {
      research: () => ({ text: "", aborted: false, errorKind: "model", error: "no auth in child" }),
    },
  });
  try {
    await kanban.run();
    const session = kanban.session()!;
    assert.equal(session.mode, "manual");
    assert.equal(session.stage, "research");
    assert.equal(session.pipelineToken, undefined);
    assert.equal((await kanban.sections()).research, undefined);
    const notice = kanban.notifications.find((item) => item.type === "error")!;
    assert.match(notice.message, /research child failed \(model: no auth in child\)/);
    assert.match(notice.message, /model test:model/);
    assert.match(notice.message, /manual mode/);
  } finally {
    await kanban.cleanup();
  }
});

test("a refine child failure flips to manual mode and stops the pipeline", async () => {
  const kanban = await harness({
    script: {
      refine: () => ({ text: "", aborted: false, errorKind: "spawn", error: "pi not found" }),
    },
  });
  try {
    await kanban.run();
    assert.deepEqual(kanban.calls.map((call) => call.stage), ["refine"]);
    const session = kanban.session()!;
    assert.equal(session.mode, "manual");
    assert.equal(session.stage, "refine");
    assert.equal(session.pipelineToken, undefined);
    assert.equal(kanban.workfileText(), undefined);
    assert.match(messages(kanban), /refine child failed \(spawn: pi not found\)/);
  } finally {
    await kanban.cleanup();
  }
});

test("an unresolvable configured model fails the stage instead of running a child", async () => {
  const kanban = await harness({
    config: { models: {
        refine: "missing:model",
        research: null,
        grill: null,
        compose: null,
        implement: null,
        critique: null,
      } },
  });
  try {
    await kanban.run();
    assert.deepEqual(kanban.calls, []);
    assert.equal(kanban.session()?.mode, "manual");
    assert.match(messages(kanban), /configured refine model “missing:model” did not resolve/);
  } finally {
    await kanban.cleanup();
  }
});

test("a late child that returns after an abort commits nothing", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await harness({ script: { refine: () => gate.promise } });
  try {
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const run = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(abortPipelineFor(kanban.title), true);
    assert.equal(kanban.calls[0]!.spec.signal.aborted, true);
    gate.resolve(ok(DEFAULT_TEXT.refine!));
    await run;

    assert.equal(kanban.workfileText(), undefined, "no workfile section is written after an abort");
    assert.equal(kanban.session()?.stage, "refine");
    assert.equal(kanban.session()?.mode, "pipeline");
    assert.equal(abortPipelineFor(kanban.title), false);
    assert.equal(messages(kanban), "");
  } finally {
    await kanban.cleanup();
  }
});

test("a commit whose pipelineToken no longer matches is rejected", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await harness({ script: { refine: () => gate.promise } });
  try {
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const run = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

    // A cross-process pause + unpause + open mints a new token for the same session.
    await mutateAsync(kanban.cwd, async (state) => {
      state.sessions[0]!.pipelineToken = "a-newer-run";
    });
    gate.resolve(ok(DEFAULT_TEXT.refine!));
    await run;

    assert.equal(kanban.workfileText(), undefined);
    assert.equal(kanban.session()?.stage, "refine");
    assert.equal(kanban.session()?.pipelineToken, "a-newer-run");
    assert.equal(messages(kanban), "", "a superseded run stops silently");
  } finally {
    await kanban.cleanup();
  }
});

test("renaming or removing the session mid-pipeline drops the commit and writes no workfile", async () => {
  for (const action of ["rename", "remove"] as const) {
    const gate = deferred<ChildResult>();
    const kanban = await harness({ script: { refine: () => gate.promise } });
    try {
      await startPipeline(kanban.ctx, kanban.title, kanban.deps);
      const run = pipelineRunFor(kanban.title);
      while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

      await mutateAsync(kanban.cwd, async (state) => {
        if (action === "rename") state.sessions[0]!.title = "Renamed session";
        else state.sessions = [];
      });
      gate.resolve(ok(DEFAULT_TEXT.refine!));
      await run;

      assert.equal(kanban.workfileText(), undefined, `${action}: no workfile section is resurrected`);
      assert.match(messages(kanban), /no longer on the board/);
      assert.equal(abortPipelineFor(kanban.title), false);
    } finally {
      await kanban.cleanup();
    }
  }
});

test("a paused session drops the pending commit and refuses a new run", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await harness({ script: { refine: () => gate.promise } });
  try {
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const run = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

    await mutateAsync(kanban.cwd, async (state) => {
      state.sessions[0]!.state = "blocked";
    });
    gate.resolve(ok(DEFAULT_TEXT.refine!));
    await run;
    assert.equal(kanban.workfileText(), undefined);
    assert.match(messages(kanban), /the session is paused/);

    // A blocked session never mints a token.
    kanban.notifications.length = 0;
    await kanban.run();
    assert.equal(kanban.calls.length, 1, "no further child runs for a paused session");
    assert.match(messages(kanban), /is paused\. Use \/kanban unpause first\./);
  } finally {
    await kanban.cleanup();
  }
});

test("a stage-boundary check stops the run before any child when the session is paused", async () => {
  const sandbox: { cwd?: string } = {};
  let paused = false;
  const kanban = await harness({
    ui: {
      // Simulates a cross-process pause landing between the token mint and the first stage.
      setWidget: () => {
        if (paused || !sandbox.cwd) return;
        paused = true;
        const path = join(sandbox.cwd, ".kanban", "state.json");
        const state = JSON.parse(readFileSync(path, "utf8"));
        state.sessions[0].state = "blocked";
        writeFileSync(path, JSON.stringify(state, null, 2));
      },
    },
  });
  sandbox.cwd = kanban.cwd;
  try {
    await kanban.run();
    assert.deepEqual(kanban.calls, [], "no child starts once the boundary check fails");
    assert.match(messages(kanban), /stopped: the session is paused/);
  } finally {
    await kanban.cleanup();
  }
});

test("open during a live run aborts and unregisters the old controller before minting", async () => {
  const first = deferred<ChildResult>();
  let tokenAtAbort: string | undefined;
  const kanban = await harness({
    script: {
      refine: (spec, index) => {
        if (index > 0) return ok(DEFAULT_TEXT.refine!);
        spec.signal.addEventListener("abort", () => {
          tokenAtAbort = sessionSync(kanban.cwd, kanban.title)?.pipelineToken;
        });
        return first.promise;
      },
    },
  });
  try {
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const firstRun = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const firstToken = kanban.session()!.pipelineToken;

    // /kanban open on a live run: abort + unregister happen BEFORE the new token is minted.
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const secondRun = pipelineRunFor(kanban.title);
    assert.equal(kanban.calls[0]!.spec.signal.aborted, true);
    assert.equal(tokenAtAbort, firstToken);
    const secondToken = kanban.session()!.pipelineToken;
    assert.notEqual(secondToken, firstToken);

    first.resolve(ok("## refine\nlate result\nVerdict: standard"));
    await Promise.all([firstRun, secondRun]);

    // Only the second run committed, and it re-ran the current stage.
    assert.equal(kanban.session()?.stage, "implement");
    assert.doesNotMatch((await kanban.sections()).refine!, /late result/);
    assert.equal(abortPipelineFor(kanban.title), false);
  } finally {
    await kanban.cleanup();
  }
});

test("a resumed run re-runs the current stage and overwrites its stale section", async () => {
  const kanban = await harness({
    seed: async (cwd, title) => {
      const session = (
        await mutateAsync(cwd, async (state) => {
          const created = await createSession(cwd, state, title);
          created.mode = "pipeline";
          created.stage = "grill";
          await writePlan(cwd, created.planPath, emptyPlan(created, "Refresh the board"));
          return created;
        })
      ).value;
      const base = workfileBase(session.planPath);
      await writeWorkfileSection(cwd, base, "refine", "Goal recorded earlier.");
      await writeWorkfileSection(cwd, base, "grill", "Stale grill body from an aborted run.");
    },
  });
  try {
    await kanban.run();
    assert.deepEqual(
      kanban.calls.map((call) => call.stage),
      ["grill", "compose"],
      "a resumed run starts at the persisted stage",
    );
    const written = await kanban.sections();
    assert.equal(written.refine, "Goal recorded earlier.", "earlier sections survive");
    assert.doesNotMatch(written.grill!, /Stale grill body/);
    assert.match(written.grill!, /Cap the sections\?/);
    assert.equal(kanban.session()?.stage, "implement");
    // The recorded refine section is an input to the re-run stage.
    assert.match(kanban.calls[0]!.spec.prompt, /Goal recorded earlier\./);
  } finally {
    await kanban.cleanup();
  }
});

test("a second pipeline for a different title is refused while one is live", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await harness({ script: { refine: () => gate.promise } });
  try {
    await mutateAsync(kanban.cwd, async (state) => {
      const other = await createSession(kanban.cwd, state, "Other session");
      other.mode = "pipeline";
      await writePlan(kanban.cwd, other.planPath, emptyPlan(other, "other brief"));
    });
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const run = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

    await startPipeline(kanban.ctx, "Other session", kanban.deps);
    assert.match(messages(kanban), /already running for “Pipeline session”/);
    assert.equal(sessionSync(kanban.cwd, "Other session")?.pipelineToken, undefined);
    assert.equal(pipelineRunFor("Other session"), undefined);

    gate.resolve(ok(DEFAULT_TEXT.refine!));
    await run;
  } finally {
    await kanban.cleanup();
  }
});

test("clearPipelineRegistry aborts the live run and empties the registry", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await harness({ script: { refine: () => gate.promise } });
  try {
    await startPipeline(kanban.ctx, kanban.title, kanban.deps);
    const run = pipelineRunFor(kanban.title);
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));

    clearPipelineRegistry();
    assert.equal(kanban.calls[0]!.spec.signal.aborted, true);
    assert.equal(abortPipelineFor(kanban.title), false);
    gate.resolve(ok(DEFAULT_TEXT.refine!));
    await run;
    assert.equal(kanban.workfileText(), undefined);
  } finally {
    await kanban.cleanup();
  }
});

test("startPipeline refuses a manual-mode session and a session past the child stages", async () => {
  const kanban = await harness({
    seed: async (cwd, title) => {
      await mutateAsync(cwd, async (state) => {
        const session = await createSession(cwd, state, title);
        session.mode = "manual";
        await writePlan(cwd, session.planPath, emptyPlan(session, "brief"));
      });
    },
  });
  try {
    await kanban.run();
    assert.deepEqual(kanban.calls, []);
    assert.match(messages(kanban), /runs in manual mode/);

    await mutateAsync(kanban.cwd, async (state) => {
      state.sessions[0]!.mode = "pipeline";
      state.sessions[0]!.stage = "implement";
    });
    kanban.notifications.length = 0;
    await kanban.run();
    assert.deepEqual(kanban.calls, []);
    assert.match(messages(kanban), /is at the implement stage; the pipeline has nothing left to run/);
  } finally {
    await kanban.cleanup();
  }
});

async function gateHarness(options: HarnessOptions = {}) {
  const kanban = await harness({
    ...options,
    seed: async (cwd, title) => {
      await mutateAsync(cwd, async (state) => {
        const session = await createSession(cwd, state, title);
        session.mode = "pipeline";
        session.stage = "critique";
        session.pipelineToken = "gate-token";
        await writePlan(cwd, session.planPath, emptyPlan(session, "Refresh the durable board"));
      });
    },
  });
  return kanban;
}

test("runCritiqueGate parses PASS, FAIL, and unparseable gate output", async () => {
  const cases: Array<{ text: string; kind: string; issues: string[] }> = [
    { text: "## critique\nGate: PASS\nMatches the spec.", kind: "pass", issues: [] },
    {
      text: "## critique\nGate: FAIL\n- src/store.ts: the token is never cleared",
      kind: "fail",
      issues: ["src/store.ts: the token is never cleared"],
    },
    {
      text: "the model rambled",
      kind: "fail",
      issues: ["critique produced no parseable issues"],
    },
  ];
  for (const item of cases) {
    const kanban = await gateHarness({ script: { critique: () => ok(item.text) } });
    try {
      const session = kanban.session()!;
      const updates: string[] = [];
      const outcome = await runCritiqueGate(kanban.ctx, session, {
        runChild: kanban.deps.runChild,
        config: kanban.deps.config,
        diff: "diff --git a/src/store.ts b/src/store.ts",
        signal: new AbortController().signal,
        onUpdate: (line) => updates.push(line),
      });
      assert.equal(outcome.kind, item.kind);
      assert.deepEqual(outcome.issues, item.issues);
      assert.ok(outcome.body.length > 0);
      assert.doesNotMatch(outcome.body, /^##\s+critique/m, "the body excludes the heading");
      const call = kanban.calls[0]!;
      assert.equal(call.stage, "critique");
      assert.match(call.spec.prompt, /diff --git a\/src\/store\.ts/);
      assert.ok(call.spec.onStatus, "the tool's onUpdate is wired as onStatus");
      // The gate registration is released when the gate returns.
      assert.equal(abortPipelineFor(kanban.title), false);
    } finally {
      await kanban.cleanup();
    }
  }
});

test("runCritiqueGate reports a child failure without a verdict", async () => {
  const kanban = await gateHarness({
    script: {
      critique: () => ({ text: "", aborted: false, errorKind: "model", error: "no auth in child" }),
    },
  });
  try {
    const outcome = await runCritiqueGate(kanban.ctx, kanban.session()!, {
      runChild: kanban.deps.runChild,
      config: kanban.deps.config,
      diff: "",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "child-failed");
    assert.equal(outcome.errorKind, "model");
    assert.equal(outcome.error, "no auth in child");
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.body, "");
  } finally {
    await kanban.cleanup();
  }
});

test("runCritiqueGate fails without running a child when models.critique cannot resolve", async () => {
  const kanban = await gateHarness({
    config: {
      models: {
        refine: null,
        research: null,
        grill: null,
        compose: null,
        implement: null,
        critique: "missing:model",
      },
    },
  });
  try {
    const outcome = await runCritiqueGate(kanban.ctx, kanban.session()!, {
      runChild: kanban.deps.runChild,
      config: kanban.deps.config,
      diff: "",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "child-failed");
    assert.equal(outcome.errorKind, "model");
    assert.match(outcome.error!, /configured critique model “missing:model” did not resolve/);
    assert.deepEqual(kanban.calls, []);
  } finally {
    await kanban.cleanup();
  }
});

test("runCritiqueGate registers its child so pause/remove can abort it, and honors a pre-aborted signal", async () => {
  const gate = deferred<ChildResult>();
  const kanban = await gateHarness({
    script: {
      critique: (spec) => {
        spec.signal.addEventListener("abort", () => gate.resolve({ text: "", aborted: true }));
        return gate.promise;
      },
    },
  });
  try {
    const tool = new AbortController();
    const running = runCritiqueGate(kanban.ctx, kanban.session()!, {
      runChild: kanban.deps.runChild,
      config: kanban.deps.config,
      diff: "",
      signal: tool.signal,
    });
    while (!kanban.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
    // The gate child is in the title-keyed registry for its duration.
    assert.equal(abortPipelineFor(kanban.title), true);
    assert.equal((await running).kind, "aborted");
    assert.equal(abortPipelineFor(kanban.title), false);

    // The tool's own signal is bridged too, and a pre-aborted signal never starts a child.
    const preAborted = new AbortController();
    preAborted.abort();
    const skipped = await runCritiqueGate(kanban.ctx, kanban.session()!, {
      runChild: kanban.deps.runChild,
      config: kanban.deps.config,
      diff: "",
      signal: preAborted.signal,
    });
    assert.equal(skipped.kind, "aborted");
    assert.equal(kanban.calls.length, 1);
  } finally {
    await kanban.cleanup();
  }
});
