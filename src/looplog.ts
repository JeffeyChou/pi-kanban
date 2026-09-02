/**
 * Durable, per-session-base loop breadcrumbs under `.kanban/loop/` and the worktree manifest
 * under `.kanban/worktrees/<base>/`. No new `state.json` fields (AGENTS.md state minimalism).
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeWorktreeForce } from "./worktree.js";

export interface LoopIterationRecord {
  iteration: number;
  decision: "keep" | "discard";
  /** `git diff --stat` of the candidate plus the child's one-line rationale. */
  changed?: string;
  validation?: boolean;
  /** Bounded tail of the validation output; discards only. */
  validationTail?: string;
  metric?: number;
  /** Why the candidate was discarded (validation, metric-regress, unmeasured, child-error). */
  failureReason?: string;
  /** Hypothesis + why it failed, injected forward. */
  lesson?: string;
  /** The child's `Status:` verdict for this iteration. */
  verdict?: "complete" | "continue";
  at: string;
}

export interface WorktreeEntry {
  path: string;
  /** Owner PID: a sweep removes a worktree only when this process is NOT alive. */
  pid: number;
  startedAt: string;
}

export interface LandedMarker {
  base: string;
  patchSha: string;
}

/** Bounds for the living summary (same spirit as the workfile section cap). */
export const LOOP_SUMMARY_MAX_RECORDS = 8;
export const LOOP_SUMMARY_MAX_LINES = 60;
const LOOP_SUMMARY_BLOCK_MAX_LINES = 3;

/** `.kanban/loop` — gitignored with the rest of `.kanban/`. */
export function loopDir(cwd: string): string {
  return join(cwd, ".kanban", "loop");
}
/** `.kanban/loop/<base>.jsonl` — one JSON line per iteration. */
export function loopLogPath(cwd: string, base: string): string {
  return join(loopDir(cwd), `${base}.jsonl`);
}
/** `.kanban/loop/<base>.md` — the bounded living summary injected forward. */
export function loopSummaryPath(cwd: string, base: string): string {
  return join(loopDir(cwd), `${base}.md`);
}
/** `.kanban/loop/<base>.patch` — the current best, for recoverable landing. */
export function loopPatchPath(cwd: string, base: string): string {
  return join(loopDir(cwd), `${base}.patch`);
}
/** `.kanban/loop/<base>.landed` — `{ base, patchSha }` marker written before the advance. */
export function loopLandedPath(cwd: string, base: string): string {
  return join(loopDir(cwd), `${base}.landed`);
}
/** `.kanban/worktrees/<base>` — gitignored with the rest of `.kanban/`. */
export function worktreeRoot(cwd: string, base: string): string {
  return join(cwd, ".kanban", "worktrees", base);
}
/** `.kanban/worktrees/<base>/<n>` — one disposable worktree per iteration. */
export function iterationWorktreePath(cwd: string, base: string, iteration: number): string {
  return join(worktreeRoot(cwd, base), String(iteration));
}

function manifestPath(cwd: string, base: string): string {
  return join(worktreeRoot(cwd, base), "manifest.json");
}

/** Atomic tmp-plus-rename whole-file write (the same pattern workfile.ts uses). */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

/** Read a text file; a missing file is undefined, never an error. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Append one JSONL record to `.kanban/loop/<base>.jsonl`. */
export async function appendLoopLog(
  cwd: string,
  base: string,
  record: LoopIterationRecord,
): Promise<void> {
  await mkdir(loopDir(cwd), { recursive: true });
  await appendFile(loopLogPath(cwd, base), `${JSON.stringify(record)}\n`, "utf8");
}

/** Every parseable record; unreadable/missing ⇒ []. Unparseable lines are skipped. */
export async function readLoopLog(
  cwd: string,
  base: string,
): Promise<LoopIterationRecord[]> {
  const content = await readText(loopLogPath(cwd, base));
  if (content === undefined) return [];
  const records: LoopIterationRecord[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as Partial<LoopIterationRecord>).iteration === "number"
      ) {
        records.push(parsed as LoopIterationRecord);
      }
    } catch {
      // Skip the unparseable line rather than failing the whole log.
    }
  }
  return records;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function indentBounded(text: string, maxLines: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = normalized === "" ? [] : normalized.split("\n");
  const out = lines.slice(0, maxLines).map((line) => `  ${line}`);
  if (lines.length > maxLines) out.push("  [truncated]");
  return out;
}

function fmtValidation(record: LoopIterationRecord): string {
  return record.validation === undefined
    ? "n/a"
    : record.validation
      ? "passed"
      : "failed";
}

function iterationBlock(record: LoopIterationRecord): string[] {
  const lines: string[] = [];
  const metric = record.metric === undefined ? "" : ` — metric ${record.metric}`;
  const verdict = record.verdict === undefined ? "" : ` — verdict ${record.verdict}`;
  lines.push(
    `### #${record.iteration} ${record.decision} — validation ${fmtValidation(record)}${metric}${verdict}`,
  );
  if (record.changed) lines.push(...indentBounded(record.changed, LOOP_SUMMARY_BLOCK_MAX_LINES));
  if (record.validationTail) {
    lines.push(...indentBounded(record.validationTail, LOOP_SUMMARY_BLOCK_MAX_LINES));
  }
  if (record.failureReason) lines.push(`  reason: ${singleLine(record.failureReason)}`);
  if (record.lesson) lines.push(`  lesson: ${singleLine(record.lesson)}`);
  return lines;
}

function truncateLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `[truncated: summary limited to ${maxLines} lines]`];
}

function renderSummaryText(base: string, records: LoopIterationRecord[]): string {
  const newestFirst = [...records].reverse();
  const lines: string[] = [];
  lines.push(`# Implement loop: ${base}`);
  lines.push("");
  lines.push(
    "Living memory for the implement loop, injected into the next iteration's prompt.",
  );
  lines.push(
    "The saved best patch is re-applied over the base before each iteration; lessons below",
  );
  lines.push("should steer what the next iteration tries. Newest first.");
  lines.push("");
  lines.push("## Current best");
  const best = newestFirst.find((record) => record.decision === "keep");
  if (best) {
    lines.push(
      `- Iteration #${best.iteration} is the best so far (validation ${fmtValidation(best)}` +
        `${best.metric === undefined ? "" : `, metric ${best.metric}`}).`,
    );
    lines.push(`- Saved patch: \`.kanban/loop/${base}.patch\``);
  } else {
    lines.push("- No iteration kept yet: the base snapshot is the current best.");
    lines.push("- Saved patch: none (nothing to land until a candidate is kept).");
  }
  lines.push("");
  lines.push("## Iterations (newest first)");
  const shown = newestFirst.slice(0, LOOP_SUMMARY_MAX_RECORDS);
  for (const record of shown) lines.push(...iterationBlock(record));
  if (newestFirst.length > shown.length) {
    lines.push("");
    lines.push(
      `[truncated: showing the ${shown.length} most recent of ${newestFirst.length} iterations]`,
    );
  }
  const lessons = newestFirst.filter(
    (record) => record.decision === "discard" && record.lesson,
  );
  if (lessons.length > 0) {
    lines.push("");
    lines.push("## Lessons from discarded iterations");
    const seen = new Set<string>();
    const unique: LoopIterationRecord[] = [];
    for (const record of lessons) {
      const lesson = singleLine(record.lesson!);
      if (seen.has(lesson)) continue;
      seen.add(lesson);
      unique.push(record);
    }
    const capped = unique.slice(0, LOOP_SUMMARY_MAX_RECORDS);
    for (const record of capped) lines.push(`- #${record.iteration}: ${singleLine(record.lesson!)}`);
    if (unique.length > capped.length) {
      lines.push(`- [truncated: ${unique.length - capped.length} more lessons omitted]`);
    }
  }
  return `${truncateLines(lines, LOOP_SUMMARY_MAX_LINES).join("\n")}\n`;
}

/**
 * Render AND write the bounded living summary `.kanban/loop/<base>.md` that is injected into
 * the next iteration's prompt. Returns the rendered text.
 */
export async function renderLivingSummary(
  cwd: string,
  base: string,
  records: LoopIterationRecord[],
): Promise<string> {
  const rendered = renderSummaryText(base, records);
  await atomicWrite(loopSummaryPath(cwd, base), rendered);
  return rendered;
}

/** Atomically write the best-so-far patch; returns its sha256 (hex). */
export async function writeBestPatch(
  cwd: string,
  base: string,
  patch: string,
): Promise<string> {
  const sha = createHash("sha256").update(patch, "utf8").digest("hex");
  await atomicWrite(loopPatchPath(cwd, base), patch);
  return sha;
}

export async function readBestPatch(
  cwd: string,
  base: string,
): Promise<string | undefined> {
  return readText(loopPatchPath(cwd, base));
}

/** Atomic (tmp + rename) `{ base, patchSha }` marker written BEFORE the advancing mutate. */
export async function writeLandedMarker(
  cwd: string,
  base: string,
  patchSha: string,
): Promise<void> {
  await atomicWrite(loopLandedPath(cwd, base), `${JSON.stringify({ base, patchSha })}\n`);
}

export async function readLandedMarker(
  cwd: string,
  base: string,
): Promise<LandedMarker | undefined> {
  const content = await readText(loopLandedPath(cwd, base));
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LandedMarker).base === "string" &&
      typeof (parsed as LandedMarker).patchSha === "string"
    ) {
      return parsed as LandedMarker;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeManifest(cwd: string, base: string, entries: WorktreeEntry[]): Promise<void> {
  await atomicWrite(manifestPath(cwd, base), `${JSON.stringify(entries)}\n`);
}

export async function readWorktreeManifest(
  cwd: string,
  base: string,
): Promise<WorktreeEntry[]> {
  const content = await readText(manifestPath(cwd, base));
  if (content === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is WorktreeEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as WorktreeEntry).path === "string" &&
        typeof (entry as WorktreeEntry).pid === "number" &&
        typeof (entry as WorktreeEntry).startedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Register (or replace, by path) one worktree entry. */
export async function registerWorktree(
  cwd: string,
  base: string,
  entry: WorktreeEntry,
): Promise<void> {
  const entries = await readWorktreeManifest(cwd, base);
  const kept = entries.filter((existing) => existing.path !== entry.path);
  kept.push(entry);
  await writeManifest(cwd, base, kept);
}

/** Remove the entry for `path`, if present. Missing manifests are a no-op. */
export async function unregisterWorktree(
  cwd: string,
  base: string,
  path: string,
): Promise<void> {
  const entries = await readWorktreeManifest(cwd, base);
  const kept = entries.filter((existing) => existing.path !== path);
  if (kept.length === entries.length) return;
  await writeManifest(cwd, base, kept);
}

/** Delete every `.kanban/loop/<base>.*` artifact and the base's worktree manifest tree. */
export async function deleteLoopArtifacts(cwd: string, base: string): Promise<void> {
  const directory = loopDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  const prefix = `${base}.`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(join(directory, entry), { force: true })),
  );
  await rm(worktreeRoot(cwd, base), { recursive: true, force: true });
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `session_start` recovery sweep: for every manifest under `.kanban/worktrees/`, force-remove
 * and unregister the worktrees whose owner PID is NOT alive, and leave live-owner entries
 * exactly as they are. `isAlive` is injectable for tests.
 */
export async function sweepLoopWorktrees(
  cwd: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<void> {
  const root = join(cwd, ".kanban", "worktrees");
  let bases: string[];
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    bases = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const base of bases) {
    const entries = await readWorktreeManifest(cwd, base);
    const dead = entries.filter((entry) => !isAlive(entry.pid));
    if (dead.length === 0) continue;
    for (const entry of dead) {
      await removeWorktreeForce(cwd, entry.path);
    }
    const live = entries.filter((entry) => isAlive(entry.pid));
    await writeManifest(cwd, base, live);
  }
}