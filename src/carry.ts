/**
 * Copy untracked files from the user's checkout into a private child worktree.
 *
 * A worktree is `git worktree add`, which checks out tracked files at a commit and nothing else.
 * A gitignored site profile, a local `.env`, a credentials file the work genuinely needs — none of
 * them exist in the child's cwd. The child has no shell, so it cannot look one directory up and
 * cannot even tell the difference between "this file is missing" and "this file is not here";
 * it reports the file as absent, which is true and useless.
 *
 * Carried files are recorded so every `git add`/`ls-files` site can exclude them. That exclusion
 * is not a nicety: without it, carrying a file would fold it into candidate patches, audit
 * commits and the `claims` guard, and a gitignored secret would be committed by the very
 * mechanism meant to make it readable.
 */
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { DEFAULT_WORKTREE, type WorktreeConfig } from "./config.js";

/**
 * Never carried, whatever the configuration says. `.git` and `.kanban` would corrupt the
 * worktree's own administration; the rest are build and dependency trees whose size makes copying
 * them into every lane worktree ruinous, and which a child can always rebuild.
 */
const ALWAYS_EXCLUDED = [
  ".git", ".kanban", "node_modules", "__pycache__", ".venv", "venv",
  "target", "dist", "build", ".mypy_cache", ".pytest_cache", ".tox",
];

export interface CarryResult {
  /** Repository-relative paths actually copied. */
  carried: string[];
  /** Paths skipped for size, with their byte counts, so the operator can see what was left out. */
  skipped: Array<{ path: string; bytes: number }>;
}

/** Where a worktree records what was carried into it. */
function manifestPath(worktree: string): string {
  return join(worktree, ".git-kanban-carried");
}

/**
 * Match a repository-relative path against a glob. Supports `*` (within a segment), `**` (across
 * segments) and a trailing `/` or bare directory name meaning "everything under it".
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const clean = pattern.replace(/\/+$/, "");
  if (!clean) return false;
  if (path === clean || path.startsWith(`${clean}/`)) return true;
  const source = clean
    .split("**")
    .map((part) => part.split("*").map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}(?:/.*)?$`).test(path);
}

function excluded(path: string, extra: string[]): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => ALWAYS_EXCLUDED.includes(segment))) return true;
  return extra.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Paths git considers untracked in `repo`, ignored ones included.
 *
 * Both listings are needed: `--exclude-standard` alone omits exactly the gitignored files that
 * motivate carrying, and `--ignored` alone omits ordinary untracked work in progress.
 */
export async function untrackedPaths(
  repo: string,
  run: (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; error?: string }>,
  extraExclude: string[] = [],
): Promise<string[]> {
  // Exclude the heavy trees in git rather than after. `--ignored` in a repository with an
  // installed `node_modules` otherwise enumerates tens of thousands of paths on every single
  // worktree creation, all of them destined to be filtered out anyway.
  const scope = ["--", ".",
    ...ALWAYS_EXCLUDED.map((name) => `:(exclude)**/${name}/**`),
    ...ALWAYS_EXCLUDED.map((name) => `:(exclude)${name}/**`),
    ...extraExclude.map((pattern) => `:(exclude)${pattern}`)];
  const listings = await Promise.all([
    run(repo, ["ls-files", "--others", "--exclude-standard", "-z", ...scope]),
    run(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", ...scope]),
  ]);
  const paths = new Set<string>();
  for (const listing of listings) {
    if (!listing.ok) throw new Error(listing.error ?? "git ls-files --others failed");
    for (const path of listing.stdout.split("\0"))
      // Skip the trailing empty field and collapsed directory entries (`dir/`).
      if (path && !path.endsWith("/")) paths.add(path);
  }
  return [...paths].sort();
}

function selected(paths: string[], config: WorktreeConfig): string[] {
  if (config.carry === "none") return [];
  const extra = config.carryExclude;
  const wanted = config.carry === "all"
    ? paths
    : paths.filter((path) => (config.carry as string[]).some((pattern) => matchesGlob(path, pattern)));
  return wanted.filter((path) => !excluded(path, extra));
}

/**
 * Copy the selected untracked files from `repo` into `worktree` and record what was carried.
 *
 * Files are copied, never symlinked: a child that edits a symlink would be editing the operator's
 * own file, which is exactly the blast radius a private worktree exists to prevent.
 */
export async function carryUntracked(
  repo: string,
  worktree: string,
  supplied: WorktreeConfig | undefined,
  run: (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; error?: string }>,
): Promise<CarryResult> {
  // A caller that predates this block gets the documented default rather than a crash mid-run.
  // Falling back to "carry nothing" would be worse than either: it would silently reintroduce the
  // invisible-file failure this module exists to prevent.
  const config = supplied ?? DEFAULT_WORKTREE;
  const result: CarryResult = { carried: [], skipped: [] };
  if (config.carry === "none") return result;
  // A worktree nested inside the repository would otherwise try to carry its own siblings.
  const nested = relative(repo, worktree);
  const candidates = selected(await untrackedPaths(repo, run, config.carryExclude), config)
    .filter((path) => !nested || (path !== nested && !path.startsWith(nested + sep)));

  for (const path of candidates) {
    const source = join(repo, path);
    let stats;
    try { stats = await lstat(source); } catch { continue; }
    // A symlink's target may sit anywhere on the filesystem; copying its contents into a private
    // worktree would silently widen what the child can reach.
    if (!stats.isFile()) continue;
    if (stats.size > config.carryMaxBytes) {
      result.skipped.push({ path, bytes: stats.size });
      continue;
    }
    const destination = join(worktree, path);
    // Never overwrite: a tracked file at this path is the checkout's own content and authoritative.
    try { await access(destination, constants.F_OK); continue; } catch { /* absent, so carry it */ }
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      result.carried.push(path);
    } catch { /* An uncopyable file is reported by its absence, not by failing the run. */ }
  }

  if (result.carried.length) await writeCarried(worktree, result.carried);
  return result;
}

async function writeCarried(worktree: string, paths: string[]): Promise<void> {
  const existing = await readCarried(worktree);
  const all = [...new Set([...existing, ...paths])].sort();
  await writeFile(manifestPath(worktree), all.join("\n") + "\n", "utf8");
}

/** What was carried into this worktree. Empty for a worktree that carried nothing. */
export async function readCarried(worktree: string): Promise<string[]> {
  try {
    const content = await readFile(manifestPath(worktree), "utf8");
    return content.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Paths to unstage after a `git add`, so nothing carried can be committed.
 *
 * This is done by unstaging rather than by excluding up front: `git add -- . ':(exclude)<path>'`
 * treats the exclusion as an explicit mention of the path, and git then *fails* the whole add when
 * that path is gitignored — which is precisely the case that matters here. Force-added audit
 * pathspecs would stage carried files anyway, so unstaging is the only point that covers both.
 *
 * The carry manifest is unstaged too: it is bookkeeping this module owns, and committing it would
 * put kanban's internals into the user's history.
 */
export async function carriedStagingPaths(worktree: string): Promise<string[]> {
  const carried = await readCarried(worktree);
  return carried.length ? [".git-kanban-carried", ...carried] : [];
}

/** True for a path this worktree carried, or the manifest recording them. */
export function isCarried(path: string, carried: string[]): boolean {
  return path === ".git-kanban-carried" || carried.includes(path);
}
