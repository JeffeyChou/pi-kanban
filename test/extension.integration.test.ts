import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kanban from "../src/index.js";
import { readPlan } from "../src/artifacts.js";
import {
  STAGES,
  createSession,
  load,
  mutate,
  mutateAsync,
  selectedSession,
} from "../src/store.js";
import { pickSession, renderSelected } from "../src/ui.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-extension-test-"));
}

function extensionHarness() {
  const commands = new Map<string, any>();
  const listeners = new Map<string, any>();
  const followUps: string[] = [];
  const names: string[] = [];
  let tool: any;
  const pi = {
    on: (name: string, listener: unknown) => listeners.set(name, listener),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (definition: unknown) => (tool = definition),
    setSessionName: (name: string) => names.push(name),
    sendUserMessage: (message: string) => followUps.push(message),
  };
  kanban(pi as any);
  return { commands, followUps, listeners, names, tool };
}

function context(cwd: string, overrides: Record<string, unknown> = {}) {
  const notifications: string[] = [];
  return {
    cwd,
    hasUI: false,
    model: { provider: "test", id: "model", contextWindow: 100 },
    modelRegistry: {
      complete: async () => ({
        content: [{ type: "text", text: "Durable board refresh" }],
      }),
    },
    getContextUsage: () => ({ tokens: 40, contextWindow: 100 }),
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => join(cwd, "missing-session.jsonl"),
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: () => {},
    },
    notifications,
    ...overrides,
  };
}

test("create uses a generated title and checkpoint stores only compact durable content", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    await harness.commands
      .get("kanban")
      .handler("create refresh persistence and UI", ctx);

    let state = await load(cwd);
    const session = selectedSession(state)!;
    assert.equal(session.title, "Durable board refresh");
    assert.equal("id" in session, false);
    assert.match(harness.followUps[0]!, /\.\/init\.sh/);
    assert.match(harness.followUps[0]!, /Never run git commit automatically/);
    const initialPlan = await readPlan(cwd, session.planPath);
    assert.equal(initialPlan?.prompt, "refresh persistence and UI");
    assert.deepEqual(initialPlan?.work, { done: [], current: [], next: [] });

    const result = await harness.tool.execute(
      "tool",
      {
        action: "checkpoint",
        inScope: ["compact persistence"],
        outOfScope: ["launching subagents"],
        agents: [
          {
            name: "Reviewer",
            role: "API review",
            status: "working",
          },
        ],
        work: { current: ["Implement v3 state"] },
        handoff: "State and artifact changes are in progress.",
      },
      undefined,
      undefined,
      ctx,
    );
    state = await load(cwd);
    const updated = selectedSession(state)!;
    assert.equal(updated.stage, "refine");
    assert.deepEqual(updated.agents.map((agent) => agent.role), [
      "Coordinator",
      "API review",
    ]);
    const plan = await readPlan(cwd, updated.planPath);
    assert.deepEqual(plan?.inScope, ["compact persistence"]);
    assert.deepEqual(plan?.outOfScope, ["launching subagents"]);
    assert.deepEqual(plan?.work.current, ["Implement v3 state"]);
    assert.equal(JSON.stringify(result).includes("sessionId"), false);
    assert.equal(JSON.stringify(result).includes("todoId"), false);

    const lines = renderSelected(state, {
      contextWindow: 100,
      tokens: 40,
      primaryWorking: true,
    });
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /Durable board refresh/);
    assert.match(lines[1]!, /Stage 1\/6 · refine/);
    assert.match(lines[2]!, /60 \/ 100 · 60%/);
    assert.match(lines[3]!, /Agents working 2/);
    assert.doesNotMatch(lines.join("\n"), /unavailable|source files|progress:/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only explicit stage completion advances and final completion archives the session", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    await harness.commands.get("kanban").handler("create finalize the board", ctx);
    const first = selectedSession(await load(cwd))!;
    for (const expected of STAGES.slice(1)) {
      await harness.tool.execute(
        "tool",
        { action: "stage_complete" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(selectedSession(await load(cwd))!.stage, expected);
    }
    const result = await harness.tool.execute(
      "tool",
      { action: "stage_complete", handoff: "Final review passed." },
      undefined,
      undefined,
      ctx,
    );
    const state = await load(cwd);
    assert.equal(state.sessions.length, 0);
    const plan = await readPlan(cwd, first.planPath);
    assert.equal(plan?.status, "complete");
    const handoff = await readFile(join(cwd, ".kanban", "handoff.md"), "utf8");
    assert.match(handoff, new RegExp(first.planPath));
    assert.match(result.content[0]!.text, /Suggested commit/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("picker uses titles and the widget ignores other sessions", async () => {
  const cwd = await sandbox();
  try {
    await mutateAsync(cwd, async (state) => {
      const first = await createSession(cwd, state, "First session");
      await createSession(cwd, state, "Second session");
      state.selectedSessionTitle = first.title;
    });
    const state = await load(cwd);
    let component: any;
    let picked: string | null = null;
    const pickerContext = {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          component = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            (value: string | null) => (picked = value),
          );
          component.handleInput("j");
          component.handleInput("\r");
          return picked;
        },
      },
    };
    assert.equal(await pickSession(pickerContext as any, state.sessions), "Second session");
    assert.match(component.render(100).join("\n"), /First session/);
    assert.match(component.render(100).join("\n"), /Second session/);
    const lines = renderSelected(state);
    assert.match(lines[0]!, /First session/);
    assert.doesNotMatch(lines.join("\n"), /Second session/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume seeds a replacement conversation from the single handoff and selected plan", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    await harness.commands.get("kanban").handler("create recover work", ctx);
    const session = selectedSession(await load(cwd))!;
    let setupText = "";
    let kickoff = "";
    const resumeContext = context(cwd, {
      hasUI: true,
      ui: {
        setWidget() {},
        notify() {},
        custom: async () => session.title,
      },
      newSession: async (options: any) => {
        await options.setup({
          appendMessage: (message: any) => (setupText = message.content[0].text),
        });
        await options.withSession({
          sendUserMessage: async (message: string) => (kickoff = message),
        });
      },
    });
    await harness.commands.get("kanban").handler("resume", resumeContext);
    assert.match(setupText, /Kanban handoff/);
    assert.match(setupText, /Plan:/);
    assert.match(kickoff, /run \.\/init\.sh/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("title creation falls back locally when no model is selected", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd, { model: undefined });
    await harness.commands
      .get("kanban")
      .handler("create repair durable persistence immediately", ctx);
    assert.equal(
      selectedSession(await load(cwd))?.title,
      "repair durable persistence immediately",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
