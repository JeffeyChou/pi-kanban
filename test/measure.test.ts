import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoopConfig } from "../src/config.js";
import {
  MEASURE_TAIL_MAX_LINES,
  measure,
  parseMetric,
} from "../src/measure.js";

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-measure-test-"));
}

function loop(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    enabled: true,
    direction: "higher",
    maxIterations: 10,
    noImprovementStreak: 3,
    measureTimeoutMs: 2_000,
    hooks: false,
    ...overrides,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("parseMetric accepts finite lines, filters names, and keeps the last finite duplicate", () => {
  assert.equal(parseMetric("METRIC score=1.25\r\n", "score"), 1.25);
  assert.equal(parseMetric("no metric here\n"), undefined);
  assert.equal(
    parseMetric("METRIC score=1\nMETRIC score=2\n", "score"),
    2,
  );
  assert.equal(
    parseMetric("METRIC score=1\nMETRIC score=Infinity\n", "score"),
    1,
  );
  assert.equal(
    parseMetric("METRIC other=9\nMETRIC score=3\n", "score"),
    3,
  );
  assert.equal(parseMetric("METRIC other=9\n", "score"), undefined);
  assert.equal(parseMetric("METRIC any=4\n"), 4);
});

test("measure reports validation pass and failure and prefers failing output in its tail", async () => {
  const cwd = await sandbox();
  try {
    const pass = await measure(
      cwd,
      loop({ validate: "echo validation-ok; exit 0" }),
      new AbortController().signal,
    );
    assert.deepEqual(pass, {
      validationPass: true,
      tail: "validation-ok",
      metricUnmeasured: false,
    });

    const fail = await measure(
      cwd,
      loop({
        validate: "echo validation-failed; exit 3",
        metric: "echo METRIC score=4",
      }),
      new AbortController().signal,
    );
    assert.equal(fail.validationPass, false);
    assert.equal(fail.metric, 4);
    assert.equal(fail.metricUnmeasured, false);
    assert.equal(fail.tail, "validation-failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("metric-only measurement is valid and marks missing metrics unmeasured", async () => {
  const cwd = await sandbox();
  try {
    const measured = await measure(
      cwd,
      loop({ metric: "printf 'METRIC reward=7\\n'", metric_name: "reward" }),
      new AbortController().signal,
    );
    assert.equal(measured.validationPass, true);
    assert.equal(measured.metric, 7);
    assert.equal(measured.metricUnmeasured, false);

    const unmeasured = await measure(
      cwd,
      loop({ metric: "echo no-metric" }),
      new AbortController().signal,
    );
    assert.deepEqual(unmeasured, {
      validationPass: true,
      tail: "no-metric",
      metricUnmeasured: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("measurement tail is capped by MEASURE_TAIL_MAX_LINES", async () => {
  const cwd = await sandbox();
  try {
    const result = await measure(
      cwd,
      loop({ validate: "for i in {1..45}; do echo line-$i; done" }),
      new AbortController().signal,
    );
    const lines = result.tail.split("\n");
    assert.equal(lines.length, MEASURE_TAIL_MAX_LINES);
    assert.equal(lines[0], "line-6");
    assert.equal(lines.at(-1), "line-45");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("timeout kills the detached process group and does not leave background work alive", async () => {
  const cwd = await sandbox();
  const marker = join(cwd, "background-marker");
  try {
    const started = Date.now();
    const outcome = await measure(
      cwd,
      loop({
        validate: `(sleep 1; touch ${JSON.stringify(marker)}) & sleep 1`,
        measureTimeoutMs: 80,
      }),
      new AbortController().signal,
    );
    assert.equal(outcome.validationPass, false);
    assert.ok(Date.now() - started < 800, "timeout should return promptly");
    await wait(1_100);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an already-aborted signal returns without spawning a command", async () => {
  const cwd = await sandbox();
  const marker = join(cwd, "should-not-exist");
  try {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const outcome = await measure(
      cwd,
      loop({ validate: `touch ${JSON.stringify(marker)}` }),
      controller.signal,
    );
    assert.equal(outcome.validationPass, false);
    assert.equal(outcome.tail, "");
    assert.ok(Date.now() - started < 100, "pre-aborted work should return immediately");
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("aborting a running command terminates its complete process group", async () => {
  const cwd = await sandbox();
  const marker = join(cwd, "abort-marker");
  try {
    const controller = new AbortController();
    const started = Date.now();
    const running = measure(
      cwd,
      loop({
        validate: `(sleep 1; touch ${JSON.stringify(marker)}) & sleep 2`,
      }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 60);
    const outcome = await running;
    assert.equal(outcome.validationPass, false);
    assert.ok(Date.now() - started < 800, "abort should return promptly");
    await wait(1_100);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
