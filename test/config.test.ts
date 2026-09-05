import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveConfigModel, validateLoopRevision } from "../src/config.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-config-test-"));
}

test("managed job configuration and user revisions validate adapter shape and zero submission budgets", () => {
  assert.doesNotThrow(() => validateLoopRevision({ maxSubmissions: 0, maxChildRuns: 0, jobs: {
    cpu: { kind: "local", command: "check" },
    capture: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", timeoutMs: 10000 },
  } }));
  for (const patch of [
    { maxSubmissions: -1 }, { maxConcurrentChildren: 0 }, { enabled: false }, { target: Infinity },
    { jobs: { bad: { kind: "scheduled", submit: "submit" } } },
    { jobs: { bad: { kind: "local", command: "check", shell: "arbitrary" } } },
    { arbitraryCommand: "run" },
  ]) assert.throws(() => validateLoopRevision(patch));
});

test("config layers use defaults, then agent configuration, then repository configuration", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "kanban.json"),
      JSON.stringify({
        models: { refine: "agent:refine-model" },
        fastPath: false,
        runner: "subprocess",
        piBin: "agent-pi",
      }),
    );
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({
        models: {
          refine: "project:refine-model",
          implement: "project:implement-model",
          critique: "project:review",
        },
        research: { workers: 2 },
        fastPath: true,
        init: { start: null, check: "verify-project" },
      }),
    );

    const loaded = await loadConfig(cwd, agentDir);
    assert.deepEqual(loaded.config.models, {
      refine: "project:refine-model",
      research: null,
      grill: null,
      compose: null,
      implement: "project:implement-model",
      critique: "project:review",
    });
    assert.equal(loaded.config.fastPath, true);
    assert.deepEqual(loaded.config.research, { workers: 2, depth: "focused" });
    assert.equal(loaded.config.runner, "subprocess");
    assert.equal(loaded.config.piBin, "agent-pi");
    assert.deepEqual(loaded.config.init, { check: "verify-project" });
    assert.deepEqual(loaded.warnings, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loop configuration has explicit defaults and accepts a complete valid layer", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    const defaults = await loadConfig(cwd, agentDir);
    assert.deepEqual(defaults.config.loop, {
      enabled: false,
      direction: "higher",
      decisionPolicy: "agent-with-validation",
      maxIterations: 50,
      noImprovementStreak: 8,
      measureTimeoutMs: 300_000,
      hooks: false,
      audit: false,
      autoResume: false,
    });

    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({
        loop: {
          enabled: true,
          validate: "npm test && npm run typecheck",
          metric: "node measure.js",
          metric_name: "latency_ms",
          direction: "lower",
          decisionPolicy: "strict-metric",
          target: 12.5,
          baselineMetric: 41.5,
          maxIterations: 7,
          noImprovementStreak: 2,
          measureTimeoutMs: 1234,
          hooks: true,
          audit: true,
          auditPaths: ["evidence/run"],
          autoResume: true,
        },
      }),
    );

    const configured = await loadConfig(cwd, agentDir);
    assert.deepEqual(configured.config.loop, {
      enabled: true,
      validate: "npm test && npm run typecheck",
      metric: "node measure.js",
      metric_name: "latency_ms",
      direction: "lower",
      decisionPolicy: "strict-metric",
      target: 12.5,
      baselineMetric: 41.5,
      maxIterations: 7,
      noImprovementStreak: 2,
      measureTimeoutMs: 1234,
      hooks: true,
      audit: true,
      auditPaths: ["evidence/run"],
      autoResume: true,
    });
    assert.deepEqual(configured.warnings, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project loop values override user values without inheriting init commands", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "kanban.json"),
      JSON.stringify({
        loop: {
          enabled: true,
          validate: "user-validate",
          metric: "user-metric",
          direction: "higher",
          maxIterations: 20,
        },
      }),
    );
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({
        loop: { direction: "lower", maxIterations: 4 },
        init: { check: "./init.sh --check" },
      }),
    );

    const loaded = await loadConfig(cwd, agentDir);
    assert.equal(loaded.config.loop.enabled, true);
    assert.equal(loaded.config.loop.validate, "user-validate");
    assert.equal(loaded.config.loop.metric, "user-metric");
    assert.equal(loaded.config.loop.direction, "lower");
    assert.equal(loaded.config.loop.maxIterations, 4);
    assert.equal(loaded.config.init.check, "./init.sh --check");
    assert.equal(loaded.config.loop.validate, "user-validate");
    assert.equal(loaded.config.loop.metric, "user-metric");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loop validation warns for unknown, null, invalid, and non-finite values", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      // `1e999` is valid JSON parsed as Infinity, so it exercises finite-number validation.
      '{"loop":{"unknown":true,"enabled":"yes","validate":null,"metric":false,"metric_name":0,"direction":"sideways","target":1e999,"baselineMetric":1e999,"maxIterations":0,"noImprovementStreak":-1,"measureTimeoutMs":0,"hooks":1,"audit":"yes","auditPaths":[]}}',
    );
    const invalid = await loadConfig(cwd, agentDir);
    assert.deepEqual(invalid.config.loop, {
      enabled: false,
      direction: "higher",
      decisionPolicy: "agent-with-validation",
      maxIterations: 50,
      noImprovementStreak: 8,
      measureTimeoutMs: 300_000,
      hooks: false,
      audit: false,
      autoResume: false,
    });
    assert.equal(invalid.warnings.length, 14);
    for (const key of [
      "unknown",
      "enabled",
      "validate",
      "metric",
      "metric_name",
      "direction",
      "target",
      "baselineMetric",
      "maxIterations",
      "noImprovementStreak",
      "measureTimeoutMs",
      "hooks",
      "audit",
      "auditPaths",
    ]) {
      assert.match(invalid.warnings.join("\n"), new RegExp(`loop\\.${key}`));
    }

    await writeFile(
      join(cwd, ".kanban", "config.json"),
      '{"loop":{"maxIterations":-1,"target":NaN}}',
    );
    const negativeAndNaN = await loadConfig(cwd, agentDir);
    assert.equal(negativeAndNaN.config.loop.maxIterations, 50);
    assert.equal(negativeAndNaN.config.loop.target, undefined);
    assert.match(negativeAndNaN.warnings.join("\n"), /Invalid JSON/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config validation ignores unknown and invalid values while reporting warnings", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({
        unknownRoot: true,
        models: { unknownStage: "bad", refine: 42 },
        research: { workers: 4, extra: true },
        critique: "yes",
        init: { start: false, extra: "ignored" },
      }),
    );
    const loaded = await loadConfig(cwd, agentDir);
    assert.equal(loaded.config.models.refine, null);
    assert.equal(loaded.config.research.workers, 2);
    assert.equal(loaded.config.critique, true);
    assert.deepEqual(loaded.config.init, {});
    assert.equal(loaded.warnings.length, 8);
    assert.match(loaded.warnings.join("\n"), /Unknown config key/);
    assert.match(loaded.warnings.join("\n"), /Invalid config value/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto init commands are resolved from executable init.sh and can be disabled", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await writeFile(join(cwd, "init.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(cwd, "init.sh"), 0o755);
    const automatic = await loadConfig(cwd, agentDir);
    assert.deepEqual(automatic.config.init, {
      start: "./init.sh",
      check: "./init.sh --check",
    });

    await mkdir(join(cwd, ".kanban"), { recursive: true });
    await writeFile(
      join(cwd, ".kanban", "config.json"),
      JSON.stringify({ init: { start: null, check: "custom-check" } }),
    );
    const configured = await loadConfig(cwd, agentDir);
    assert.deepEqual(configured.config.init, { check: "custom-check" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configured models resolve through the parent registry and malformed specs fall back", () => {
  const parent = { provider: "parent", id: "model" };
  const expected = { provider: "configured", id: "model" };
  const ctx = {
    model: parent,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "configured" && id === "model" ? expected : undefined,
    },
  };
  assert.equal(resolveConfigModel(ctx as any, null), parent);
  assert.equal(resolveConfigModel(ctx as any, "configured:model"), expected);
  assert.equal(resolveConfigModel(ctx as any, "missing-colon"), undefined);
  assert.equal(resolveConfigModel(ctx as any, "configured:"), undefined);
});

test("planning controls merge independently and reject invalid depth/detail/timeouts", async () => {
  const cwd = await sandbox();
  const agentDir = join(cwd, "agent");
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".kanban"), { recursive: true });
    const defaultConfig = (await loadConfig(cwd, agentDir)).config;
    assert.deepEqual(defaultConfig.compose, { detail: "plan" });
    assert.deepEqual(defaultConfig.pipeline, { childTimeoutMs: 300_000 });
    await writeFile(join(agentDir, "extensions", "kanban.json"), JSON.stringify({
      research: { workers: 1, depth: "deep" }, compose: { detail: "detailed" }, pipeline: { childTimeoutMs: 600_000 },
    }));
    await writeFile(join(cwd, ".kanban", "config.json"), JSON.stringify({
      research: { workers: 2, depth: "invalid" }, compose: { detail: null, extra: true }, pipeline: { childTimeoutMs: -1 },
    }));
    const loaded = await loadConfig(cwd, agentDir);
    assert.deepEqual(loaded.config.research, { workers: 2, depth: "deep" });
    assert.deepEqual(loaded.config.compose, { detail: "detailed" });
    assert.deepEqual(loaded.config.pipeline, { childTimeoutMs: 600_000 });
    assert.equal(loaded.warnings.length, 4);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
