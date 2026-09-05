import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { carryUntracked, matchesGlob, readCarried, untrackedPaths } from "../src/carry.js";
import type { WorktreeConfig } from "../src/config.js";
import {
  capturePatch, carryIntoWorktree, changedWorktreePaths, commitAudit,
  commitWorktreeSnapshot, createDetachedWorktree, headCommit,
} from "../src/worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

const carryAll: WorktreeConfig = { carry: "all", carryExclude: [], carryMaxBytes: 10_485_760 };

/** A repository with one tracked file, one gitignored file, and one plain untracked file. */
async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-carry-"));
  await git(cwd, "init", "--initial-branch=main");
  await git(cwd, "config", "user.email", "kanban@example.com");
  await git(cwd, "config", "user.name", "Kanban Test");
  await mkdir(join(cwd, "cluster", "site"), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), "cluster/*/site.env\nignored-dir/\n");
  await writeFile(join(cwd, "cluster", "site", "site.env.example"), "EXAMPLE=1\n");
  await writeFile(join(cwd, "tracked.txt"), "tracked\n");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "base");
  // Present in the checkout, absent from every worktree git would create.
  await writeFile(join(cwd, "cluster", "site", "site.env"), "SECRET_TOKEN=abc\n");
  await writeFile(join(cwd, "scratch.txt"), "untracked but not ignored\n");
  return cwd;
}

async function worktreeAt(repo: string, name: string): Promise<string> {
  const path = join(repo, ".kanban", "worktrees", name);
  const head = await headCommit(repo);
  const created = await createDetachedWorktree(repo, head!, path);
  assert.equal(created.ok, true);
  return path;
}

test("matchesGlob handles exact paths, directories, single and double stars", () => {
  assert.equal(matchesGlob("cluster/site/site.env", "cluster/*/site.env"), true);
  assert.equal(matchesGlob("cluster/a/b/site.env", "cluster/*/site.env"), false);
  assert.equal(matchesGlob("cluster/a/b/site.env", "cluster/**/site.env"), true);
  assert.equal(matchesGlob("evidence/run/log.txt", "evidence"), true);
  assert.equal(matchesGlob("evidence/run/log.txt", "evidence/"), true);
  assert.equal(matchesGlob("evidencia/x", "evidence"), false);
  assert.equal(matchesGlob("a.env", "*.env"), true);
  assert.equal(matchesGlob("dir/a.env", "*.env"), false);
});

test("untrackedPaths lists ignored and plain untracked files but never the heavy trees", async () => {
  const repo = await repository();
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const paths = await untrackedPaths(repo, (cwd, args) =>
    execFileAsync("git", args, { cwd, maxBuffer: 1 << 26 })
      .then(({ stdout }) => ({ ok: true, stdout }))
      .catch((error: Error) => ({ ok: false, stdout: "", error: error.message })));

  assert.ok(paths.includes("cluster/site/site.env"), "the gitignored site profile must be listed");
  assert.ok(paths.includes("scratch.txt"), "plain untracked files must be listed");
  assert.ok(!paths.some((path) => path.startsWith("node_modules/")), "node_modules must never be enumerated");
});

test("carrying copies the gitignored file git worktree add leaves behind", async () => {
  const repo = await repository();
  const worktree = await worktreeAt(repo, "lane-1");

  // The premise: this is exactly why a child reports the file as missing.
  await assert.rejects(stat(join(worktree, "cluster", "site", "site.env")));

  const result = await carryIntoWorktree(repo, worktree, carryAll);
  assert.ok(result.carried.includes("cluster/site/site.env"));
  assert.equal(await readFile(join(worktree, "cluster", "site", "site.env"), "utf8"), "SECRET_TOKEN=abc\n");
  assert.deepEqual(await readCarried(worktree), ["cluster/site/site.env", "scratch.txt"]);
});

test("carried files reach no patch, no snapshot, no audit commit, and no claims check", async () => {
  const repo = await repository();
  const worktree = await worktreeAt(repo, "lane-2");
  await carryIntoWorktree(repo, worktree, carryAll);
  // Work the lane actually did, alongside the carried files.
  await writeFile(join(worktree, "tracked.txt"), "changed by the lane\n");
  await writeFile(join(worktree, "new-work.txt"), "produced by the lane\n");

  const changed = await changedWorktreePaths(worktree);
  assert.deepEqual(changed.sort(), ["new-work.txt", "tracked.txt"],
    "a carried file is not something the lane changed");

  const patch = await capturePatch(worktree, (await headCommit(worktree))!);
  assert.ok(patch.includes("new-work.txt"), "real work must still be captured");
  assert.ok(!patch.includes("site.env"), "a carried secret must never enter a candidate patch");
  assert.ok(!patch.includes("SECRET_TOKEN"));
  assert.ok(!patch.includes("scratch.txt"));
  assert.ok(!patch.includes(".git-kanban-carried"));

  await commitWorktreeSnapshot(worktree);
  const snapshotted = await git(worktree, "show", "--name-only", "--format=", "HEAD");
  assert.ok(!snapshotted.includes("site.env"));
  assert.ok(!snapshotted.includes(".git-kanban-carried"));

  // auditPaths force-adds gitignored evidence; a carried file must not ride along with it.
  const audit = await commitAudit(worktree, repo, "kanban-audit/test", (await headCommit(worktree))!,
    "audit", ["cluster"]);
  assert.equal(audit.ok, true);
  const audited = await git(repo, "show", "--name-only", "--format=", "kanban-audit/test");
  assert.ok(!audited.includes("site.env"), "a carried secret must never reach the audit ref");
});

test("carrying honors none, an explicit list, the size cap, and never overwrites tracked content", async () => {
  const repo = await repository();
  await writeFile(join(repo, "big.bin"), "x".repeat(4096));

  const none = await carryIntoWorktree(repo, await worktreeAt(repo, "lane-none"),
    { carry: "none", carryExclude: [], carryMaxBytes: 10_485_760 });
  assert.deepEqual(none.carried, []);

  const listed = await carryIntoWorktree(repo, await worktreeAt(repo, "lane-list"),
    { carry: ["cluster/*/site.env"], carryExclude: [], carryMaxBytes: 10_485_760 });
  assert.deepEqual(listed.carried, ["cluster/site/site.env"]);

  const capped = await carryIntoWorktree(repo, await worktreeAt(repo, "lane-cap"),
    { carry: "all", carryExclude: [], carryMaxBytes: 100 });
  assert.ok(!capped.carried.includes("big.bin"));
  assert.ok(capped.skipped.some((entry) => entry.path === "big.bin" && entry.bytes === 4096));

  const excluded = await carryIntoWorktree(repo, await worktreeAt(repo, "lane-exclude"),
    { carry: "all", carryExclude: ["cluster/**"], carryMaxBytes: 10_485_760 });
  assert.ok(!excluded.carried.includes("cluster/site/site.env"));

  // A tracked file already in the checkout is authoritative and must survive carrying.
  const worktree = await worktreeAt(repo, "lane-keep");
  await writeFile(join(repo, "tracked.txt"), "checkout edit that must not leak\n");
  await carryIntoWorktree(repo, worktree, carryAll);
  assert.equal(await readFile(join(worktree, "tracked.txt"), "utf8"), "tracked\n");
});

test("carrying tolerates a caller that predates the worktree config block", async () => {
  const repo = await repository();
  const worktree = await worktreeAt(repo, "lane-default");
  const result = await carryUntracked(repo, worktree, undefined, (cwd, args) =>
    execFileAsync("git", args, { cwd, maxBuffer: 1 << 26 })
      .then(({ stdout }) => ({ ok: true, stdout }))
      .catch((error: Error) => ({ ok: false, stdout: "", error: error.message })));
  assert.ok(result.carried.includes("cluster/site/site.env"),
    "an absent config must fall back to the documented default, not to carrying nothing");
});
