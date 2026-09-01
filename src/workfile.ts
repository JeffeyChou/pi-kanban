import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Stage } from "./store.js";
import { STAGES } from "./store.js";

export const WORKFILE_SECTION_MAX_LINES = 300;

export interface Workfile {
  /** Section bodies WITHOUT their `## <stage>` heading lines. */
  sections: Partial<Record<Stage, string>>;
}

function lineCount(content: string): number {
  const trimmed = content.replace(/\n$/, "");
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}

function capBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (lineCount(normalized) <= WORKFILE_SECTION_MAX_LINES) return normalized;
  return [
    ...normalized.split("\n").slice(0, WORKFILE_SECTION_MAX_LINES - 1),
    `[truncated: section limited to ${WORKFILE_SECTION_MAX_LINES} lines]`,
  ].join("\n");
}

function sectionHeader(line: string): Stage | undefined {
  const match = /^## (refine|research|grill|compose|implement|critique)(?:\s.*)?$/.exec(
    line,
  );
  return match?.[1] as Stage | undefined;
}

function parseWorkfile(content: string): Workfile {
  const sections: Workfile["sections"] = {};
  let current: Stage | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (current !== undefined)
      sections[current] = lines.join("\n").replace(/\n$/, "");
  };

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const stage = sectionHeader(line);
    if (stage) {
      flush();
      current = stage;
      lines = [];
    } else if (current !== undefined) {
      lines.push(line);
    }
  }
  flush();
  return { sections };
}

function renderWorkfile(workfile: Workfile): string {
  const sections = STAGES.flatMap((stage) => {
    const body = workfile.sections[stage];
    return body === undefined ? [] : [`## ${stage}\n${body}`];
  });
  return sections.length ? `${sections.join("\n\n")}\n` : "";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

/** "plans/2026-09-01-title.json" → "2026-09-01-title". */
export function workfileBase(planPath: string): string {
  const filename = basename(planPath);
  return filename.slice(0, filename.length - extname(filename).length);
}

/** `.kanban/work/<base>.md`. */
export function workfilePath(cwd: string, base: string): string {
  return join(cwd, ".kanban", "work", `${base}.md`);
}

/** Missing file → { sections: {} }. Bodies exclude headings. */
export async function readWorkfile(cwd: string, base: string): Promise<Workfile> {
  try {
    return parseWorkfile(await readFile(workfilePath(cwd, base), "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sections: {} };
    throw error;
  }
}

/**
 * Atomic read-modify-replace of ONE section, preserving the others. `body` never includes
 * the heading — this function owns the `## <stage>` heading lines and applies the
 * 300-line cap (truncating with a note).
 */
export async function writeWorkfileSection(
  cwd: string,
  base: string,
  stage: Stage,
  body: string,
): Promise<void> {
  const workfile = await readWorkfile(cwd, base);
  workfile.sections[stage] = capBody(body);
  await atomicWrite(workfilePath(cwd, base), renderWorkfile(workfile));
}

/** Idempotent. */
export async function deleteWorkfile(cwd: string, base: string): Promise<void> {
  await rm(workfilePath(cwd, base), { force: true });
}

/** Delete `.kanban/work/*.md` whose base matches no session (any state). Idempotent. */
export async function sweepOrphanWorkfiles(
  cwd: string,
  activeBases: string[],
): Promise<void> {
  const directory = join(cwd, ".kanban", "work");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const active = new Set(activeBases);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .filter((entry) => !active.has(entry.slice(0, -".md".length)))
      .map((entry) => rm(join(directory, entry), { force: true })),
  );
}
