import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createInProcessRunner,
  createSubprocessRunner,
  selectRunner,
  type ChildSpec,
} from "../src/runner.js";
import type { KanbanConfig } from "../src/config.js";
import { beginLoopProgress, loopProgress, endLoopProgress } from "../src/liveprogress.js";
import { beginUsage, beginChildUsage, getUsage, endUsage } from "../src/usage.js";

const model = { provider: "test-provider", id: "test-model" } as any;

function config(runner: KanbanConfig["runner"]): KanbanConfig {
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
    runner,
    piBin: "fake-pi",
    init: {},
    loop: {
      enabled: false,
      direction: "higher",
      maxIterations: 10,
      noImprovementStreak: 3,
      measureTimeoutMs: 300_000,
      hooks: false,
    },
  };
}

function childSpec(signal = new AbortController().signal): ChildSpec {
  return {
    cwd: "/project",
    prompt: "Read the project and report only the requested stage.",
    systemPrompt: "You are an isolated child.",
    model,
    tools: ["read", "grep"],
    signal,
  };
}

async function withRunnerDependencies(
  overrides: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const globals = globalThis as typeof globalThis & {
    __kanbanRunnerDependencies?: Record<string, unknown>;
  };
  const previous = globals.__kanbanRunnerDependencies;
  globals.__kanbanRunnerDependencies = overrides;
  try {
    await run();
  } finally {
    globals.__kanbanRunnerDependencies = previous;
  }
}

test("in-process runner builds the extension-free in-memory child exactly once", async () => {
  const observed: Record<string, unknown> = {};
  const session = {
    messages: [{ role: "assistant", stopReason: "stop" }],
    prompt: async (prompt: string) => {
      observed.prompt = prompt;
    },
    abort: async () => {
      observed.aborted = true;
    },
    dispose: () => {
      observed.disposed = true;
    },
    getLastAssistantText: () => "child answer",
  };
  class Loader {
    constructor(options: unknown) {
      observed.loaderOptions = options;
      observed.loader = this;
    }

    async reload() {
      observed.reloaded = true;
    }
  }

  await withRunnerDependencies(
    {
      getAgentDir: () => "/agent",
      DefaultResourceLoader: Loader,
      createAgentSession: async (options: unknown) => {
        observed.sessionOptions = options;
        return { session };
      },
      SessionManager: {
        inMemory: (cwd: string) => {
          observed.inMemoryCwd = cwd;
          return "memory-manager";
        },
      },
    },
    async () => {
      const result = await createInProcessRunner()(childSpec());
      assert.deepEqual(result, { text: "child answer", aborted: false });
    },
  );

  assert.deepEqual(observed.loaderOptions, {
    cwd: "/project",
    agentDir: "/agent",
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: "You are an isolated child.",
  });
  assert.equal(observed.reloaded, true);
  assert.deepEqual(observed.sessionOptions, {
    cwd: "/project",
    agentDir: "/agent",
    model,
    tools: ["read", "grep"],
    resourceLoader: observed.loader,
    sessionManager: "memory-manager",
  });
  assert.equal(observed.inMemoryCwd, "/project");
  assert.equal(observed.prompt, "Read the project and report only the requested stage.");
  assert.equal(observed.disposed, true);
});

test("in-process runner returns model failures from the final assistant message", async () => {
  const session = {
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider request exhausted retries",
      },
    ],
    prompt: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
    getLastAssistantText: () => "do not return this text",
  };
  class Loader {
    async reload() {}
  }

  await withRunnerDependencies(
    {
      getAgentDir: () => "/agent",
      DefaultResourceLoader: Loader,
      createAgentSession: async () => ({ session }),
      SessionManager: { inMemory: () => "memory" },
    },
    async () => {
      const result = await createInProcessRunner()(childSpec());
      assert.deepEqual(result, {
        text: "",
        aborted: false,
        errorKind: "model",
        error: "provider request exhausted retries",
      });
    },
  );
});

test("in-process runner short-circuits pre-aborted work and bridges a later abort", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  assert.deepEqual(await createInProcessRunner()(childSpec(preAborted.signal)), {
    text: "",
    aborted: true,
    errorKind: "aborted",
  });

  const controller = new AbortController();
  let resolvePrompt: (() => void) | undefined;
  let abortCalls = 0;
  const session = {
    messages: [{ role: "assistant", stopReason: "aborted" }],
    prompt: async () =>
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      }),
    abort: async () => {
      abortCalls += 1;
      resolvePrompt?.();
    },
    dispose: () => undefined,
    getLastAssistantText: () => undefined,
  };
  class Loader {
    async reload() {}
  }
  await withRunnerDependencies(
    {
      getAgentDir: () => "/agent",
      DefaultResourceLoader: Loader,
      createAgentSession: async () => ({ session }),
      SessionManager: { inMemory: () => "memory" },
    },
    async () => {
      const running = createInProcessRunner()(childSpec(controller.signal));
      await Promise.resolve();
      controller.abort();
      assert.deepEqual(await running, {
        text: "",
        aborted: true,
        errorKind: "aborted",
      });
    },
  );
  assert.equal(abortCalls, 1);
});

test("subprocess runner passes isolated print-mode arguments and sends the prompt on stdin", async () => {
  const observed: { binary?: string; args?: string[]; cwd?: string; prompt?: string } = {};
  const process = new EventEmitter() as EventEmitter & Record<string, any>;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = new EventEmitter();
  process.stdin.end = (prompt: string) => {
    observed.prompt = prompt;
    process.stdout.emit("data", "subprocess answer\n");
    process.emit("close", 0);
  };
  process.kill = () => true;

  await withRunnerDependencies(
    {
      spawn: (binary: string, args: string[], options: { cwd: string }) => {
        observed.binary = binary;
        observed.args = args;
        observed.cwd = options.cwd;
        return process;
      },
    },
    async () => {
      const result = await selectRunner(config("subprocess"))(childSpec());
      assert.deepEqual(result, { text: "subprocess answer", aborted: false });
    },
  );

  assert.equal(observed.binary, "fake-pi");
  assert.equal(observed.cwd, "/project");
  assert.deepEqual(observed.args, [
    "-p",
    "--mode", "json",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
    "--provider",
    "test-provider",
    "--model",
    "test-model",
    "--tools",
    "read,grep",
    "--system-prompt",
    "You are an isolated child.",
  ]);
  assert.equal(observed.prompt, "Read the project and report only the requested stage.");
});

test("subprocess failures use the pinned spawn, model, and other classifications", async () => {
  await withRunnerDependencies(
    {
      spawn: () => {
        throw new Error("spawn fake-pi ENOENT");
      },
    },
    async () => {
      assert.equal((await createSubprocessRunner()(childSpec())).errorKind, "spawn");
    },
  );

  const process = new EventEmitter() as EventEmitter & Record<string, any>;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = new EventEmitter();
  process.stdin.end = () => {
    process.stderr.emit("data", "could not resolve model for provider test-provider");
    process.emit("close", 1);
  };
  process.kill = () => true;
  await withRunnerDependencies(
    { spawn: () => process },
    async () => {
      const result = await createSubprocessRunner()(childSpec());
      assert.equal(result.errorKind, "model");
      assert.equal(result.text, "");
    },
  );
});

test("in-process events expose activity and public output, never thinking text, and unsubscribe", async () => {
  let listener: (event: any) => void = () => {};
  let unsubscribed = false;
  const controller = new AbortController();
  beginLoopProgress("/runner", "stream", controller.signal, { title: "stream", goal: "test", maxIterations: 1, direction: "higher" });
  const statuses: string[] = [];
  class Loader { async reload() {} }
  const session = {
    messages: [{ role: "assistant", stopReason: "stop" }],
    subscribe: (fn: typeof listener) => { listener = fn; return () => { unsubscribed = true; }; },
    prompt: async () => {
      listener({ type: "tool_execution_start", toolName: "read" });
      listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thought" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Updating the affected tests." } });
    },
    abort: async () => {}, dispose: () => {}, getLastAssistantText: () => "done",
  };
  try {
    await withRunnerDependencies({ DefaultResourceLoader: Loader, createAgentSession: async () => ({ session }), SessionManager: { inMemory: () => "memory" } }, async () => {
      await createInProcessRunner()({ ...childSpec(controller.signal), onStatus: (line) => statuses.push(line) });
    });
    assert(statuses.includes("using read"));
    assert(statuses.includes("model thinking"));
    assert.equal(loopProgress("/runner", "stream")!.output, "Updating the affected tests.");
    assert(!statuses.join("\n").includes("private thought"));
    assert.equal(unsubscribed, true);
  } finally { endLoopProgress(controller.signal); }
});

test("subprocess JSON stream handles fragmented UTF-8, activity and final model errors", async () => {
  for (const failure of [false, true]) {
    const process = new EventEmitter() as EventEmitter & Record<string, any>;
    process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.stdin = new EventEmitter(); process.kill = () => true;
    const statuses: string[] = [];
    process.stdin.end = () => {
      const events = [
        { type: "tool_execution_start", toolName: "grep" },
        { type: "message_end", message: { role: "assistant", stopReason: failure ? "error" : "stop", errorMessage: "model unavailable", content: [{ type: "text", text: "## compose\n实现目标" }] } },
      ];
      const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n"));
      for (let i = 0; i < bytes.length; i += 2) process.stdout.emit("data", bytes.subarray(i, i + 2));
      process.emit("close", 0);
    };
    await withRunnerDependencies({ spawn: () => process }, async () => {
      const result = await createSubprocessRunner()({ ...childSpec(), onStatus: (line) => statuses.push(line) });
      if (failure) assert.equal(result.errorKind, "model");
      else assert.equal(result.text, "## compose\n实现目标");
    });
    assert(statuses.includes("using grep"));
  }
});

test("in-process usage uses SDK context and cumulative session cost across compaction", async () => {
  const controller = new AbortController();
  const childModel = { ...model, contextWindow: 1000 };
  beginUsage("/runner-usage", "sdk", controller.signal);
  beginChildUsage(controller.signal, controller.signal, "compose", "compose", childModel);
  let listener: (event: any) => void = () => {};
  let tokens: number | null = 800;
  let total = 1200;
  let cost = 0.2;
  const session = {
    messages: [{ role: "assistant", stopReason: "stop" }],
    subscribe: (fn: typeof listener) => { listener = fn; return () => {}; },
    getContextUsage: () => ({ tokens, contextWindow: 1000 }),
    getSessionStats: () => ({ tokens: { total }, cost, assistantMessages: 1 }),
    prompt: async () => {
      listener({ type: "turn_start" });
      const usage = getUsage("/runner-usage", "sdk")!;
      assert.equal(usage.children[0]!.contextTokens, 800);
      assert.equal(usage.totalTokens, 1200);
      tokens = null;
      listener({ type: "compaction_end" });
      assert.equal(usage.children[0]!.contextStale, true);
      tokens = 200; total = 1500; cost = 0.25;
      listener({ type: "tool_execution_end", toolName: "read" });
    },
    abort: async () => {}, dispose: () => {}, getLastAssistantText: () => "plan",
  };
  class Loader { async reload() {} }
  try {
    await withRunnerDependencies({ DefaultResourceLoader: Loader, createAgentSession: async () => ({ session }), SessionManager: { inMemory: () => "memory" } }, async () => {
      await createInProcessRunner()({ ...childSpec(controller.signal), model: childModel });
    });
    const usage = getUsage("/runner-usage", "sdk")!;
    assert.equal(usage.children[0]!.contextTokens, 200);
    assert.equal(usage.children[0]!.contextStale, false);
    assert.equal(usage.totalCost, 0.25);
    assert.equal(usage.totalTokens, 1500);
  } finally { endUsage(controller.signal); }
});

test("subprocess usage counts message reports once when agent_end repeats the messages", async () => {
  const controller = new AbortController();
  const childModel = { ...model, contextWindow: 1000 };
  beginUsage("/runner-usage", "json", controller.signal);
  beginChildUsage(controller.signal, controller.signal, "research", "research", childModel);
  const process = new EventEmitter() as EventEmitter & Record<string, any>;
  process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.stdin = new EventEmitter(); process.kill = () => true;
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "facts" }], usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, cost: { total: 0.1 } } };
  process.stdin.end = () => {
    for (const event of [
      { type: "message_end", message },
      { type: "compaction_end", aborted: false, result: { usage: { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
      { type: "agent_end", messages: [message] },
    ]) process.stdout.emit("data", JSON.stringify(event) + "\n");
    process.emit("close", 0);
  };
  try {
    await withRunnerDependencies({ spawn: () => process }, async () => {
      await createSubprocessRunner()({ ...childSpec(controller.signal), model: childModel });
    });
    const usage = getUsage("/runner-usage", "json")!;
    assert(Math.abs(usage.totalCost - 0.12) < 1e-10);
    assert.equal(usage.totalTokens, 216);
    assert.equal(usage.children[0]!.contextTokens, 180);
    assert.equal(usage.children[0]!.contextStale, true);
  } finally { endUsage(controller.signal); }
});
