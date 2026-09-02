/**
 * Plain-git worktree + patch primitives for the implement-experiment loop.
 *
 * HARD INVARIANT (AGENTS.md, architecture.md): this module NEVER runs `git add`, `git commit`,
 * or any other index-mutating command. `git apply` is always called WITHOUT `--index`, so every
 * applied change lands in a working tree only, unstaged.
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

/** `git worktree add --detach <path> <base>` — detached, so the loop creates NO branches. */
export async function createDetachedWorktree(
  cwd: string,
  base: string,
  path: string,
): Promise<GitOutcome> {
  await mkdir(dirname(path), { recursive: true });
  const run = await runGit(cwd, ["worktree", "add", "--detach", path, base]);
  return { ok: run.ok, error: run.ok ? undefined : run.error };
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