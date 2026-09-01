import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveConfigModel } from "../src/config.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-config-test-"));
}

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
        models: { refine: "project:refine-model", critique: "project:review" },
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
      critique: "project:review",
    });
    assert.equal(loaded.config.fastPath, true);
    assert.deepEqual(loaded.config.research, { workers: 2 });
    assert.equal(loaded.config.runner, "subprocess");
    assert.equal(loaded.config.piBin, "agent-pi");
    assert.deepEqual(loaded.config.init, { check: "verify-project" });
    assert.deepEqual(loaded.warnings, []);
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
    assert.equal(loaded.config.research.workers, 3);
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
