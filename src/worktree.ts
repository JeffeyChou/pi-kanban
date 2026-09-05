/**
 * Plain-git worktree + patch primitives for the implement-experiment loop.
 *
 * The normal patch primitives remain index-free. The autoresearch loop additionally owns an
 * isolated `kanban-autoresearch/<base>` ref: it may stage and commit **only inside a disposable
 * detached iteration worktree**, never in the user's checkout. Landing into the checkout still
 * uses `git apply` without `--index`; final-session staging is a separate, explicit lifecycle
 * action.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface GitOutcome {
  ok: boolean;
  /** Combined stderr/stdout on failure. */
  error?: string;
}

interface GitRun extends GitOutcome {
  stdout: string;
  /** Process exit code; null when git could not be started. */
  code: number | null;
}

/**
 * Run git with an argv array (never a shell string, never a path interpolated into a command).
 * Resolves with an outcome object; does not throw on a non-zero exit.
 */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, code: 0, stdout, error: undefined });
          return;
        }
        const errno = error as NodeJS.ErrnoException;
        resolve({
          ok: false,
          code: typeof errno.code === "number" ? errno.code : null,
          stdout,
          error: (stderr || errno.message).trim(),
        });
      },
    );
  });
}

/**
 * Run git with `input` written to the child's stdin (used for `git apply`: patch text never
 * goes on a command line and never requires a temp file).
 */
function runGitStdin(cwd: string, args: string[], input: string): Promise<GitRun> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (outcome: GitRun) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout, error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, code: 0, stdout, error: undefined });
      else finish({ ok: false, code, stdout, error: (stderr || stdout).trim() });
    });
    // git may exit before consuming stdin (e.g. a rejected patch); ignore the EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** `git rev-parse HEAD`; undefined when the command fails (no commits, not a repo). */
export async function headCommit(cwd: string): Promise<string | undefined> {
  const run = await runGit(cwd, ["rev-parse", "HEAD"]);
  return run.ok ? run.stdout.trim() : undefined;
}

/**
 * Preflight: paths of MODIFIED TRACKED files in `cwd` (staged or unstaged). Untracked files
 * are deliberately NOT reported — they are permitted and left untouched.
 */
export async function modifiedTrackedFiles(cwd: string): Promise<string[]> {
  const stale = await runGit(cwd, ["diff", "--name-only", "-z"]);
  if (!stale.ok) throw new Error(`git diff --name-only failed: ${stale.error}`);
  const staged = await runGit(cwd, ["diff", "--cached", "--name-only", "-z"]);
  if (!staged.ok) throw new Error(`git diff --cached --name-only failed: ${staged.error}`);
  // The -z form keeps unusual filenames (spaces, newlines, quotes) intact; renames report
  // their destination path.
  const names = new Set<string>();
  for (const name of stale.stdout.split("\0")) if (name !== "") names.add(name);
  for (const name of staged.stdout.split("\0")) if (name !== "") names.add(name);
  return [...names].sort();
}

/** `git worktree add --detach <path> <base>` — disposable candidate worktrees remain detached;
 * accepted commits are published afterward through the private experiment ref. */
export async function createDetachedWorktree(
  cwd: string,
  base: string,
  path: string,
): Promise<GitOutcome> {
  await mkdir(dirname(path), { recursive: true });
  const run = await runGit(cwd, ["worktree", "add", "--detach", path, base]);
  return { ok: run.ok, error: run.ok ? undefined : run.error };
}

/** Make an immutable source identity in a private detached worktree, without publishing it. */
export async function commitWorktreeSnapshot(cwd: string): Promise<string> {
  if (!cwd.includes("/.kanban/worktrees/")) throw new Error("Snapshots require a private Kanban worktree");
  if ((await runGit(cwd, ["symbolic-ref", "--quiet", "HEAD"])).ok)
    throw new Error("Snapshots require detached HEAD");
  const parent = await headCommit(cwd);
  const added = await runGit(cwd, ["add", "-A"]);
  if (!added.ok || !parent) throw new Error(added.error ?? "Snapshot parent is missing");
  const tree = await runGit(cwd, ["write-tree"]);
  if (!tree.ok) throw new Error(tree.error);
  const commit = await runGitStdin(cwd, ["commit-tree", tree.stdout.trim(), "-p", parent], "Kanban private source snapshot\n");
  if (!commit.ok) throw new Error(commit.error);
  const moved = await runGit(cwd, ["update-ref", "HEAD", commit.stdout.trim(), parent]);
  if (!moved.ok) throw new Error(moved.error);
  return commit.stdout.trim();
}

/** Copy source changes into a separate snapshot BEFORE any validation command can mutate it. */
export async function snapshotWorktree(main: string, source: string, destination: string): Promise<string> {
  const head = await headCommit(source);
  if (!head) throw new Error("Source worktree has no HEAD");
  const patch = await capturePatch(source, head);
  const opened = await createDetachedWorktree(main, head, destination);
  if (!opened.ok) throw new Error(opened.error);
  try {
    if (patch.trim()) {
      const applied = await landPatch(destination, patch);
      if (!applied.ok) throw new Error(applied.error);
    }
    return await commitWorktreeSnapshot(destination);
  } catch (error) {
    await removeWorktreeForce(main, destination);
    throw error;
  }
}

export async function changedWorktreePaths(cwd: string): Promise<string[]> {
  const tracked = await runGit(cwd, ["diff", "--name-only", "-z", "HEAD"]);
  const added = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!tracked.ok || !added.ok) throw new Error(tracked.error ?? added.error);
  return [...new Set((tracked.stdout + added.stdout).split("\0").filter(Boolean))];
}

/** Ensure the durable private experiment branch exists at `base`. */
export async function ensureExperimentBranch(
  cwd: string,
  branch: string,
  base: string,
): Promise<GitOutcome> {
  const existing = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.ok) return { ok: true };
  const created = await runGit(cwd, ["branch", branch, base]);
  return { ok: created.ok, error: created.ok ? undefined : created.error };
}

/** Read an experiment branch's commit, or undefined when the ref no longer exists. */
export async function experimentBranchHead(cwd: string, branch: string): Promise<string | undefined> {
  const run = await runGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  return run.ok ? run.stdout.trim() : undefined;
}

export interface ExperimentCommitOutcome extends GitOutcome {
  commit?: string;
}

/**
 * Commit one accepted experiment in its detached worktree, then advance the durable branch ref.
 * This is intentionally the only loop code path that mutates a Git index. The user's checkout is
 * never its cwd, and rejected candidates never reach this function.
 */
export async function commitExperiment(
  worktreeCwd: string,
  mainCwd: string,
  branch: string,
  message: string,
): Promise<ExperimentCommitOutcome> {
  const added = await runGit(worktreeCwd, ["add", "-A"]);
  if (!added.ok) return { ok: false, error: added.error };
  const committed = await runGit(worktreeCwd, ["commit", "-m", message]);
  if (!committed.ok) return { ok: false, error: committed.error };
  const commit = await headCommit(worktreeCwd);
  if (!commit) return { ok: false, error: "git commit succeeded but HEAD could not be resolved" };
  const advanced = await runGit(mainCwd, ["branch", "-f", branch, commit]);
  if (!advanced.ok) return { ok: false, error: advanced.error };
  return { ok: true, commit };
}

export interface AuditCommitOutcome extends GitOutcome {
  commit?: string;
  /** Pathspecs that produced no files; informational, never a failure. */
  unmatched?: string[];
}

/**
 * Snapshot the worktree as ONE audit commit on `ref`, whatever the iteration's decision was.
 *
 * This is the durable evidence seam for measurements whose output cannot be reproduced later —
 * a scheduler job log, a captured run directory. The worktree files are disposable, so the
 * snapshot is the only thing that survives; `ref` accumulates a linear log of every attempt,
 * including rejected ones, and it is deliberately NOT the accepted-experiment branch.
 *
 * `forcePaths` pathspecs are force-added, so measurement evidence may sit under a gitignored
 * path and therefore stay out of the accepted commit and out of the landed patch. The index is
 * restored to HEAD afterwards, so this never changes what `commitExperiment` would commit, and
 * `git commit-tree` leaves HEAD and the branch refs alone.
 */
export async function commitAudit(
  worktreeCwd: string,
  mainCwd: string,
  ref: string,
  parent: string,
  message: string,
  forcePaths: string[] = [],
): Promise<AuditCommitOutcome> {
  const restoreIndex = async () => {
    await runGit(worktreeCwd, ["reset", "--quiet"]);
  };
  try {
    const added = await runGit(worktreeCwd, ["add", "-A"]);
    if (!added.ok) return { ok: false, error: added.error };
    const unmatched: string[] = [];
    for (const path of forcePaths) {
      // One pathspec at a time: an evidence directory a given iteration never wrote is normal,
      // and must not discard the evidence the other pathspecs did produce.
      const forced = await runGit(worktreeCwd, ["add", "-A", "-f", "--", path]);
      if (!forced.ok) unmatched.push(path);
    }
    const tree = await runGit(worktreeCwd, ["write-tree"]);
    if (!tree.ok) return { ok: false, error: tree.error };
    const created = await runGit(worktreeCwd, [
      "commit-tree",
      tree.stdout.trim(),
      "-p",
      parent,
      "-m",
      message,
    ]);
    if (!created.ok) return { ok: false, error: created.error };
    const commit = created.stdout.trim();
    if (!commit) return { ok: false, error: "git commit-tree produced no commit id" };
    const published = await runGit(mainCwd, ["update-ref", `refs/heads/${ref}`, commit]);
    if (!published.ok) return { ok: false, error: published.error };
    return { ok: true, commit, ...(unmatched.length ? { unmatched } : {}) };
  } finally {
    await restoreIndex();
  }
}

/** Binary patch of all accepted experiment commits from `base` through `commit`. */
export async function patchBetweenCommits(
  cwd: string,
  base: string,
  commit: string,
): Promise<string> {
  const run = await runGit(cwd, ["diff", "--binary", base, commit]);
  if (!run.ok) throw new Error(`git diff --binary ${base} ${commit} failed: ${run.error}`);
  return run.stdout.trim() === "" ? "" : run.stdout;
}

/**
 * Stage precisely the paths changed by accepted experiment commits, including deletions. This
 * intentionally never stages the whole checkout: unrelated user work outside the experiment
 * range remains untouched in the index.
 */
export async function stageExperimentRange(
  cwd: string,
  base: string,
  commit: string,
): Promise<GitOutcome> {
  const changed = await runGit(cwd, ["diff", "--name-only", "-z", base, commit]);
  if (!changed.ok) return { ok: false, error: changed.error };
  const paths = changed.stdout.split("\0").filter(Boolean);
  if (!paths.length) return { ok: true };
  const staged = await runGit(cwd, ["add", "-A", "--", ...paths]);
  return { ok: staged.ok, error: staged.ok ? undefined : staged.error };
}

async function applyViaStdin(cwd: string, args: string[], patch: string): Promise<GitOutcome> {
  if (patch.trim() === "") return { ok: true };
  const run = await runGitStdin(cwd, args, patch);
  return { ok: run.ok, error: run.ok ? undefined : run.error };
}

/**
 * `git apply --binary` (NO `--index`) of `patch` text via stdin. Working tree only, unstaged.
 * An empty/whitespace patch is a no-op success.
 */
export async function applyPatch(cwd: string, patch: string): Promise<GitOutcome> {
  return applyViaStdin(cwd, ["apply", "--binary"], patch);
}

/**
 * The complete, `git add`-free candidate capture: tracked changes
 * (`git diff --binary <base>`) concatenated with a synthesized new-file patch per untracked
 * path (`git diff --no-index --binary -- /dev/null <file>`, NUL-safe listing, no `./` prefix).
 * Returns "" when the worktree is identical to `base`.
 */
export async function capturePatch(worktreeCwd: string, base: string): Promise<string> {
  const tracked = await runGit(worktreeCwd, ["diff", "--binary", base]);
  if (!tracked.ok) throw new Error(`git diff --binary ${base} failed: ${tracked.error}`);
  const untracked = await runGit(worktreeCwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!untracked.ok) throw new Error(`git ls-files --others failed: ${untracked.error}`);

  const parts: string[] = [];
  if (tracked.stdout.trim() !== "") parts.push(tracked.stdout);
  for (const file of untracked.stdout.split("\0")) {
    // Skip the trailing empty field and collapsed directory entries (`dir/`).
    if (file === "" || file.endsWith("/")) continue;
    const added = await runGit(worktreeCwd, [
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      file,
    ]);
    // Exit 1 is "differs" — the expected success case for a new file; exit 0 means the file
    // is empty but still yields a valid new-file patch. Anything else is a real failure.
    if (!added.ok && added.code !== 1) {
      throw new Error(`git diff --no-index ${file} failed: ${added.error}`);
    }
    if (added.stdout.trim() !== "") parts.push(added.stdout);
  }
  const patch = parts.join("\n");
  return patch.trim() === "" ? "" : patch;
}

/**
 * `git worktree remove --force <path>` + `git worktree prune`. Loop worktrees are disposable
 * scaffolding whose contents were already captured, so `--force` is the correct discard here.
 * Idempotent: a missing worktree is success.
 */
export async function removeWorktreeForce(cwd: string, path: string): Promise<GitOutcome> {
  const removal = await runGit(cwd, ["worktree", "remove", "--force", path]);
  const prune = await runGit(cwd, ["worktree", "prune"]);
  if (removal.ok || /is not a working tree/.test(removal.error ?? "")) {
    return { ok: prune.ok, error: prune.ok ? undefined : prune.error };
  }
  return { ok: false, error: removal.error };
}

/**
 * Land the best patch into the user's working tree: `git apply --binary` (NO `--index`), so the
 * result is UNCOMMITTED and UNSTAGED. `git apply` is atomic per invocation — a conflicting patch
 * leaves the tree untouched and returns `ok: false`.
 */
export async function landPatch(mainCwd: string, patch: string): Promise<GitOutcome> {
  return applyViaStdin(mainCwd, ["apply", "--binary"], patch);
}

/** `git diff --stat` of a patch text (for the iteration record); "" when the patch is empty. */
export async function patchStat(cwd: string, patch: string): Promise<string> {
  if (patch.trim() === "") return "";
  const run = await runGitStdin(cwd, ["apply", "--stat"], patch);
  return run.stdout.trim();
}
