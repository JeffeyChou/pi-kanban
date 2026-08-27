import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistSessionArtifacts } from "../src/artifacts.js";
import { discoverSessionFiles } from "../src/sources.js";
import {
  blockDependents,
  createSession,
  initialize,
  load,
  mutate,
  newTask,
  prerequisitesComplete,
  selectedSession,
} from "../src/store.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-test-"));
}

test("initialization migrates prior state and preserves sessions", async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, "legacy.json"), "", "utf8");
    await initialize(cwd, {
      background: true,
      subagents: true,
      questions: true,
    });
    await mutate(cwd, (state) => {
      createSession(state, "Release", "write tests");
      return state;
    });
    const recovered = await initialize(cwd, {
      background: true,
      subagents: false,
      questions: true,
    });
    assert.equal(recovered.schemaVersion, 2);
    assert.equal(recovered.sessions.length, 1);
    assert.equal(recovered.sessions[0]!.tasks[0]!.description, "write tests");
    assert.equal(recovered.integrations.subagents, false);
    assert.equal(selectedSession(recovered)?.title, "Release");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schema version one state migrates without losing durable content", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd, {});
    await mutate(cwd, (state) => {
      createSession(state, "Migrated");
      return state;
    });
    const statePath = join(cwd, ".kanban", "state.json");
    const current = JSON.parse(await readFile(statePath, "utf8"));
    current.schemaVersion = 1;
    delete current.selectedSessionId;
    delete current.modelContextLimits;
    for (const session of current.sessions) {
      delete session.sourceFiles;
      delete session.planArtifact;
      delete session.handoffArtifact;
      delete session.currentActivity;
      delete session.liveProgress;
    }
    await writeFile(statePath, JSON.stringify(current), "utf8");
    const migrated = await load(cwd);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.sessions[0]!.title, "Migrated");
    assert.deepEqual(migrated.sessions[0]!.sourceFiles, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent mutations serialize through the repository lock", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd, {});
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        mutate(cwd, (state) => {
          createSession(state, `S${index}`);
          return state;
        }),
      ),
    );
    assert.equal((await load(cwd)).sessions.length, 12);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session artifacts discover source paths and retain explicit paths", async () => {
  const cwd = await sandbox();
  try {
    await writeFile(join(cwd, "example.ts"), "export {};\n", "utf8");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "discovered.py"), "pass\n", "utf8");
    await initialize(cwd, {});
    let session;
    await mutate(cwd, (state) => {
      session = createSession(state, "Sources");
      session.sourceFiles.push("example.ts");
      return state;
    });
    await persistSessionArtifacts(cwd, session!);
    await writeFile(
      join(cwd, session!.handoffArtifact),
      `${await readFile(join(cwd, session!.handoffArtifact), "utf8")}\nNext inspect: src/discovered.py\n`,
      "utf8",
    );
    const files = await discoverSessionFiles(cwd, session!);
    assert.deepEqual(files, ["example.ts", "src/discovered.py"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed prerequisite manually blocks all dependents", () => {
  const state = {
    schemaVersion: 2 as const,
    sessions: [],
    integrations: {},
    modelContextLimits: {},
    updatedAt: "",
  };
  const session = createSession(state, "Dependencies");
  const prerequisite = newTask("a", "first");
  const child = newTask("b", "second");
  child.prerequisites = ["a"];
  const grandchild = newTask("c", "third");
  grandchild.prerequisites = ["b"];
  session.tasks.push(prerequisite, child, grandchild);
  prerequisite.state = "failed";
  blockDependents(session, prerequisite.id);
  assert.equal(child.state, "blocked_manual");
  assert.equal(grandchild.state, "blocked_manual");
  assert.equal(prerequisitesComplete(session, child), false);
});
