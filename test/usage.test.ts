import assert from "node:assert/strict";
import test from "node:test";
import { beginUsage, beginChildUsage, reportUsage, getUsage, finishChildUsage, endUsage, usageLines } from "../src/usage.js";
import { refreshWidget, startUsageDisplay } from "../src/ui.js";

const model = { provider: "test", id: "model", contextWindow: 1000 };

test("usage separates per-child context from cumulative tokens and counts snapshots only once", () => {
  const run = new AbortController();
  const a = new AbortController(), b = new AbortController();
  beginUsage("/usage", "parallel", run.signal);
  beginChildUsage(run.signal, a.signal, "research", "worker A", model);
  beginChildUsage(run.signal, b.signal, "research", "worker B", { ...model, contextWindow: 2000 });
  reportUsage(a.signal, { contextTokens: 800, totalTokens: 1200, cost: 0.2 });
  reportUsage(a.signal, { contextTokens: 800, totalTokens: 1200, cost: 0.2 });
  assert.match(usageLines(getUsage("/usage", "parallel")!)[0], /\$0.2000 \+ unreported/);
  reportUsage(b.signal, { contextTokens: 1000, totalTokens: 3000, cost: 0.3 });
  const usage = getUsage("/usage", "parallel")!;
  assert.equal(usage.totalCost, 0.5);
  assert.equal(usage.totalTokens, 4200);
  assert.equal(usage.children[0]!.contextTokens, 800);
  assert.equal(usage.children[1]!.contextWindow, 2000);
  reportUsage(a.signal, { contextTokens: null });
  assert.equal(usage.children[0]!.contextTokens, 800);
  assert.equal(usage.children[0]!.contextStale, true);
  reportUsage(a.signal, { contextTokens: 150, totalTokens: 1400, cost: 0.25 });
  assert.equal(usage.children[0]!.contextStale, false);
  assert.equal(usage.totalTokens, 4400);
  finishChildUsage(a.signal); finishChildUsage(b.signal);
  const compose = new AbortController();
  beginChildUsage(run.signal, compose.signal, "compose", "compose", model);
  assert.equal(usage.children.length, 1);
  assert.equal(usage.children[0]!.contextTokens, undefined);
  assert.equal(usage.stageCost, 0);
  assert.equal(usage.totalCost, 0.55);
  reportUsage(a.signal, { cost: 100 });
  assert.equal(usage.totalCost, 0.55);
  run.abort();
  reportUsage(compose.signal, { cost: 100 });
  assert.equal(usage.totalCost, 0.55);
  const resumed = new AbortController();
  beginUsage("/usage", "parallel", resumed.signal);
  assert.equal(getUsage("/usage", "parallel")!.totalCost, 0.55);
  assert.equal(getUsage("/other", "parallel"), undefined);
  endUsage(resumed.signal);
});

test("usage rejects invalid numbers and retains a reported zero cost", () => {
  const run = new AbortController();
  beginUsage("/usage", "numbers", run.signal);
  beginChildUsage(run.signal, run.signal, "refine", "refine", model);
  reportUsage(run.signal, { cost: NaN, contextTokens: -1, totalTokens: Infinity, contextWindow: 0 });
  const usage = getUsage("/usage", "numbers")!;
  assert.equal(usage.children[0]!.contextTokens, undefined);
  assert.equal(usage.children[0]!.cost, undefined);
  reportUsage(run.signal, { cost: 0, totalTokens: 10, contextTokens: 10 });
  assert.equal(usage.reports, 1);
  assert.match(usageLines(usage)[0], /\$0.0000/);
  endUsage(run.signal);
});

test("context widget follows child stages, uses the tightest window and reverts to the main session", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const ctx: any = {
    cwd: "/usage-widget", model, getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
    isIdle: () => true, sessionManager: { getSessionFile: () => "usage-widget-session" },
    ui: { setWidget: (key: string, value: any) => widgets.set(key, value), setStatus: (key: string, value: string) => statuses.set(key, value) },
  };
  const state: any = { selectedSessionTitle: "A", sessions: [{ title: "A", stage: "research", agents: [] }] };
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const render = () => widgets.get("kanban")({}, theme).render(240).join("\n");
  await refreshWidget(ctx, state);
  const run = new AbortController(), a = new AbortController(), b = new AbortController();
  beginUsage(ctx.cwd, "A", run.signal);
  const stop = startUsageDisplay(ctx, run.signal);
  beginChildUsage(run.signal, a.signal, "research", "A", model);
  beginChildUsage(run.signal, b.signal, "research", "B", { ...model, contextWindow: 2000 });
  assert.match(render(), /research context.*awaiting usage/);
  reportUsage(a.signal, { contextTokens: 800, cost: 0.2, totalTokens: 1200 });
  reportUsage(b.signal, { contextTokens: 1000, cost: 0.3, totalTokens: 2500 });
  await Promise.resolve();
  assert.match(render(), /context \(min\).*200 \/ 1,000 · 20% remaining/);
  assert.match(statuses.get("kanban-usage")!, /research \$0.5000/);
  state.sessions[0].stage = "compose";
  const c = new AbortController();
  beginChildUsage(run.signal, c.signal, "compose", "compose", model);
  await Promise.resolve();
  assert.match(render(), /compose context.*awaiting usage/);
  assert.doesNotMatch(render(), /20% remaining/);
  reportUsage(c.signal, { contextTokens: 200, totalTokens: 200, cost: 0.1 });
  assert.match(render(), /compose context.*80% remaining/);
  endUsage(run.signal); stop();
  assert.match(render(), /Current Pi context.*90% remaining/);
  assert.match(statuses.get("kanban-usage")!, /tracked total \$0.6000/);
  state.selectedSessionTitle = "B";
  state.sessions = [{ title: "B", stage: "implement", agents: [] }];
  await refreshWidget(ctx, state);
  assert.equal(statuses.get("kanban-usage"), undefined);
});
