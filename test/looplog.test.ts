import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  LOOP_SUMMARY_MAX_LINES,
  LOOP_SUMMARY_MAX_RECORDS,
  appendLoopLog,
  deleteLoopArtifacts,
  iterationWorktreePath,
  loopDir,
  loopLandedPath,
  loopLogPath,
  loopPatchPath,
  loopRunPath,
  loopSummaryPath,
  readBestPatch,
  readLandedMarker,
  readLoopLog,
  readLoopRun,
  readWorktreeManifest,
  registerWorktree,
  renderLivingSummary,
  sweepLoopWorktrees,
  unregisterWorktree,
  worktreeRoot,
  writeBestPatch,
  writeLandedMarker,
  writeLoopRun,
} from "../src/looplog.js";
import type {
  LoopIterationRecord,
  WorktreeEntry,
} from "../src/looplog.js";
import { createDetachedWorktree, headCommit } from "../src/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-looplog-test-"));
}

/** A real git repository with a base commit, for the worktree-manifest tests. */
async function makeRepo(): Promise<{ root: string; repo: string; base: string }> {
  const root = await sandbox();
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-q"]);
  await writeFile(join(repo, "f.txt"), "x\n");
  await git(repo, ["add", "-A"]);
  await git(repo, [
    "-c", "user.email=test@test",
    "-c", "user.name=test",
    "commit", "-q", "-m", "base",
  ]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { root, repo, base };
}

function record(iteration: number, overrides: Partial<LoopIterationRecord> = {}): LoopIterationRecord {
  return {
    iteration,
    decision: "keep",
    at: `2026-09-01T00:00:0${iteration}.000Z`,
    ...overrides,
  };
}

test("loop paths are per session base under .kanban", async () => {
  const cwd = await sandbox();
  try {
    assert.equal(loopDir(cwd), join(cwd, ".kanban", "loop"));
    assert.equal(loopLogPath(cwd, "2026-09-01-x"), join(cwd, ".kanban", "loop", "2026-09-01-x.jsonl"));
    assert.equal(loopSummaryPath(cwd, "2026-09-01-x"), join(cwd, ".kanban", "loop", "2026-09-01-x.md"));
    assert.equal(loopPatchPath(cwd, "2026-09-01-x"), join(cwd, ".kanban", "loop", "2026-09-01-x.patch"));
    assert.equal(loopLandedPath(cwd, "2026-09-01-x"), join(cwd, ".kanban", "loop", "2026-09-01-x.landed"));
    assert.equal(loopRunPath(cwd, "2026-09-01-x"), join(cwd, ".kanban", "loop", "2026-09-01-x.run.json"));
    assert.equal(worktreeRoot(cwd, "base-a"), join(cwd, ".kanban", "worktrees", "base-a"));
    assert.equal(iterationWorktreePath(cwd, "base-a", 3), join(cwd, ".kanban", "worktrees", "base-a", "3"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loop run manifest is atomic, readable, and rejects corrupt recovery state", async () => {
  const cwd = await sandbox();
  try {
    assert.equal(await readLoopRun(cwd, "session"), undefined);
    const run = {
      schemaVersion: 1 as const,
      base: "session",
      branch: "kanban-autoresearch/session",
      baseCommit: "a".repeat(40),
      bestCommit: "b".repeat(40),
      baselineMetric: 1,
      bestMetric: 2,
      nextIteration: 4,
      status: "paused" as const,
      startedAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
    };
    await writeLoopRun(cwd, "session", run);
    assert.deepEqual(await readLoopRun(cwd, "session"), run);
    await writeFile(loopRunPath(cwd, "session"), "{bad json\n", "utf8");
    assert.equal(await readLoopRun(cwd, "session"), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("appendLoopLog appends one JSON line per record; readLoopLog skips unparseable lines", async () => {
  const cwd = await sandbox();
  try {
    assert.deepEqual(await readLoopLog(cwd, "session"), []);
    await appendLoopLog(cwd, "session", record(1, { metric: 0.5, validation: true, verdict: "continue" }));
    await appendLoopLog(cwd, "session", record(2, {
      decision: "discard",
      validation: false,
      failureReason: "validation failed",
      lesson: "the hook was wrong",
    }));

    // Poison the log with unparseable and non-record lines; they must be skipped.
    const raw = await readFile(loopLogPath(cwd, "session"), "utf8");
    await writeFile(
      loopLogPath(cwd, "session"),
      `${raw.split("\n")[0]}\nnot json {{{\n${raw.split("\n").slice(1).join("\n")}\n"a string"\n`,
    );

    const records = await readLoopLog(cwd, "session");
    assert.equal(records.length, 2);
    assert.equal(records[0].iteration, 1);
    assert.equal(records[0].metric, 0.5);
    assert.equal(records[1].iteration, 2);
    assert.equal(records[1].decision, "discard");
    assert.equal(records[1].lesson, "the hook was wrong");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("renderLivingSummary writes and returns a bounded, newest-first summary with best and lessons", async () => {
  const cwd = await sandbox();
  try {
    const records = [
      record(1, { validation: true, metric: 1, changed: "src/a.ts | 2 +-\nsrc/b.ts | 1 +" }),
      record(2, {
        decision: "discard",
        validation: false,
        metric: 2,
        lesson: "lesson two",
        failureReason: "validation failed",
      }),
      record(3, { validation: true, metric: 3 }),
      record(4, {
        decision: "discard",
        validation: false,
        lesson: "lesson four",
        failureReason: "metric regress",
      }),
      record(5, { validation: true, metric: 5, verdict: "complete" }),
    ];
    const rendered = await renderLivingSummary(cwd, "session", records);

    // Written atomically, and the returned text is exactly the file content.
    assert.equal(await readFile(loopSummaryPath(cwd, "session"), "utf8"), rendered);
    assert.deepEqual(
      (await readdir(loopDir(cwd))).filter((name) => name.endsWith(".tmp")),
      [],
    );

    // Current best: the most recent keep, with its metric and the saved patch location.
    assert.match(rendered, /## Current best/);
    assert.match(rendered, /Iteration #5 is the best so far \(validation passed, metric 5\)/);
    assert.match(rendered, /Saved patch: `\.kanban\/loop\/session\.patch`/);

    // Newest first.
    assert.match(rendered, /## Iterations \(newest first\)/);
    const iterationHeaders = rendered.split("\n").filter((line) => line.startsWith("### #"));
    assert.equal(iterationHeaders.length, 5);
    assert.match(iterationHeaders[0], /#5 keep/);
    assert.match(iterationHeaders[1], /#4 discard/);

    // Lessons from discarded iterations are carried forward.
    assert.match(rendered, /## Lessons from discarded iterations/);
    assert.match(rendered, /- #2: lesson two/);
    assert.match(rendered, /- #4: lesson four/);

    // Bounded: a huge log renders a fixed number of iteration blocks and stays in budget.
    const many = Array.from({ length: 50 }, (_, index) =>
      record(index + 1, { decision: "discard", lesson: `lesson ${index}` }),
    );
    const manyRendered = await renderLivingSummary(cwd, "many", many);
    const manyLines = manyRendered.split("\n");
    assert.ok(manyLines.length <= LOOP_SUMMARY_MAX_LINES, `summary exceeded ${LOOP_SUMMARY_MAX_LINES} lines`);
    assert.equal(
      manyLines.filter((line) => line.startsWith("### #")).length,
      LOOP_SUMMARY_MAX_RECORDS,
    );
    assert.match(manyRendered, /\[truncated: showing the 8 most recent of 50 iterations\]/);
    assert.match(manyRendered, /- #50: lesson 49/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writeBestPatch stores the patch and returns its sha256; readBestPatch round-trips", async () => {
  const cwd = await sandbox();
  try {
    assert.equal(await readBestPatch(cwd, "session"), undefined);
    const patch = "diff --git a/x.ts b/x.ts\nindex 0000000..1111111\n";
    const sha = await writeBestPatch(cwd, "session", patch);
    assert.equal(sha, createHash("sha256").update(patch, "utf8").digest("hex"));
    assert.equal(await readFile(loopPatchPath(cwd, "session"), "utf8"), patch);
    assert.equal(await readBestPatch(cwd, "session"), patch);
    assert.equal(await readBestPatch(cwd, "other"), undefined);
    assert.deepEqual(
      (await readdir(loopDir(cwd))).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the .landed marker writes atomically, replaces cleanly, and tolerates corruption", async () => {
  const cwd = await sandbox();
  try {
    assert.equal(await readLandedMarker(cwd, "session"), undefined);
    await writeLandedMarker(cwd, "session", "sha-one");
    assert.deepEqual(await readLandedMarker(cwd, "session"), { base: "session", patchSha: "sha-one" });
    await writeLandedMarker(cwd, "session", "sha-two");
    assert.deepEqual(await readLandedMarker(cwd, "session"), { base: "session", patchSha: "sha-two" });
    assert.deepEqual(JSON.parse(await readFile(loopLandedPath(cwd, "session"), "utf8")), {
      base: "session",
      patchSha: "sha-two",
    });
    // No tmp residue from the atomic writes.
    assert.deepEqual(
      (await readdir(loopDir(cwd))).filter((name) => name.endsWith(".tmp")),
      [],
    );
    // A corrupt marker reads as undefined, never throws.
    await writeFile(loopLandedPath(cwd, "session"), "{oops\n");
    assert.equal(await readLandedMarker(cwd, "session"), undefined);
    // The stored base wins over the caller's argument.
    await writeFile(loopLandedPath(cwd, "session"), JSON.stringify({ base: "other", patchSha: "x" }));
    assert.deepEqual(await readLandedMarker(cwd, "session"), { base: "other", patchSha: "x" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the worktree manifest registers, replaces by path, unregisters and reads back", async () => {
  const cwd = await sandbox();
  try {
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), []);
    const a: WorktreeEntry = { path: "/tmp/wt/a", pid: 111, startedAt: "t0" };
    const b: WorktreeEntry = { path: "/tmp/wt/b", pid: 222, startedAt: "t1" };
    await registerWorktree(cwd, "session", a);
    await registerWorktree(cwd, "session", b);
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), [a, b]);

    // Registering the same path replaces the entry (new pid/startedAt); the replaced
    // entry keeps its original position in the manifest (append order).
    await registerWorktree(cwd, "session", { path: "/tmp/wt/a", pid: 333, startedAt: "t2" });
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), [
      b,
      { path: "/tmp/wt/a", pid: 333, startedAt: "t2" },
    ]);

    await unregisterWorktree(cwd, "session", "/tmp/wt/a");
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), [b]);
    // Unregistering an unknown path is a no-op.
    await unregisterWorktree(cwd, "session", "/tmp/wt/a");
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), [b]);
    await unregisterWorktree(cwd, "session", "/tmp/wt/b");
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), []);
    // A different base stays independent.
    assert.deepEqual(await readWorktreeManifest(cwd, "other"), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deleteLoopArtifacts removes every artifact for one base, idempotently, leaving others", async () => {
  const cwd = await sandbox();
  try {
    await appendLoopLog(cwd, "gone", record(1));
    await renderLivingSummary(cwd, "gone", [record(1)]);
    await writeBestPatch(cwd, "gone", "patch text");
    await writeLandedMarker(cwd, "gone", "sha");
    await registerWorktree(cwd, "gone", { path: "/tmp/wt/gone", pid: 1, startedAt: "t" });
    await appendLoopLog(cwd, "stay", record(1));

    await deleteLoopArtifacts(cwd, "gone");
    for (const path of [loopLogPath, loopSummaryPath, loopPatchPath, loopLandedPath]) {
      await assert.rejects(access(path(cwd, "gone")));
    }
    await assert.rejects(access(worktreeRoot(cwd, "gone")));

    // Idempotent, and other bases are untouched.
    await deleteLoopArtifacts(cwd, "gone");
    await deleteLoopArtifacts(cwd, "stay");
    await deleteLoopArtifacts(cwd, "stay");
    assert.deepEqual(await readLoopLog(cwd, "stay"), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sweepLoopWorktrees removes dead-owner worktrees and leaves live-owner ones untouched", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const wtDead = join(root, "wt-dead");
    const wtLive = join(root, "wt-live");
    assert.equal((await createDetachedWorktree(repo, base, wtDead)).ok, true);
    assert.equal((await createDetachedWorktree(repo, base, wtLive)).ok, true);
    await registerWorktree(repo, "session", { path: wtDead, pid: 424242, startedAt: "t0" });
    await registerWorktree(repo, "session", { path: wtLive, pid: process.pid, startedAt: "t1" });
    // Dirty content must not stop the force-removal of the dead owner's worktree...
    await writeFile(join(wtDead, "junk.txt"), "junk\n");
    // ...and the live owner's worktree keeps everything, including its changes.
    await writeFile(join(wtLive, "keep.txt"), "keep\n");

    await sweepLoopWorktrees(repo, (pid) => pid === process.pid);

    await assert.rejects(access(wtDead));
    await access(wtLive);
    assert.equal(await readFile(join(wtLive, "keep.txt"), "utf8"), "keep\n");
    assert.deepEqual(await readWorktreeManifest(repo, "session"), [
      { path: wtLive, pid: process.pid, startedAt: "t1" },
    ]);
    assert.equal(await headCommit(repo), base);

    // A second sweep is a no-op.
    await sweepLoopWorktrees(repo, (pid) => pid === process.pid);
    assert.deepEqual(await readWorktreeManifest(repo, "session"), [
      { path: wtLive, pid: process.pid, startedAt: "t1" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepLoopWorktrees defaults to a process.kill(pid, 0) liveness probe", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const wtDead = join(root, "wt-dead");
    const wtLive = join(root, "wt-live");
    await createDetachedWorktree(repo, base, wtDead);
    await createDetachedWorktree(repo, base, wtLive);
    // 2_000_000_000 exceeds any real pid, so the default probe reports it dead (ESRCH);
    // process.pid is this test process, which is alive.
    await registerWorktree(repo, "session", { path: wtDead, pid: 2_000_000_000, startedAt: "t0" });
    await registerWorktree(repo, "session", { path: wtLive, pid: process.pid, startedAt: "t1" });

    await sweepLoopWorktrees(repo);

    await assert.rejects(access(wtDead));
    await access(wtLive);
    assert.deepEqual(await readWorktreeManifest(repo, "session"), [
      { path: wtLive, pid: process.pid, startedAt: "t1" },
    ]);
    assert.equal(await headCommit(repo), base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepLoopWorktrees with no worktree directory is a no-op", async () => {
  const cwd = await sandbox();
  try {
    await sweepLoopWorktrees(cwd);
    assert.deepEqual(await readWorktreeManifest(cwd, "session"), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
