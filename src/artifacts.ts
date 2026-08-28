import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRecord, Session, SessionState, Stage } from "./store.js";

export const HANDOFF_MAX_LINES = 200;

export interface WorkSummary {
  done: string[];
  current: string[];
  next: string[];
}

export interface PlanSnapshot {
  title: string;
  prompt: string;
  stage: Stage;
  status: SessionState | "complete";
  inScope: string[];
  outOfScope: string[];
  agents: AgentRecord[];
  work: WorkSummary;
  createdAt: string;
  updatedAt: string;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function lineCount(content: string): number {
  const trimmed = content.replace(/\n$/, "");
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}

export function emptyPlan(session: Session, prompt: string): PlanSnapshot {
  return {
    title: session.title,
    prompt,
    stage: session.stage,
    status: session.state,
    inScope: [],
    outOfScope: [],
    agents: session.agents,
    work: { done: [], current: [], next: [] },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export async function readPlan(
  cwd: string,
  path: string,
): Promise<PlanSnapshot | undefined> {
  try {
    return JSON.parse(
      await readFile(join(cwd, ".kanban", path), "utf8"),
    ) as PlanSnapshot;
  } catch {
    return undefined;
  }
}

export async function writePlan(
  cwd: string,
  path: string,
  plan: PlanSnapshot,
): Promise<void> {
  await atomicWrite(
    join(cwd, ".kanban", path),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
}

const rules = [
  "1. `.kanban/state.json` is authoritative for the selected session, stage, and agent roster.",
  "2. Read the selected plan in `.kanban/plans/` for scope and work details.",
  "3. Run `./init.sh` before implementation and `./init.sh --check` before handoff.",
  "4. Never run `git commit` automatically. The final response must provide a suggested commit instead.",
].join("\n");

export function buildHandoff(supplement?: string): string {
  return `# Kanban handoff

## Operating rules

${rules}

## Supplement

${supplement?.trim() || "No supplementary handoff recorded."}
`;
}

export function buildIdleHandoff(
  latest?: { title: string; planPath: string },
): string {
  const latestLine = latest
    ? `Latest completed plan: \`${latest.planPath}\` — ${latest.title}`
    : "No active Kanban session.";
  return `# Kanban handoff

## Operating rules

${rules}

## Standby

${latestLine}
`;
}

export async function writeHandoff(cwd: string, content: string): Promise<void> {
  const lines = lineCount(content);
  if (lines > HANDOFF_MAX_LINES)
    throw new Error(
      `handoff.md may contain at most ${HANDOFF_MAX_LINES} lines; received ${lines}`,
    );
  await atomicWrite(join(cwd, ".kanban", "handoff.md"), content);
}

export async function readHandoff(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, ".kanban", "handoff.md"), "utf8");
  } catch {
    return "";
  }
}
