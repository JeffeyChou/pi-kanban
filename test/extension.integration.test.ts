import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kanban from "../src/index.js";
import { emptyPlan, readPlan, writePlan } from "../src/artifacts.js";
import {
  STAGES,
  createSession,
  load,
  mutate,
  mutateAsync,
  selectedSession,
} from "../src/store.js";
import { renderSelected, showDashboard } from "../src/ui.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-extension-test-"));
}

function extensionHarness() {
  const commands = new Map<string, any>();
  const listeners = new Map<string, any>();
  const followUps: string[] = [];
  let tool: any;
  const pi = {
    on: (name: string, listener: unknown) => listeners.set(name, listener),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (definition: unknown) => (tool = definition),
    sendUserMessage: (message: string) => followUps.push(message),
  };
  kanban(pi as any);
  return { commands, followUps, listeners, tool };
}

function context(cwd: string, overrides: Record<string, any> = {}) {
  const notifications: string[] = [];
  const setupMessages: string[] = [];
  const freshMessages: string[] = [];
  const { ui: uiOverrides, ...rest } = overrides;
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
      getSessionFile: () => join(cwd, "current-pi-chat.jsonl"),
    },
    newSession: async (options: any) => {
      await options.setup({
        appendMessage: (message: any) => setupMessages.push(message.content[0].text),
      });
      await options.withSession({
        sendUserMessage: async (message: string) => freshMessages.push(message),
      });
      return { cancelled: false };
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: () => {},
      ...uiOverrides,
    },
    notifications,
    setupMessages,
    freshMessages,
    ...rest,
  };
}

async function addSession(cwd: string, title: string) {
  return mutateAsync(cwd, async (state) => {
    const session = await createSession(cwd, state, title);
    await writePlan(cwd, session.planPath, emptyPlan(session, `${title} brief`));
    return session;
  });
}

test("create uses a generated title, starts a clean conversation, and stores no Pi path", async () => {
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
    assert.equal("piConversationPath" in session, false);
    assert.match(ctx.setupMessages[0]!, /independent from Pi conversation files/i);
    assert.match(ctx.setupMessages[0]!, /Current session plan \(authoritative\)/);
    assert.match(ctx.freshMessages[0]!, /\.\/init\.sh/);
    assert.match(ctx.freshMessages[0]!, /Never run git commit automatically/);
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
        work: { current: ["Implement v4 state"] },
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
    assert.deepEqual(plan?.work.current, ["Implement v4 state"]);
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
    assert.match(lines[2]!, /Current Pi context/);
    assert.match(lines[2]!, /60 \/ 100 · 60% remaining/);
    assert.match(lines[3]!, /Agents working 2/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session startup refreshes a v4 board without persisting a Pi conversation path", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    await addSession(cwd, "Startup session");
    const before = await readFile(join(cwd, ".kanban", "state.json"), "utf8");
    await harness.listeners.get("session_start")({}, context(cwd));
    const after = await readFile(join(cwd, ".kanban", "state.json"), "utf8");
    assert.equal(after, before);
    assert.equal(after.includes("piConversationPath"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only explicit stage completion advances, and other sessions preserve the global handoff", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    const first = (await addSession(cwd, "First session")).value;
    await addSession(cwd, "Second session");
    await mutate(cwd, (state) => {
      const session = state.sessions.find((item) => item.title === first.title)!;
      state.selectedSessionTitle = session.title;
      session.stage = "critique";
    });
    await harness.tool.execute(
      "tool",
      { action: "checkpoint", handoff: "Keep this global continuity note." },
      undefined,
      undefined,
      ctx,
    );
    const result = await harness.tool.execute(
      "tool",
      { action: "stage_complete" },
      undefined,
      undefined,
      ctx,
    );
    const state = await load(cwd);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0]!.title, "Second session");
    const plan = await readPlan(cwd, first.planPath);
    assert.equal(plan?.status, "complete");
    const handoff = await readFile(join(cwd, ".kanban", "handoff.md"), "utf8");
    assert.match(handoff, /Keep this global continuity note/);
    assert.doesNotMatch(handoff, /Latest completed plan/);
    assert.match(result.content[0]!.text, /Suggested commit/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stage completion still advances through the fixed workflow before final archival", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const ctx = context(cwd);
    const session = (await addSession(cwd, "Stage workflow")).value;
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
    await harness.tool.execute(
      "tool",
      { action: "stage_complete" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal((await load(cwd)).sessions.length, 0);
    assert.equal((await readPlan(cwd, session.planPath))?.status, "complete");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dashboard renders session status and routes Tab management actions without overlay mode", async () => {
  const cwd = await sandbox();
  try {
    await addSession(cwd, "First session");
    await addSession(cwd, "Second session");
    const state = await load(cwd);
    let component: any;
    let options: any;
    let action: unknown;
    const dashboardContext = {
      hasUI: true,
      ui: {
        custom: async (factory: any, customOptions: any) => {
          options = customOptions;
          component = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: () => false },
            (value: unknown) => (action = value),
          );
          component.handleInput("j");
          component.handleInput("\t");
          component.handleInput("r");
          return action;
        },
      },
    };
    assert.deepEqual(await showDashboard(dashboardContext as any, state), {
      kind: "rename",
      title: "Second session",
    });
    const rendered = component.render(100).join("\n");
    assert.match(rendered, /┌ Kanban manage/);
    assert.match(rendered, /First session/);
    assert.match(rendered, /Second session/);
    assert.match(rendered, /Status: Stage 1\/6/);
    assert.match(rendered, /r rename · x remove/);
    assert.equal(options, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dashboard Enter selects and opens a clean Pi conversation from the selected plan and global handoff", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    await addSession(cwd, "Do not open");
    const session = (await addSession(cwd, "Recover work")).value;
    let setupText = "";
    let kickoff = "";
    const resumeContext = context(cwd, {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          const component = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: () => false },
            () => {},
          );
          component.handleInput("\r");
          return { kind: "open", title: session.title };
        },
      },
      newSession: async (options: any) => {
        await options.setup({
          appendMessage: (message: any) => (setupText = message.content[0].text),
        });
        await options.withSession({
          sendUserMessage: async (message: string) => (kickoff = message),
        });
        return { cancelled: false };
      },
    });
    await harness.commands.get("kanban").handler("", resumeContext);
    assert.match(setupText, /Global handoff/);
    assert.match(setupText, /may describe a previously selected session/);
    assert.match(setupText, /Current session plan \(authoritative\)/);
    assert.match(kickoff, /run \.\/init\.sh/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dashboard management and current-session commands rename, pause, unpause, and delete", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const first = (await addSession(cwd, "First session")).value;
    await addSession(cwd, "Second session");
    const handoff = "# Kanban handoff\n\n## Supplement\n\nKeep this unchanged.\n";
    await (await import("../src/artifacts.js")).writeHandoff(cwd, handoff);
    const managementContext = context(cwd, {
      hasUI: true,
      ui: {
        input: async () => "Renamed session",
        confirm: async () => true,
      },
    });
    await mutate(cwd, (state) => {
      state.selectedSessionTitle = first.title;
    });
    let dashboardActions: Array<unknown> = [
      { kind: "rename", title: first.title },
      null,
    ];
    managementContext.ui.custom = async () => dashboardActions.shift() ?? null;
    await harness.commands.get("kanban").handler("", managementContext);
    await harness.commands.get("kanban").handler("pause", managementContext);
    let state = await load(cwd);
    const renamed = state.sessions.find((session) => session.title === "Renamed session")!;
    assert.equal(renamed.state, "blocked");
    assert.equal((await readPlan(cwd, renamed.planPath))?.status, "blocked");
    await harness.commands.get("kanban").handler("unpause", managementContext);
    state = await load(cwd);
    assert.equal(state.sessions.find((session) => session.title === renamed.title)?.state, "active");
    dashboardActions = [{ kind: "remove", title: renamed.title }, null];
    await harness.commands.get("kanban").handler("", managementContext);
    state = await load(cwd);
    assert.equal(state.sessions.some((session) => session.title === renamed.title), false);
    await assert.rejects(access(join(cwd, ".kanban", renamed.planPath)));
    assert.equal(state.sessions.length, 1);
    await harness.commands.get("kanban").handler("remove", managementContext);
    state = await load(cwd);
    assert.equal(state.sessions.length, 0);
    assert.equal(await readFile(join(cwd, ".kanban", "handoff.md"), "utf8"), handoff);
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
