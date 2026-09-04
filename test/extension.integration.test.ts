import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kanban from "../src/index.js";
import { emptyPlan, readPlan, writePlan, type PlanSnapshot } from "../src/artifacts.js";
import {
  STAGES,
  createSession,
  load,
  mutate,
  mutateAsync,
  selectedSession,
} from "../src/store.js";
import { renderSelected, showDashboard } from "../src/ui.js";
import { loadConfig } from "../src/config.js";
import {
  clearPipelineRegistry,
  hasLiveRun,
  runCritiqueGate,
} from "../src/orchestrator.js";

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

async function addSession(
  cwd: string,
  title: string,
  mode?: "pipeline" | "manual",
) {
  return mutateAsync(cwd, async (state) => {
    const session = await createSession(cwd, state, title);
    if (mode) session.mode = mode;
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
    // W4: the implement kickoff (configured init-start + detected external tools) is
    // delivered only when implementation begins, via /kanban open at implement — not in
    // the create seed. The create seed no longer carries a ./init.sh kickoff message.
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

test("progress command opens the live dashboard and displays the selected goal", async () => {
  const cwd = await sandbox();
  try {
    await addSession(cwd, "Progress session");
    const harness = extensionHarness();
    let output = "";
    let disposed = false;
    const ctx = context(cwd, { hasUI: true, ui: {
      custom: async (factory: any, options: any) => {
        assert.equal(options?.overlay, undefined);
        let ready: () => void = () => {};
        const refreshed = new Promise<void>((resolve) => { ready = resolve; });
        const component = factory({ requestRender: () => ready() }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: () => false }, () => { disposed = true; });
        await refreshed;
        output = component.render(120).join("\n");
        component.handleInput("\u001b");
        component.dispose?.();
      },
    } });
    await harness.commands.get("kanban").handler("progress", ctx);
    assert.match(output, /Goal: Progress session brief/);
    assert.match(output, /Agent-owned implementation/);
    assert.equal(disposed, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("plan command previews the compose section, scrolls, and never changes the conversation", async () => {
  const cwd = await sandbox();
  try {
    const created = await addSession(cwd, "Plan preview");
    const { writeWorkfileSection, workfileBase } = await import("../src/workfile.js");
    await writeWorkfileSection(cwd, workfileBase(created.value.planPath), "compose", "### Summary\n" + Array.from({ length: 40 }, (_, i) => `Plan step ${i}`).join("\n"));
    const harness = extensionHarness();
    const ctx = context(cwd, { hasUI: true, ui: { custom: async (factory: any) => {
      let closed = false;
      const component = factory({ requestRender: () => {}, terminal: { rows: 24 } }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: () => false }, () => { closed = true; });
      assert.match(component.render(120).join("\n"), /### Summary/);
      component.handleInput("\u001b[6~");
      const second = component.render(120).join("\n");
      assert.doesNotMatch(second, /### Summary/);
      assert.match(second, /Plan step 20/);
      component.handleInput("\u001b");
      assert.equal(closed, true);
    } } });
    await harness.commands.get("kanban").handler("plan", ctx);
    assert.equal(ctx.freshMessages.length, 0);
    assert.equal(ctx.setupMessages.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
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

test(
  "only explicit stage completion advances, and other sessions preserve the global handoff",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const first = (await addSession(cwd, "First session", "manual")).value;
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
      // W4: manual-mode critique requires critiqueSummary; headless (hasUI false) records
      // it durably and completes.
      const result = await harness.tool.execute(
        "tool",
        {
          action: "stage_complete",
          critiqueSummary: "Reviewed plans and handoff; no remaining issues.",
        },
        undefined,
        undefined,
        ctx,
      );
      const state = await load(cwd);
      assert.equal(state.sessions.length, 1);
      assert.equal(state.sessions[0]!.title, "Second session");
      const plan = await readPlan(cwd, first.planPath);
      assert.equal(plan?.status, "complete");
      assert.equal(plan?.completion?.critique, "manual");
      const handoff = await readFile(join(cwd, ".kanban", "handoff.md"), "utf8");
      assert.match(handoff, /Keep this global continuity note/);
      assert.doesNotMatch(handoff, /Latest completed plan/);
      assert.match(result.content[0]!.text, /Suggested commit/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "manual-mode stage completion advances through the fixed workflow before final archival",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Stage workflow", "manual")).value;
      for (const expected of STAGES.slice(1)) {
        const result = await harness.tool.execute(
          "tool",
          { action: "stage_complete" },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(selectedSession(await load(cwd))!.stage, expected);
        // W4: every manual stage_complete result carries the NEXT stage's
        // single-responsibility prompt (no followUp kickoff message).
        assert.ok(result.content[0]!.text.length > 40, "transition prompt in result");
      }
      // W4: final critique in manual mode requires critiqueSummary (headless completes).
      await harness.tool.execute(
        "tool",
        {
          action: "stage_complete",
          critiqueSummary: "Verified the full workflow end to end; no issues.",
        },
        undefined,
        undefined,
        ctx,
      );
      assert.equal((await load(cwd)).sessions.length, 0);
      assert.equal((await readPlan(cwd, session.planPath))?.status, "complete");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

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

test(
  "/kanban open at implement opens a clean Pi conversation seeded from plan, handoff, and implement kickoff",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      await addSession(cwd, "Do not open");
      const session = (await addSession(cwd, "Recover work", "manual")).value;
      await writeFile(join(cwd, "init.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "implement";
      });
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
      // W4: the implement kickoff carries the configured init-start command ("auto"
      // resolves to ./init.sh here) and the detected external-tools line.
      assert.match(kickoff, /run `?\.\/init\.sh`?/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

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

// ---------------------------------------------------------------------------
// W4-dependent expectations (orchestrated pipeline, plan D3/D10). These match
// the approved plan; they cannot pass until W4 merges the tool/command changes,
// so they stay skipped (test.skip) to keep the suite green. W4 unskips them.
// ---------------------------------------------------------------------------

test(
  "manual-mode stage_complete is accepted with the next-stage prompt in the result and no sendUserMessage",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Manual flow", "manual")).value;
      const result = await harness.tool.execute(
        "tool",
        { action: "stage_complete" },
        undefined,
        undefined,
        ctx,
      );
      const state = await load(cwd);
      assert.equal(selectedSession(state)!.stage, "research");
      assert.equal(state.sessions.length, 1);
      // Transition text rides in the tool result (next stage's single-responsibility
      // prompt) and no followUp kickoff is injected.
      assert.match(result.content[0]!.text, /research/i);
      assert.ok(result.content[0]!.text.length > 40);
      assert.equal(harness.followUps.length, 0);
      assert.equal(session.title, "Manual flow");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "stage_complete(implement) makes only the single implement→critique transition",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Implement work", "manual")).value;
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "implement";
      });
      const result = await harness.tool.execute(
        "tool",
        { action: "stage_complete" },
        undefined,
        undefined,
        ctx,
      );
      const state = await load(cwd);
      // Exactly one transition: implement → critique, never straight to completion.
      assert.equal(state.sessions.length, 1);
      assert.equal(selectedSession(state)!.stage, "critique");
      assert.match(result.content[0]!.text, /Critique gate armed/i);
      assert.equal(harness.followUps.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "stage_complete is rejected during pipeline-owned child stages and when blocked",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Pipeline session", "pipeline")).value;
      for (const stage of ["refine", "research", "grill", "compose"]) {
        await mutate(cwd, (state) => {
          const record = state.sessions.find((item) => item.title === session.title)!;
          record.stage = stage as any;
        });
        const before = selectedSession(await load(cwd))!.stage;
        let rejected = false;
        try {
          const result = await harness.tool.execute(
            "tool",
            { action: "stage_complete" },
            undefined,
            undefined,
            ctx,
          );
          rejected = /pipeline|resume it/i.test(
            result.content?.[0]?.text ?? "",
          );
        } catch (error) {
          rejected = /pipeline|resume it/i.test(String(error));
        }
        assert.equal(rejected, true, `stage_complete rejected at ${stage}`);
        assert.equal(selectedSession(await load(cwd))!.stage, before);
      }
      // The blocked-state guard: a paused session refuses agent-owned mutations.
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.state = "blocked";
      });
      let blockedRejected = false;
      try {
        const result = await harness.tool.execute(
          "tool",
          { action: "checkpoint", work: { current: ["nope"] } },
          undefined,
          undefined,
          ctx,
        );
        blockedRejected = /paused|blocked/i.test(result.content?.[0]?.text ?? "");
      } catch (error) {
        blockedRejected = /paused|blocked/i.test(String(error));
      }
      assert.equal(blockedRejected, true, "blocked session refuses checkpoint");
      assert.equal((await load(cwd)).sessions.length, 1);
      assert.equal(harness.followUps.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "the enforced critique attempts cap requires rerunCritique or acceptRemainingIssues and refuses early accept",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Gate cap", "pipeline")).value;
      const seed = async (extra: Partial<PlanSnapshot>) => {
        await writePlan(cwd, session.planPath, {
          ...emptyPlan(session, "Gate cap brief"),
          ...extra,
        });
      };
      // At the cap (critiqueAttempts >= 2) a plain call must NOT re-run the gate child;
      // the result states the cap and requires exactly one of rerunCritique /
      // acceptRemainingIssues, and the session is neither archived nor advanced.
      await seed({ stage: "critique", critiqueAttempts: 2 });
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "critique";
      });
      const capped = await harness.tool.execute(
        "tool",
        { action: "stage_complete" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(capped.content[0]!.text, /rerunCritique|acceptRemainingIssues/i);
      assert.equal((await load(cwd)).sessions.length, 1);
      assert.equal(selectedSession(await load(cwd))!.stage, "critique");
      // Early accept before the cap is refused: "fix or re-run the gate first".
      await seed({ stage: "critique", critiqueAttempts: 0 });
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "critique";
      });
      const early = await harness.tool.execute(
        "tool",
        { action: "stage_complete", acceptRemainingIssues: true },
        undefined,
        undefined,
        ctx,
      );
      assert.match(early.content[0]!.text, /fix or re-run the gate first/i);
      assert.equal((await load(cwd)).sessions.length, 1);
      // rerunCritique and acceptRemainingIssues together are mutually exclusive.
      const both = await harness.tool.execute(
        "tool",
        {
          action: "stage_complete",
          rerunCritique: true,
          acceptRemainingIssues: true,
        },
        undefined,
        undefined,
        ctx,
      );
      assert.match(both.content[0]!.text, /mutually exclusive/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "/kanban complete is gated on plan.pendingCompletion and converts it into the archived completion record",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Complete gate", "pipeline")).value;
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "critique";
      });
      // Without pendingCompletion the command only notifies and archives nothing.
      await harness.commands.get("kanban").handler("complete", ctx);
      assert.equal((await load(cwd)).sessions.length, 1);
      // A tool confirm-refusal path wrote the durable pending record; the command is
      // the only authority and takes no free-form inputs.
      await writePlan(cwd, session.planPath, {
        ...emptyPlan(session, "Complete gate brief"),
        stage: "critique",
        pendingCompletion: {
          critique: "accepted-issues",
          note: "two minor layout issues accepted",
        },
      });
      const confirmCtx = context(cwd, {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      await harness.commands.get("kanban").handler("complete", confirmCtx);
      const state = await load(cwd);
      assert.equal(state.sessions.length, 0);
      const plan = await readPlan(cwd, session.planPath);
      assert.equal(plan?.status, "complete");
      assert.equal(plan?.completion?.critique, "accepted-issues");
      assert.equal(plan?.pendingCompletion, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "pipeline-mode critiqueSummary is authorized only while plan.gateFailure exists",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Gate failure", "pipeline")).value;
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "critique";
      });
      // A healthy gate cannot be bypassed with a summary: the call is refused (as a
      // thrown error or an error result) and the session is neither archived nor advanced.
      await writePlan(cwd, session.planPath, {
        ...emptyPlan(session, "Gate failure brief"),
        stage: "critique",
      });
      try {
        await harness.tool.execute(
          "tool",
          { action: "stage_complete", critiqueSummary: "sneaky summary" },
          undefined,
          undefined,
          ctx,
        );
      } catch {
        // acceptable refusal shape
      }
      assert.equal((await load(cwd)).sessions.length, 1);
      assert.equal(selectedSession(await load(cwd))!.stage, "critique");
      // After a durable gateFailure record the manual summary path is the only
      // completion; headless it completes without any child and records durably.
      await writePlan(cwd, session.planPath, {
        ...emptyPlan(session, "Gate failure brief"),
        stage: "critique",
        gateFailure: { errorKind: "model", error: "provider auth" },
      });
      const result = await harness.tool.execute(
        "tool",
        {
          action: "stage_complete",
          critiqueSummary: "Reviewed the diff manually; no remaining issues.",
        },
        undefined,
        undefined,
        ctx,
      );
      assert.equal((await load(cwd)).sessions.length, 0);
      const plan = await readPlan(cwd, session.planPath);
      assert.equal(plan?.status, "complete");
      assert.equal(plan?.completion?.critique, "manual");
      assert.ok(result.content[0]!.text.length > 0);
      assert.equal(harness.followUps.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "/kanban implement falls back to the agent-owned conversation while the loop is disabled",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const session = (await addSession(cwd, "Loop off", "pipeline")).value;
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "implement";
      });
      let kickoff = "";
      const ctx = context(cwd, {
        newSession: async (options: any) => {
          await options.setup({ appendMessage: () => {} });
          await options.withSession({
            sendUserMessage: async (message: string) => (kickoff = message),
          });
          return { cancelled: false };
        },
      });
      await harness.commands.get("kanban").handler("implement", ctx);
      // loop.enabled defaults to false: implement stays AGENT-owned, exactly as today.
      assert.match(kickoff, /implement/i);
      assert.equal((await load(cwd)).sessions[0]!.stage, "implement");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("/kanban implement refuses an enabled loop with no fitness signal", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    const session = (await addSession(cwd, "Loop unarmed", "pipeline")).value;
    await mutate(cwd, (state) => {
      const record = state.sessions.find((item) => item.title === session.title)!;
      record.stage = "implement";
    });
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({ loop: { enabled: true } }),
      "utf8",
    );
    const ctx = context(cwd);
    await harness.commands.get("kanban").handler("implement", ctx);
    assert.match(ctx.notifications.join("\n"), /fitness signal/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/kanban implement is only valid at the implement stage and reports a wrong verb", async () => {
  const cwd = await sandbox();
  try {
    const harness = extensionHarness();
    await addSession(cwd, "Not implementing", "pipeline");
    const ctx = context(cwd);
    await harness.commands.get("kanban").handler("implement", ctx);
    assert.match(ctx.notifications.join("\n"), /only valid at the implement stage/);
    await harness.commands.get("kanban").handler("implement nonsense", ctx);
    assert.match(ctx.notifications.join("\n"), /Usage: \/kanban implement \[stop\]/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test(
  "stage_complete(implement) is refused only while a run is LIVE, never for a stale token",
  async () => {
    const cwd = await sandbox();
    try {
      const harness = extensionHarness();
      const ctx = context(cwd);
      const session = (await addSession(cwd, "Loop live", "pipeline")).value;
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "implement";
        // A DURABLE token with no live run: left behind by the compose pipeline or a crash.
        record.pipelineToken = "stale-token";
      });

      // A stale token alone must NOT block the agent-owned advance.
      const advanced = await harness.tool.execute(
        "tool",
        { action: "stage_complete" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(advanced.content[0]!.text, /Critique gate armed/i);
      assert.equal(selectedSession(await load(cwd))!.stage, "critique");

      // With a LIVE registry entry for the title, the same call is refused.
      await mutate(cwd, (state) => {
        const record = state.sessions.find((item) => item.title === session.title)!;
        record.stage = "implement";
      });
      const controller = new AbortController();
      const gate = runCritiqueGate(ctx as any, selectedSession(await load(cwd))!, {
        runChild: () =>
          new Promise((resolve) => {
            controller.signal.addEventListener("abort", () =>
              resolve({ text: "", aborted: true, errorKind: "aborted" }),
            );
          }),
        config: (await loadConfig(cwd)).config,
        diff: "",
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(hasLiveRun(session.title), true);
      await assert.rejects(
        harness.tool.execute("tool", { action: "stage_complete" }, undefined, undefined, ctx),
        /implement loop is running/,
      );
      controller.abort();
      await gate;
      assert.equal(hasLiveRun(session.title), false);
    } finally {
      clearPipelineRegistry();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
