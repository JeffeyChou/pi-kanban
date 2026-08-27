import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const STAGES = [
  "refine",
  "research",
  "grill",
  "compose",
  "implement",
  "critique",
] as const;
export type Stage = (typeof STAGES)[number];
export type TaskState =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked_manual";

export interface Todo {
  id: string;
  text: string;
  state: "pending" | "in_progress" | "completed";
  evidence: string[];
}
export interface Task {
  id: string;
  title: string;
  description?: string;
  state: TaskState;
  assignedAgent?: string;
  prerequisites: string[];
  subsequent: string[];
  todos: Todo[];
  important?: boolean;
  review: {
    status: "not_required" | "pending" | "passed" | "failed";
    evidence: string[];
  };
  evidence: string[];
}
export interface Agent {
  id: string;
  kind: "primary" | "subagent";
  model: string | null;
  contextUsage: number | null;
  currentTask: string | null;
  remainingTodos: string[];
  metricsSource: "pi-context" | "subagent-inspect" | "unavailable";
}
export interface Session {
  id: string;
  title: string;
  stage: Stage;
  state: "active" | "blocked" | "complete";
  tasks: Task[];
  agents: Agent[];
  importantCriteria: string[];
  evidence: string[];
  reviews: string[];
  sourceFiles: string[];
  planArtifact: string;
  handoffArtifact: string;
  piConversationPath?: string;
  piConversationId?: string;
  currentActivity: string;
  liveProgress: { completed: number; total: number; updatedAt: string };
  createdAt: string;
  updatedAt: string;
}
export interface KanbanState {
  schemaVersion: 2;
  sessions: Session[];
  selectedSessionId?: string;
  integrations: Record<string, boolean>;
  modelContextLimits: Record<string, number>;
  updatedAt: string;
}

const now = () => new Date().toISOString();
const root = (cwd: string) => join(cwd, ".kanban");
const statePath = (cwd: string) => join(root(cwd), "state.json");
const lockPath = (cwd: string) => join(root(cwd), "lock");
export const artifactPaths = (cwd: string, id: string) => ({
  plan: join(root(cwd), "plans", `${id}.json`),
  handoff: join(root(cwd), "handoffs", `${id}.md`),
});
export const emptyState = (): KanbanState => ({
  schemaVersion: 2,
  sessions: [],
  integrations: {},
  modelContextLimits: {},
  updatedAt: now(),
});

function migrate(parsed: unknown): KanbanState {
  if (!parsed || typeof parsed !== "object")
    throw new Error("invalid .kanban state");
  const state = parsed as Partial<KanbanState> & {
    schemaVersion?: number;
    sessions?: Session[];
  };
  if (state.schemaVersion === 2) return state as KanbanState;
  if (state.schemaVersion !== 1 || !Array.isArray(state.sessions))
    throw new Error("unsupported .kanban schema");
  for (const session of state.sessions) {
    const paths = artifactPaths(".", session.id);
    Object.assign(session, {
      sourceFiles: [],
      planArtifact: paths.plan.replace(/^\.\//, ""),
      handoffArtifact: paths.handoff.replace(/^\.\//, ""),
      currentActivity: `Awaiting ${session.stage}`,
      liveProgress: { completed: 0, total: 0, updatedAt: session.updatedAt },
    });
  }
  return {
    schemaVersion: 2,
    sessions: state.sessions,
    selectedSessionId: state.sessions[0]?.id,
    integrations: state.integrations ?? {},
    modelContextLimits: {},
    updatedAt: state.updatedAt ?? now(),
  };
}

async function acquire(cwd: string): Promise<() => Promise<void>> {
  await mkdir(root(cwd), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockPath(cwd));
      await writeFile(
        join(lockPath(cwd), "owner.json"),
        JSON.stringify({ pid: process.pid, acquiredAt: now() }),
        "utf8",
      );
      return async () => rm(lockPath(cwd), { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, 10 + attempt * 5)),
      );
    }
  }
  throw new Error(
    "kanban repository lock is busy; retry after the other Pi session finishes its mutation",
  );
}
async function readState(cwd: string): Promise<KanbanState> {
  try {
    return migrate(JSON.parse(await readFile(statePath(cwd), "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}
async function writeState(cwd: string, state: KanbanState): Promise<void> {
  state.updatedAt = now();
  await mkdir(root(cwd), { recursive: true });
  const path = statePath(cwd);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
export async function initialize(
  cwd: string,
  integrations: Record<string, boolean>,
): Promise<KanbanState> {
  return mutate(cwd, (state) => {
    state.integrations = integrations;
    return state;
  });
}
export const load = (cwd: string) => readState(cwd);
export async function mutate(
  cwd: string,
  update: (state: KanbanState) => KanbanState,
): Promise<KanbanState> {
  const release = await acquire(cwd);
  try {
    const state = update(await readState(cwd));
    await writeState(cwd, state);
    return state;
  } finally {
    await release();
  }
}
export function createSession(
  state: KanbanState,
  title: string,
  description?: string,
): Session {
  const id = randomUUID();
  const paths = artifactPaths(".", id);
  const session: Session = {
    id,
    title,
    stage: "refine",
    state: "active",
    tasks: [],
    agents: [],
    importantCriteria: [],
    evidence: [],
    reviews: [],
    sourceFiles: [],
    planArtifact: paths.plan.replace(/^\.\//, ""),
    handoffArtifact: paths.handoff.replace(/^\.\//, ""),
    currentActivity: "Starting refine",
    liveProgress: { completed: 0, total: 0, updatedAt: now() },
    createdAt: now(),
    updatedAt: now(),
  };
  if (description)
    session.tasks.push(newTask(randomUUID(), title, description));
  state.sessions.push(session);
  state.selectedSessionId = id;
  return session;
}
export function newTask(id: string, title: string, description?: string): Task {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    state: "pending",
    prerequisites: [],
    subsequent: [],
    todos: [],
    review: { status: "not_required", evidence: [] },
    evidence: [],
  };
}
export function requireSession(state: KanbanState, id: string): Session {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error("unknown kanban session");
  return session;
}
export function selectedSession(state: KanbanState): Session | undefined {
  return (
    state.sessions.find((session) => session.id === state.selectedSessionId) ??
    state.sessions[0]
  );
}
export function prerequisitesComplete(session: Session, task: Task): boolean {
  return task.prerequisites.every(
    (id) =>
      session.tasks.find((candidate) => candidate.id === id)?.state ===
      "completed",
  );
}
export function refreshProgress(session: Session): void {
  const todos = session.tasks.flatMap((task) => task.todos);
  const completed =
    todos.filter((todo) => todo.state === "completed").length +
    session.tasks.filter(
      (task) => task.state === "completed" && task.todos.length === 0,
    ).length;
  const total =
    todos.length +
    session.tasks.filter((task) => task.todos.length === 0).length;
  session.liveProgress = { completed, total, updatedAt: now() };
  session.updatedAt = now();
}
export function blockDependents(
  session: Session,
  prerequisiteId: string,
): void {
  for (const task of session.tasks.filter((candidate) =>
    candidate.prerequisites.includes(prerequisiteId),
  )) {
    task.state = "blocked_manual";
    task.evidence.push(
      "Blocked manually: a prerequisite failed or was cancelled.",
    );
    blockDependents(session, task.id);
  }
}
