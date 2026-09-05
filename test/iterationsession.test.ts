import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIterationSessionFactory, type IterationSessionSpec } from "../src/iterationsession.js";
import { beginUsage, endUsage, getUsage } from "../src/usage.js";

test("persistent SDK sessions receive custom tools and repeated event turns without disposing; resume usage counts deltas", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-session-sdk-"));
  const root = new AbortController(), child = new AbortController();
  let listener: (event: any) => void = () => {}, unsubscribe = 0, disposed = 0, aborted = 0;
  let tokens = 100, cost = 1;
  const created: any[] = [], sends: any[] = [], opens: any[] = [], loaders: any[] = [], texts: string[] = [];
  const fake = {
    messages: [{ role: "assistant", stopReason: "stop" }],
    getContextUsage: () => ({ tokens: 200, contextWindow: 1000 }),
    getSessionStats: () => ({ tokens: { total: tokens }, cost }),
    getLastAssistantText: () => "Waiting for registered work",
    subscribe: (fn: typeof listener) => { listener = fn; return () => { unsubscribe++; }; },
    sendCustomMessage: async (message: any, options: any) => {
      sends.push({ message, options }); tokens += 10; cost += 0.25;
      listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "public text" } });
      listener({ type: "message_end" }); listener({ type: "agent_end" });
    },
    abort: async () => { aborted++; }, dispose: () => { disposed++; },
  };
  const factory = createIterationSessionFactory({
    getAgentDir: () => "/test-agent",
    DefaultResourceLoader: class { constructor(options: any) { loaders.push(options); } async reload() {} },
    SessionManager: {
      open: (...args: any[]) => { opens.push(args); return { getSessionFile: () => args[0] }; },
      create: () => { throw new Error("A saved session must be opened"); },
    },
    createAgentSession: async (options: any) => { created.push(options); return { session: fake }; },
  } as any);
  beginUsage(cwd, "task", root.signal);
  try {
    const session = await factory({
      cwd, sessionDir: cwd, sessionFile: join(cwd, "saved.jsonl"), label: "coordinator",
      model: { provider: "test", id: "model", contextWindow: 1000 }, tools: ["read"],
      customTools: [{ name: "iteration_job" }], systemPrompt: "own the iteration", signal: child.signal, runSignal: root.signal,
      output: (text) => texts.push(text), activity() {},
    } as IterationSessionSpec);
    await session.send("first event"); await session.send("job finished");
    assert.equal(created.length, 1);
    assert.equal(disposed, 0);
    assert.deepEqual(created[0].tools, ["read", "iteration_job"]);
    assert.equal(loaders[0].noExtensions, true);
    assert.equal(loaders[0].noContextFiles, true);
    assert.deepEqual(opens, [[join(cwd, "saved.jsonl"), cwd, cwd]]);
    assert.deepEqual(sends[1].options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(sends[1].message.content, "job finished");
    assert.deepEqual(texts, ["public text", "public text"]);
    assert.equal(getUsage(cwd, "task")?.totalTokens, 20);
    assert.equal(getUsage(cwd, "task")?.totalCost, 0.5);
    child.abort();
    await assert.rejects(session.send("late event"), /suspended/);
    await session.close();
    assert.equal(unsubscribe, 1);
    assert.equal(disposed, 1);
    assert.ok(aborted >= 1);
  } finally { endUsage(root.signal); await rm(cwd, { recursive: true, force: true }); }
});
