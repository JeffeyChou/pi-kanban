import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyPatch,
  capturePatch,
  commitAudit,
  commitExperiment,
  createDetachedWorktree,
  ensureExperimentBranch,
  experimentBranchHead,
  headCommit,
  landPatch,
  modifiedTrackedFiles,
  patchStat,
  patchBetweenCommits,
  removeWorktreeForce,
  stageExperimentRange,
} from "../src/worktree.js";

const execFileAsync = promisify(execFile);

/** Run real git in tests (test setup is allowed to stage/commit — the module under test is not). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/** Exit-code probe: true when the git command exits 0. */
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, [
    "-c", "user.email=test@test",
    "-c", "user.name=test",
    "commit", "-q", "-m", message,
  ]);
}

interface Repo {
  root: string;
  repo: string;
  base: string;
}

/** A real git repository with a base commit, including a binary file and odd filenames. */
async function makeRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "kanban-wt-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-q"]);
  await writeFile(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "delete-me.txt"), "bye\n");
  await writeFile(join(repo, "odd name.txt"), "odd\n");
  await writeFile(join(repo, "line\nbreak.txt"), "split\n");
  await writeFile(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]));
  await commitAll(repo, "base");
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { root, repo, base };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The module must never stage anything or move HEAD. */
async function assertIndexEmptyAndHead(repo: string, expectedHead: string): Promise<void> {
  assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet"]), true, "index must stay empty");
  assert.equal((await git(repo, ["rev-parse", "HEAD"])).trim(), expectedHead, "HEAD must not move");
}

test("headCommit returns the HEAD sha, and undefined outside a repository", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    assert.equal(await headCommit(repo), base);
    await mkdir(join(root, "empty"));
    assert.equal(await headCommit(join(root, "empty")), undefined);
    assert.equal(await headCommit(join(root, "missing")), undefined);
  } finally {
    await cleanup(root);
  }
});

test("modifiedTrackedFiles reports only tracked changes, staged or unstaged", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    // Untracked files are deliberately NOT reported.
    await writeFile(join(repo, "untracked.txt"), "u\n");
    assert.deepEqual(await modifiedTrackedFiles(repo), []);

    // Unstaged modification of a tracked file.
    await writeFile(join(repo, "tracked.txt"), "ONE\ntwo\nthree\n");
    assert.deepEqual(await modifiedTrackedFiles(repo), ["tracked.txt"]);

    // Staged modification is still reported (once).
    await git(repo, ["add", "tracked.txt"]);
    assert.deepEqual(await modifiedTrackedFiles(repo), ["tracked.txt"]);

    // Staged rename reports the destination path.
    await git(repo, ["mv", "tracked.txt", "renamed.txt"]);
    assert.deepEqual(await modifiedTrackedFiles(repo), ["renamed.txt"]);

    // A file with a newline in its name survives the NUL-separated listing.
    await writeFile(join(repo, "line\nbreak.txt"), "split again\n");
    assert.deepEqual(await modifiedTrackedFiles(repo), ["line\nbreak.txt", "renamed.txt"]);

    // This test stages files as setup, so only HEAD immobility is asserted here.
    assert.equal(await headCommit(repo), base);
  } finally {
    await cleanup(root);
  }
});

test("createDetachedWorktree creates a worktree that is NOT on a branch", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    // Deep, not-yet-existing parents; git gets them created.
    const wt = join(root, "wts", "deep", "nested", "session-wt");
    const outcome = await createDetachedWorktree(repo, base, wt);
    assert.equal(outcome.ok, true, outcome.error);
    // git reports canonicalized paths (e.g. /private/var/... on macOS), so compare realpaths.
    const canonicalWt = await realpath(wt);
    assert.match(
      await git(repo, ["worktree", "list", "--porcelain"]),
      new RegExp(`worktree ${escapeRegExp(canonicalWt)}`),
    );
    assert.equal((await git(wt, ["rev-parse", "HEAD"])).trim(), base);
    // No branch: symbolic-ref -q HEAD fails.
    assert.equal(await gitOk(wt, ["symbolic-ref", "-q", "HEAD"]), false, "HEAD must be detached");
    assert.equal(await gitOk(wt, ["diff", "--quiet"]), true, "fresh worktree is clean");
    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("applyPatch produces UNSTAGED changes; empty patches are no-ops; garbage fails", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const donor = join(root, "donor");
    await createDetachedWorktree(repo, base, donor);
    await writeFile(join(donor, "tracked.txt"), "uno\ndue\ntre\n");
    // The raw diff output (trailing newline intact) is the patch text.
    const patch = await git(donor, ["diff"]);

    const target = join(root, "target");
    await createDetachedWorktree(repo, base, target);
    const outcome = await applyPatch(target, patch);
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(await readFile(join(target, "tracked.txt"), "utf8"), "uno\ndue\ntre\n");
    assert.equal(await gitOk(target, ["diff", "--cached", "--quiet"]), true, "apply must not stage");
    assert.equal(await gitOk(target, ["diff", "--quiet"]), false, "working tree must differ");

    // Empty and whitespace-only patches are no-op successes.
    assert.deepEqual(await applyPatch(target, ""), { ok: true });
    assert.deepEqual(await applyPatch(target, "\n  \n"), { ok: true });
    assert.equal(await gitOk(target, ["diff", "--quiet"]), false);

    // A malformed patch fails with git's error text and leaves the tree untouched.
    const before = await readFile(join(target, "tracked.txt"), "utf8");
    const bad = await applyPatch(target, "this is not a patch\n");
    assert.equal(bad.ok, false);
    assert.ok(bad.error !== undefined && bad.error.length > 0, "failure must carry git error text");
    assert.equal(await readFile(join(target, "tracked.txt"), "utf8"), before);

    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("capturePatch round-trips tracked, new, dash-named, spaced, empty and binary files", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const wt1 = join(root, "wt1");
    await createDetachedWorktree(repo, base, wt1);
    await writeFile(join(wt1, "tracked.txt"), "uno\ndue\ntre\nquattro\n");
    await mkdir(join(wt1, "sub"));
    await writeFile(join(wt1, "sub", "new.txt"), "brand new\n");
    await writeFile(join(wt1, "-dash.txt"), "dash\n");
    await writeFile(join(wt1, "with space.txt"), "space\n");
    await writeFile(join(wt1, "empty.txt"), "");
    await rm(join(wt1, "delete-me.txt"));
    await writeFile(join(wt1, "blob.bin"), Buffer.from([255, 254, 253, 0, 1, 2, 3]));

    const patch = await capturePatch(wt1, base);
    assert.ok(patch.length > 0, "captured patch must not be empty");
    assert.doesNotMatch(patch, /a\/\.\//, "no ./ prefix on paths");

    const wt2 = join(root, "wt2");
    await createDetachedWorktree(repo, base, wt2);
    const applied = await applyPatch(wt2, patch);
    assert.equal(applied.ok, true, applied.error);

    // Byte-identical content after capture-then-apply.
    assert.equal(await readFile(join(wt2, "tracked.txt"), "utf8"), "uno\ndue\ntre\nquattro\n");
    assert.equal(await readFile(join(wt2, "sub", "new.txt"), "utf8"), "brand new\n");
    assert.equal(await readFile(join(wt2, "-dash.txt"), "utf8"), "dash\n");
    assert.equal(await readFile(join(wt2, "with space.txt"), "utf8"), "space\n");
    assert.equal(await readFile(join(wt2, "empty.txt"), "utf8"), "");
    assert.deepEqual(
      await readFile(join(wt2, "blob.bin")),
      Buffer.from([255, 254, 253, 0, 1, 2, 3]),
    );
    await assert.rejects(access(join(wt2, "delete-me.txt")));
    assert.equal(
      await gitOk(wt2, ["diff", "--cached", "--quiet"]),
      true,
      "apply must not stage",
    );

    // Capture is a pure function of worktree state: re-capturing the re-applied state
    // yields the identical patch stream.
    assert.equal(await capturePatch(wt2, base), patch);

    // An unchanged worktree captures as "".
    const wt3 = join(root, "wt3");
    await createDetachedWorktree(repo, base, wt3);
    assert.equal(await capturePatch(wt3, base), "");

    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("landPatch lands unstaged into a clean tree and fails atomically on conflict", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const wt = join(root, "wt");
    await createDetachedWorktree(repo, base, wt);
    await writeFile(join(wt, "tracked.txt"), "uno\ndue\ntre\n");
    await writeFile(join(wt, "sub.txt"), "new\n");
    const patch = await capturePatch(wt, base);
    assert.ok(patch.length > 0);

    const landed = await landPatch(repo, patch);
    assert.equal(landed.ok, true, landed.error);
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "uno\ndue\ntre\n");
    assert.equal(await readFile(join(repo, "sub.txt"), "utf8"), "new\n");
    assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet"]), true, "landing must not stage");
    assert.equal(await gitOk(repo, ["diff", "--quiet"]), false, "landing must change the tree");
    assert.equal(await headCommit(repo), base);

    // Conflicting patch: the user's tree no longer matches the patch's base, so the apply
    // fails and `git apply`'s atomicity leaves the tree exactly as it was.
    await writeFile(join(repo, "tracked.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    const conflicting = await landPatch(repo, patch);
    assert.equal(conflicting.ok, false);
    assert.ok(
      conflicting.error !== undefined && conflicting.error.length > 0,
      "conflict must carry git error text",
    );
    assert.equal(
      await readFile(join(repo, "tracked.txt"), "utf8"),
      "one\ntwo\nthree\nfour\nfive\n",
      "failed apply must leave the tree untouched",
    );
    assert.equal(await git(repo, ["status", "--porcelain"]), statusBefore);
    assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet"]), true);

    // An empty patch is a no-op success.
    assert.deepEqual(await landPatch(repo, "\n"), { ok: true });
    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("removeWorktreeForce removes a DIRTY worktree, prunes the admin entry, and is idempotent", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const wt = join(root, "wt");
    await createDetachedWorktree(repo, base, wt);
    const canonicalWt = await realpath(wt);
    await writeFile(join(wt, "junk.txt"), "dirty\n");
    await writeFile(join(wt, "tracked.txt"), "changed\n");

    const removed = await removeWorktreeForce(repo, wt);
    assert.equal(removed.ok, true, removed.error);
    await assert.rejects(access(wt));
    assert.doesNotMatch(
      await git(repo, ["worktree", "list", "--porcelain"]),
      new RegExp(`worktree ${escapeRegExp(canonicalWt)}`),
    );
    // The .git/worktrees/ admin entry is pruned.
    const leftovers = await readdir(join(repo, ".git", "worktrees")).catch(() => [] as string[]);
    assert.deepEqual(leftovers, []);

    // Idempotent: an already-missing worktree and a never-registered path are both success.
    assert.equal((await removeWorktreeForce(repo, wt)).ok, true);
    assert.equal((await removeWorktreeForce(repo, join(root, "never-existed"))).ok, true);
    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("patchStat summarizes a patch without touching the tree", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    assert.equal(await patchStat(repo, ""), "");
    const wt = join(root, "wt");
    await createDetachedWorktree(repo, base, wt);
    await writeFile(join(wt, "tracked.txt"), "uno\ndue\ntre\n");
    const patch = await capturePatch(wt, base);
    const stat = await patchStat(repo, patch);
    assert.match(stat, /tracked\.txt/);
    assert.match(stat, /\|/);
    // --stat only prints; the tree is untouched.
    assert.equal(await gitOk(repo, ["diff", "--quiet"]), true);
    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("accepted experiments commit only on their private branch and stage only their final paths", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const branch = "kanban-autoresearch/session";
    assert.equal((await ensureExperimentBranch(repo, branch, base)).ok, true);
    const worktree = join(root, "experiment");
    assert.equal((await createDetachedWorktree(repo, base, worktree)).ok, true);
    await writeFile(join(worktree, "tracked.txt"), "accepted\n");
    await writeFile(join(worktree, "accepted.txt"), "new\n");
    const committed = await commitExperiment(worktree, repo, branch, "kanban-autoresearch: accepted");
    assert.equal(committed.ok, true, committed.error);
    assert.ok(committed.commit);
    assert.equal(await experimentBranchHead(repo, branch), committed.commit);
    assert.equal(await headCommit(repo), base, "the user checkout must never be committed by a candidate");
    const patch = await patchBetweenCommits(repo, base, committed.commit!);
    assert.match(patch, /accepted\.txt/);
    assert.equal((await landPatch(repo, patch)).ok, true);
    await writeFile(join(repo, "unrelated.txt"), "leave unstaged\n");
    assert.equal((await stageExperimentRange(repo, base, committed.commit!)).ok, true);
    assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet", "--", "tracked.txt"]), false);
    assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet", "--", "accepted.txt"]), false);
    assert.equal(await gitOk(repo, ["diff", "--cached", "--quiet", "--", "unrelated.txt"]), true);
  } finally {
    await cleanup(root);
  }
});

test("the worktree module never issues git add/commit/stash/reset/checkout or --index/--cached", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    const realGit = (await execFileAsync("which", ["git"])).stdout.trim();
    const shimDir = join(root, "shim");
    await mkdir(shimDir);
    const logPath = join(root, "git-argv.log");
    process.env.SHIM_LOG = logPath;
    const shim = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SHIM_LOG"',
      "sub=",
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    -*) ;;',
      '    *) sub="$arg"; break ;;',
      "  esac",
      "done",
      'case "$sub" in',
      "  add|commit|stash|reset|checkout|rm|clean|switch|restore)",
      '    printf \'forbidden subcommand: %s\\n\' "$*" >&2',
      "    exit 99",
      "    ;;",
      // The invariant bans --index/--cached on `git apply` specifically; read-only
      // commands like `git diff --cached` are legitimate module behavior.
      "  apply)",
      '    for arg in "$@"; do',
      '      case "$arg" in',
      "        --index|--cached)",
      '          printf \'forbidden apply option: %s\\n\' "$*" >&2',
      "          exit 99",
      "          ;;",
      "      esac",
      "    done",
      "    ;;",
      "esac",
      `exec ${realGit} "$@"`,
      "",
    ].join("\n");
    await writeFile(join(shimDir, "git"), shim);
    await chmod(join(shimDir, "git"), 0o755);

    const priorPath = process.env.PATH ?? "";
    process.env.PATH = `${shimDir}:${priorPath}`;
    try {
      assert.equal(await headCommit(repo), base);
      assert.deepEqual(await modifiedTrackedFiles(repo), []);
      const wt = join(root, "shimwt");
      const created = await createDetachedWorktree(repo, base, wt);
      assert.equal(created.ok, true, created.error);
      await writeFile(join(wt, "tracked.txt"), "shimmed\n");
      const patch = await capturePatch(wt, base);
      assert.ok(patch.length > 0);
      const landed = await landPatch(repo, patch);
      assert.equal(landed.ok, true, landed.error);
      assert.match(await patchStat(repo, patch), /tracked\.txt/);
      assert.deepEqual(await applyPatch(wt, ""), { ok: true });
      const removed = await removeWorktreeForce(repo, wt);
      assert.equal(removed.ok, true, removed.error);
    } finally {
      process.env.PATH = priorPath;
    }

    const log = await readFile(logPath, "utf8");
    const lines = log.trim().split("\n");
    assert.ok(lines.length > 0, "the shim must have intercepted git calls");
    const forbidden = ["add", "commit", "stash", "reset", "checkout", "rm", "clean", "switch", "restore"];
    for (const line of lines) {
      const args = line.split(" ");
      const subcommand = args.find((arg) => !arg.startsWith("-"));
      assert.ok(subcommand !== undefined, `malformed shim line: ${line}`);
      assert.ok(!forbidden.includes(subcommand), `forbidden git subcommand: ${line}`);
      if (subcommand === "apply") {
        assert.ok(
          !args.includes("--index") && !args.includes("--cached"),
          `git apply must never touch the index: ${line}`,
        );
      }
    }
    await assertIndexEmptyAndHead(repo, base);
  } finally {
    await cleanup(root);
  }
});

test("commitAudit snapshots every attempt on its own ref, force-adding ignored evidence", async () => {
  const { root, repo, base } = await makeRepo();
  try {
    // commit-tree needs a committer identity, exactly as commitExperiment's commit does.
    await git(repo, ["config", "user.email", "audit@test"]);
    await git(repo, ["config", "user.name", "audit"]);
    const worktree = join(root, "wt");
    assert.equal((await createDetachedWorktree(repo, base, worktree)).ok, true);

    // The candidate change, plus measurement evidence under a gitignored path.
    await writeFile(join(worktree, ".gitignore"), "evidence/\n");
    await writeFile(join(worktree, "tracked.txt"), "one\ntwo\nthree\nfour\n");
    await mkdir(join(worktree, "evidence"), { recursive: true });
    await writeFile(join(worktree, "evidence", "gate.log"), "job 42 REJECTED\n");

    const audited = await commitAudit(
      worktree,
      repo,
      "kanban-audit/session",
      base,
      "kanban-audit: iteration 1, discard",
      ["evidence", "no-such-path"],
    );
    assert.equal(audited.ok, true);
    assert.ok(audited.commit);
    assert.deepEqual(audited.unmatched, ["no-such-path"], "a pathspec with no files is not a failure");
    assert.equal(
      (await git(repo, ["rev-parse", "refs/heads/kanban-audit/session"])).trim(),
      audited.commit,
      "the audit ref points at the snapshot",
    );
    assert.equal(
      (await git(worktree, ["rev-parse", "HEAD"])).trim(),
      base,
      "commit-tree must not move the worktree HEAD",
    );
    assert.equal(
      await git(repo, ["show", `${audited.commit}:evidence/gate.log`]),
      "job 42 REJECTED\n",
      "ignored evidence reaches the audit commit",
    );
    assert.match(await git(repo, ["show", `${audited.commit}:tracked.txt`]), /four/);
    assert.equal(
      await gitOk(worktree, ["diff", "--cached", "--quiet"]),
      true,
      "the index is restored, so commitExperiment still sees its own staging",
    );

    // The accepted commit must stay clean: gitignored evidence belongs to the audit ref only.
    const accepted = await commitExperiment(worktree, repo, "kanban-autoresearch/session", "kept");
    assert.equal(accepted.ok, true);
    assert.equal(
      await gitOk(repo, ["cat-file", "-e", `${accepted.commit}:evidence/gate.log`]),
      false,
      "the accepted experiment commit carries no measurement evidence",
    );
    assert.match(await git(repo, ["show", `${accepted.commit}:tracked.txt`]), /four/);
  } finally {
    await cleanup(root);
  }
});
