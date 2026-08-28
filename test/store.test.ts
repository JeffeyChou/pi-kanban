import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HANDOFF_MAX_LINES,
  buildHandoff,
  readPlan,
  writeHandoff,
} from "../src/artifacts.js";
import {
  STAGES,
  advanceStage,
  createSession,
  initialize,
  load,
  mutate,
  mutateAsync,
  replaceAgents,
  safeTitleSlug,
  selectedSession,
} from "../src/store.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-test-"));
}

test("v3 state keeps only compact active-session metadata", async () => {
  const cwd = await sandbox();
  try {
    const created = await mutateAsync(cwd, async (state) =>
      createSession(cwd, state, "Release readiness"),
    );
    const session = created.value;
    assert.equal(created.state.schemaVersion, 3);
    assert.equal(created.state.selectedSessionTitle, "Release readiness");
    assert.deepEqual(session.agents, [
      { name: "Primary agent", role: "Coordinator", status: "idle" },
    ]);
    assert.match(session.planPath, /^plans\/\d{4}-\d{2}-\d{2}-release-readiness\.json$/);
    assert.equal("id" in session, false);
    assert.equal("tasks" in session, false);
    assert.equal("sourceFiles" in session, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("legacy state migrates plans, removes completed sessions, and retires handoffs", async () => {
  const cwd = await sandbox();
  try {
    await mkdir(join(cwd, ".kanban", "plans"), { recursive: true });
    await mkdir(join(cwd, ".kanban", "handoffs"), { recursive: true });
    await writeFile(join(cwd, ".kanban", "plans", "done-id.json"), "{}\n");
    await writeFile(join(cwd, ".kanban", "handoffs", "done-id.md"), "legacy\n");
    await writeFile(
      join(cwd, ".kanban", "state.json"),
      JSON.stringify({
        schemaVersion: 2,
        selectedSessionId: "done-id",
        sessions: [
          {
            id: "active-id",
            title: "Active migration",
            stage: "implement",
            state: "active",
            tasks: [
              { title: "Implement schema", state: "in_progress", todos: [] },
            ],
            agents: [{ kind: "primary", currentTask: "task" }],
            createdAt: "2026-08-20T12:00:00.000Z",
            updatedAt: "2026-08-21T12:00:00.000Z",
          },
          {
            id: "done-id",
            title: "Completed migration",
            stage: "critique",
            state: "complete",
            tasks: [
              { title: "Review", state: "completed", todos: [] },
            ],
            createdAt: "2026-08-19T12:00:00.000Z",
            updatedAt: "2026-08-22T12:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const migrated = await load(cwd);
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.sessions.length, 1);
    assert.equal(migrated.sessions[0]!.title, "Active migration");
    assert.equal(migrated.selectedSessionTitle, "Active migration");
    assert.equal("tasks" in migrated.sessions[0]!, false);

    const plans = await readdir(join(cwd, ".kanban", "plans"));
    assert.equal(plans.some((name) => name === "done-id.json"), false);
    assert.equal(plans.length, 2);
    const completePath = `plans/${plans.find((name) => name.includes("completed-migration"))!}`;
    const completePlan = await readPlan(cwd, completePath);
    assert.equal(completePlan?.status, "complete");
    assert.deepEqual(completePlan?.work.done, ["Review"]);
    const handoff = await readFile(join(cwd, ".kanban", "handoff.md"), "utf8");
    assert.match(handoff, /No supplementary handoff recorded\./);
    await assert.rejects(access(join(cwd, ".kanban", "handoffs")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent mutations serialize through the repository lock", async () => {
  const cwd = await sandbox();
  try {
    await initialize(cwd);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        mutate(cwd, (state) => {
          state.sessions.push({
            title: `S${index}`,
            stage: "refine",
            state: "active",
            planPath: `plans/s${index}.json`,
            agents: [],
            createdAt: "",
            updatedAt: "",
          });
          state.selectedSessionTitle ??= `S${index}`;
        }),
      ),
    );
    assert.equal((await load(cwd)).sessions.length, 12);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("agent records stay role-based and terminal critique removes the session", async () => {
  const cwd = await sandbox();
  try {
    const created = await mutateAsync(cwd, async (state) =>
      createSession(cwd, state, "Finish me"),
    );
    const terminal = await mutate(cwd, (state) => {
      const session = selectedSession(state)!;
      replaceAgents(session, [
        { name: "Researcher", role: "API review", status: "working" },
      ]);
      session.stage = "critique";
      return advanceStage(state, session);
    });
    assert.equal(created.value.title, "Finish me");
    assert.equal(terminal.value, undefined);
    assert.equal(terminal.state.sessions.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("handoff line limit and safe title slugs are enforced", async () => {
  const cwd = await sandbox();
  try {
    const longHandoff = buildHandoff(
      Array.from({ length: HANDOFF_MAX_LINES }, () => "detail").join("\n"),
    );
    await assert.rejects(writeHandoff(cwd, longHandoff), /at most 200 lines/);
    assert.equal(safeTitleSlug("Résumé / API Cleanup!"), "resume-api-cleanup");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
