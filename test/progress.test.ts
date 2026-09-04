import assert from "node:assert/strict";
import test from "node:test";
import { PipelineProgress } from "../src/pipelineprogress.js";
import { appendLiveOutput, beginLoopProgress, endLoopProgress, loopProgress, updateLoopProgress } from "../src/liveprogress.js";
import { renderLoopProgress, refreshWidget, startLoopWidget } from "../src/ui.js";

test("pipeline progress counts completions, distinguishes silence, and uses only completed-run timing", () => {
  let now = 0;
  const lines: string[] = [];
  const first = new PipelineProgress("research", "grill", "timing-test", 300_000, (line) => lines.push(line), () => now);
  try {
    first.start("A"); first.start("B");
    first.activity("A", "using read");
    now = 45_000;
    first.finish("B", false);
    assert.match(lines.at(-1)!, /1 running · 1\/2 finished/);
    assert.match(lines.at(-1)!, /using read \(45s ago\)/);
    assert.match(lines.at(-1)!, /ETA unknown \(no history\)/);
    assert.match(lines.at(-1)!, /child limit 5m0s/);
    now = 60_000;
    first.finish("A", false);
  } finally { first.stop(true); }
  const second = new PipelineProgress("research", "grill", "timing-test", 300_000, (line) => lines.push(line), () => now);
  try {
    second.start("A");
    assert.match(lines.at(-1)!, /42s–1m18s left \(recent runs\)/);
    now += 90_000;
    second.render();
    assert.match(lines.at(-1)!, /ETA uncertain/);
    second.question(2, 3);
    assert.match(lines.at(-1)!, /ETA waits for you/);
  } finally { second.stop(false); }
  const count = lines.length;
  second.render();
  assert.equal(lines.length, count);
});

test("loop output is bounded, sanitized, isolated by repository, and frozen on abort", () => {
  const controller = new AbortController();
  beginLoopProgress("/a", "same", controller.signal, { title: "A", goal: "Improve score", maxIterations: 8, direction: "higher", target: 5 });
  appendLiveOutput(controller.signal, "x".repeat(9000));
  appendLiveOutput(controller.signal, "\u001b[31mvisible\u001b[0m\u0007");
  const live = loopProgress("/a", "same")!;
  assert.equal(live.output.length, 8000);
  assert.match(live.output, /visible$/);
  assert.doesNotMatch(live.output, /\u001b|\u0007/);
  assert.equal(loopProgress("/b", "same"), undefined);
  updateLoopProgress(controller.signal, { childRunning: true, iteration: 2, best: 3, latest: 2, comment: "discard: metric regressed" });
  assert.match(renderLoopProgress(live).join("\n"), /latest 2 · best 3 · target 5/);
  controller.abort();
  const before = live.output;
  appendLiveOutput(controller.signal, "late text");
  assert.equal(live.output, before);
  assert.equal(live.childRunning, false);
  assert.equal(live.active, false);
});

test("implement widget follows selection and is cleared on abort", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const controller = new AbortController();
  const widgets = new Map<string, any>();
  const ctx: any = {
    cwd: "/widget", hasUI: true, model: { contextWindow: 100 },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100 }), isIdle: () => true,
    sessionManager: { getSessionFile: () => "widget-test" },
    ui: { setWidget: (key: string, value: any) => widgets.set(key, value) },
  };
  const state: any = { selectedSessionTitle: "A", sessions: [{ title: "A", stage: "implement", agents: [] }] };
  await refreshWidget(ctx, state);
  beginLoopProgress(ctx.cwd, "base", controller.signal, { title: "A", goal: "Ship feature", maxIterations: 4, direction: "higher" });
  startLoopWidget(ctx, "base", controller.signal);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  assert.match(widgets.get("kanban-progress")({}, theme).render(120).join("\n"), /Goal: Ship feature/);
  assert.equal(widgets.get("kanban")({}, theme).render(120).length, 4);
  state.selectedSessionTitle = undefined;
  await refreshWidget(ctx, state);
  t.mock.timers.tick(1000);
  assert.equal(widgets.get("kanban-progress"), undefined);
  state.selectedSessionTitle = "A";
  await refreshWidget(ctx, state);
  t.mock.timers.tick(1000);
  assert(widgets.get("kanban-progress"));
  controller.abort();
  assert.equal(widgets.get("kanban-progress"), undefined);
  endLoopProgress(controller.signal);
});
