import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kanban from "../src/index.js";
import { persistSessionArtifacts } from "../src/artifacts.js";
import {
  createSession,
  initialize,
  load,
  mutate,
  selectedSession,
} from "../src/store.js";
import { pickSession, renderSelected } from "../src/ui.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-extension-test-"));
}

function extensionHarness() {
  const commands = new Map<string, any>();
  let tool: any;
  const followUps: string[] = [];
  const names: string[] = [];
  const listeners = new Map<string, unknown>();
  const pi = {
    getActiveTools: () => ["bg_run", "subagent", "ask_user_question"],
    on: (name: string, listener: unknown) => listeners.set(name, listener),
    registerCommand: (name: string, command: unknown) =>
      commands.set(name, command),
    registerTool: (definition: unknown) => {
      tool = definition;
    },
    setSessionName: (name: string) => names.push(name),
    sendUserMessage: (message: string) => followUps.push(message),
  };
  kanban(pi as any);
  return { commands, followUps, names, tool };
}

function context(cwd: string, overrides: Record<string, unknown> = {}) {
  const notifications: string[] = [];
  return {
    cwd,
    hasUI: false,
    model: { provider: "test", id: "model" },
    getContextUsage: () => ({ tokens: 40 }),
    sessionManager: {
      getSessionId: () => "host-conversation",
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

test("create, explicit stage completion, and live UI use durable selected-session artifacts", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    await harness.commands
      .get("kanban")
      .handler("create Durable board -- write src/main.ts", ctx);

    let state = await load(cwd);
    const session = selectedSession(state)!;
    assert.equal(session.title, "Durable board");
    assert.equal(session.stage, "refine");
    assert.match(harness.followUps[0]!, /Run the refine stage now/);
    assert.match(
      await readFile(join(cwd, session.planArtifact), "utf8"),
      /Durable board/,
    );
    assert.match(
      await readFile(join(cwd, session.handoffArtifact), "utf8"),
      /Starting refine/,
    );

    // A normal progress update never advances the workflow.
    const taskId = session.tasks[0]!.id;
    await harness.tool.execute(
      "tool",
      { action: "todo", sessionId: session.id, taskId, text: "write code" },
      undefined,
      undefined,
      ctx,
    );
    state = await load(cwd);
    assert.equal(selectedSession(state)!.stage, "refine");

    // The explicit Kanban action is the only transition that starts research.
    await harness.tool.execute(
      "tool",
      { action: "stage_complete", sessionId: session.id },
      undefined,
      undefined,
      ctx,
    );
    state = await load(cwd);
    assert.equal(selectedSession(state)!.stage, "research");
    assert.match(harness.followUps.at(-1)!, /Run the research stage now/);

    await harness.tool.execute(
      "tool",
      {
        action: "todo_state",
        sessionId: session.id,
        taskId,
        todoId: selectedSession(state)!.tasks[0]!.todos[0]!.id,
        state: "completed",
      },
      undefined,
      undefined,
      ctx,
    );
    const lines = await renderSelected(cwd, await load(cwd));
    assert.equal(lines[0]!.startsWith("Kanban · Durable board"), true);
    assert.match(lines[3]!, /progress: 1\/1/);
    assert.match(lines[2]!, /context: unavailable/);
    await harness.commands
      .get("kanban")
      .handler("configure-context test/model 100", ctx);
    const configuredLines = await renderSelected(cwd, await load(cwd));
    assert.match(configuredLines[2]!, /60\/100/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("picker uses titles and keyboard selection, while the widget renders only that session", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd, {});
    await mutate(cwd, (state) => {
      const first = createSession(state, "First session");
      createSession(state, "Second session");
      state.selectedSessionId = first.id;
      return state;
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
            {
              fg: (_: string, text: string) => text,
              bold: (text: string) => text,
            },
            {},
            (value: string | null) => {
              picked = value;
            },
          );
          component.handleInput("j");
          component.handleInput("\r");
          return picked;
        },
      },
    };
    assert.equal(
      await pickSession(pickerContext as any, state.sessions),
      state.sessions[1]!.id,
    );
    const pickerLines = component.render(100).join("\n");
    assert.match(pickerLines, /First session/);
    assert.match(pickerLines, /Second session/);
    assert.doesNotMatch(pickerLines, new RegExp(state.sessions[0]!.id));

    const lines = await renderSelected(cwd, state);
    assert.match(lines[0]!, /First session/);
    assert.doesNotMatch(lines.join("\n"), /Second session/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume creates a new Pi conversation with the persisted handoff when prior conversation is absent", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd, {});
    let sessionId = "";
    await mutate(cwd, (state) => {
      const session = createSession(state, "Resume me");
      session.currentActivity = "Interrupted during research";
      session.sourceFiles.push("src/resume.ts");
      sessionId = session.id;
      return state;
    });
    const session = selectedSession(await load(cwd))!;
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "resume.ts"), "export {};\n");
    await persistSessionArtifacts(cwd, session);

    const harness = extensionHarness();
    let setupText = "";
    let freshMessage = "";
    const ctx = context(cwd, {
      hasUI: true,
      ui: {
        setWidget() {},
        notify() {},
        custom: async (_factory: unknown) => sessionId,
      },
      newSession: async (options: any) => {
        await options.setup({
          appendMessage: (message: any) =>
            (setupText = message.content[0].text),
        });
        await options.withSession({
          sendUserMessage: async (message: string) => (freshMessage = message),
        });
      },
    });
    await harness.commands.get("kanban").handler("resume", ctx);
    assert.match(setupText, /Interrupted during research/);
    assert.match(setupText, /src\/resume.ts/);
    assert.match(freshMessage, /Run the refine stage now/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume switches to an available prior Pi conversation", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd, {});
    const priorConversation = join(cwd, "prior.jsonl");
    await writeFile(priorConversation, "{}\n");
    let sessionId = "";
    await mutate(cwd, (state) => {
      const session = createSession(state, "Return here");
      session.piConversationPath = priorConversation;
      sessionId = session.id;
      return state;
    });
    const harness = extensionHarness();
    let switchedTo = "";
    let message = "";
    const ctx = context(cwd, {
      hasUI: true,
      ui: { setWidget() {}, notify() {}, custom: async () => sessionId },
      switchSession: async (path: string, options: any) => {
        switchedTo = path;
        await options.withSession({
          sendUserMessage: async (text: string) => (message = text),
        });
      },
      newSession: async () =>
        assert.fail("available conversations must be switched, not recreated"),
    });
    await harness.commands.get("kanban").handler("resume", ctx);
    assert.equal(switchedTo, priorConversation);
    assert.match(message, /Run the refine stage now/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
