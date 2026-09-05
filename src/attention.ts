/**
 * A durable record of everything that asked a human to look at it.
 *
 * Escalation used to be a `ui.notify` toast and nothing else: it vanished on the next redraw, was
 * invisible to a headless run, and left no trace a later session or the main-conversation agent
 * could read. A campaign could therefore stop on a real warning that nobody ever saw. This log is
 * append-only for the same reason — the point is that a warning survives being ignored.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AttentionEntry {
  /** Where it came from: a lane name, a stage name, or a subsystem. */
  source: string;
  message: string;
  /** What the operator can do about it, when there is a concrete action. */
  remedy?: string;
}

export function attentionPath(cwd: string): string {
  return join(cwd, ".kanban", "attention.md");
}

export async function appendAttention(cwd: string, base: string, entry: AttentionEntry): Promise<void> {
  const path = attentionPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const body = [
    `## ${new Date().toISOString()} · ${base} · ${entry.source}`,
    "",
    entry.message.trim().slice(0, 4000),
    ...(entry.remedy ? ["", `Remedy: ${entry.remedy}`] : []),
    "",
    "",
  ].join("\n");
  // Best effort: an escalation must never be the thing that fails the run it is reporting on.
  await appendFile(path, body, "utf8").catch(() => undefined);
}

/** The most recent entries, newest first. Bounded so a long campaign cannot flood a status view. */
export async function readAttention(cwd: string, limit = 10): Promise<string[]> {
  let content: string;
  try { content = await readFile(attentionPath(cwd), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content
    .split(/^## /m)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section) => `## ${section}`)
    .slice(-limit)
    .reverse();
}
