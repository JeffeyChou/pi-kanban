import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHandoff,
  buildIdleHandoff,
  emptyPlan,
  writeHandoff,
  writePlan,
  type PlanSnapshot,
} from "./artifacts.js";

export const STAGES = [
  "refine",
  "research",
  "grill",
  "compose",
  "implement",
  "critique",
] as const;
export type Stage = (typeof STAGES)[number];
export type SessionState = "active" | "blocked";
export type SessionMode = "pipeline" | "manual";
export type AgentStatus = "working" | "idle" | "blocked";

export interface AgentRecord {
  name: string;
  role: string;
  status: AgentStatus;
}

export interface Session {
  title: string;
  stage: Stage;
  state: SessionState;
  /** Missing on legacy sessions; readers treat absence as "manual". */
  mode?: SessionMode;
  /** CAS identity of the live pipeline run or armed critique gate; cleared on pause/remove/rename. */
  pipelineToken?: string;
  planPath: string;
  agents: AgentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanState {
  schemaVersion: 4;
  selectedSessionTitle?: string;
  sessions: Session[];
  updatedAt: string;
}

interface V3Session extends Session {
  piConversationPath?: string;
}

interface V3State {
  schemaVersion: 3;
  selectedSessionTitle?: string;
  sessions: V3Session[];
  updatedAt: string;
}

interface LegacyTodo {
  text?: string;
  state?: string;
}
interface LegacyTask {
  title?: string;
  description?: string;
  state?: string;
  todos?: LegacyTodo[];
}
interface LegacyAgent {
  kind?: string;
  currentTask?: string | null;
}
interface LegacySession {
  id?: string;
  title?: string;
  stage?: Stage;
  state?: string;
  tasks?: LegacyTask[];
  agents?: LegacyAgent[];
  piConversationPath?: string;
  createdAt?: string;
  updatedAt?: string;
}
interface LegacyState {
  schemaVersion?: number;
  selectedSessionId?: string;
  sessions?: LegacySession[];
}

const now = () => new Date().toISOString();
const root = (cwd: string) => join(cwd, ".kanban");
const statePath = (cwd: string) => join(root(cwd), "state.json");
const lockPath = (cwd: string) => join(root(cwd), "lock");

export const kanbanPaths = (cwd: string) => ({
  root: root(cwd),
  state: statePath(cwd),
  lock: lockPath(cwd),
  plans: join(root(cwd), "plans"),
  handoff: join(root(cwd), "handoff.md"),
});

export const emptyState = (): KanbanState => ({
  schemaVersion: 4,
  sessions: [],
  updatedAt: now(),
});

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

function isV4State(value: unknown): value is KanbanState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 4 &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

function isV3State(value: unknown): value is V3State {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 3 &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

function normalizeState(
  value: Pick<KanbanState, "selectedSessionTitle" | "sessions" | "updatedAt">,
): KanbanState {
  const sessions = value.sessions
    .filter(
      (session): session is Session =>
        Boolean(session) &&
        typeof session.title === "string" &&
        isStage(session.stage) &&
        (session.state === "active" || session.state === "blocked"),
    )
    .map((session) => {
      const {
        piConversationPath: _ignored,
        mode: rawMode,
        ...withoutConversation
      } = session as V3Session;
      return {
        ...withoutConversation,
        ...(rawMode === "pipeline" || rawMode === "manual" ? { mode: rawMode } : {}),
        agents: Array.isArray(session.agents)
          ? session.agents.filter(
              (agent): agent is AgentRecord =>
                Boolean(agent) &&
                typeof agent.name === "string" &&
                typeof agent.role === "string" &&
                ["working", "idle", "blocked"].includes(agent.status),
            )
          : [],
      };
    });
  const selected = sessions.some(
    (session) => session.title === value.selectedSessionTitle,
  )
    ? value.selectedSessionTitle
    : sessions[0]?.title;
  return {
    schemaVersion: 4,
    sessions,
    ...(selected ? { selectedSessionTitle: selected } : {}),
    updatedAt: value.updatedAt || now(),
  };
}

function localDate(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const part = (number: number) => String(number).padStart(2, "0");
  return `${safe.getFullYear()}-${part(safe.getMonth() + 1)}-${part(safe.getDate())}`;
}

export function safeTitleSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "kanban-session";
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

async function readRaw(cwd: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(statePath(cwd), "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(cwd: string, state: KanbanState): Promise<void> {
  state.updatedAt = now();
  await mkdir(root(cwd), { recursive: true });
  const path = statePath(cwd);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function workFromLegacy(tasks: LegacyTask[] | undefined): PlanSnapshot["work"] {
  const work: PlanSnapshot["work"] = { done: [], current: [], next: [] };
  for (const task of tasks ?? []) {
    const title = task.title?.trim() || "Untitled task";
    const todoText = (task.todos ?? [])
      .map((todo) => todo.text?.trim())
      .filter((text): text is string => Boolean(text));
    const detail = todoText.length ? `${title}: ${todoText.join("; ")}` : title;
    if (task.state === "completed") work.done.push(detail);
    else if (task.state === "in_progress") work.current.push(detail);
    else if (task.state === "failed" || task.state === "cancelled")
      work.current.push(`${detail} (${task.state})`);
    else work.next.push(detail);
  }
  return work;
}

function agentsFromLegacy(agents: LegacyAgent[] | undefined): AgentRecord[] {
  if (!agents?.length)
    return [{ name: "Primary agent", role: "Coordinator", status: "idle" }];
  return agents.map((agent, index) => ({
    name:
      agent.kind === "subagent"
        ? `Subagent ${index + 1}`
        : index === 0
          ? "Primary agent"
          : `Primary agent ${index + 1}`,
    role: agent.kind === "subagent" ? "Subagent" : "Coordinator",
    status: agent.currentTask ? "working" : "idle",
  }));
}

async function allocatedPlanPath(
  cwd: string,
  title: string,
  createdAt: string | undefined,
  reserved = new Set<string>(),
): Promise<string> {
  const directory = kanbanPaths(cwd).plans;
  let existing: string[] = [];
  try {
    existing = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const taken = new Set(existing.map((entry) => `plans/${entry}`));
  for (const entry of reserved) taken.add(entry);
  const prefix = `${localDate(createdAt)}-${safeTitleSlug(title)}`;
  for (let ordinal = 1; ; ordinal++) {
    const suffix = ordinal === 1 ? "" : `-${ordinal}`;
    const path = `plans/${prefix}${suffix}.json`;
    if (!taken.has(path)) return path;
  }
}

async function migrateLegacyLocked(
  cwd: string,
  raw: LegacyState,
): Promise<KanbanState> {
  if (!Array.isArray(raw.sessions)) throw new Error("unsupported .kanban schema");
  const legacy = raw.sessions;
  const reserved = new Set<string>();
  const converted: Array<{ session: Session; plan: PlanSnapshot; legacyId?: string }> = [];
  for (const [index, item] of legacy.entries()) {
    const title = item.title?.trim() || `Migrated session ${index + 1}`;
    const createdAt = item.createdAt || item.updatedAt || now();
    const planPath = await allocatedPlanPath(cwd, title, createdAt, reserved);
    reserved.add(planPath);
    const state: SessionState = item.state === "blocked" ? "blocked" : "active";
    const agents = agentsFromLegacy(item.agents);
    const session: Session = {
      title,
      stage: isStage(item.stage) ? item.stage : "refine",
      state,
      planPath,
      agents,
      createdAt,
      updatedAt: item.updatedAt || createdAt,
    };
    const firstDescription = item.tasks
      ?.map((task) => task.description?.trim())
      .find((description): description is string => Boolean(description));
    converted.push({
      session,
      plan: {
        ...emptyPlan(session, firstDescription ?? title),
        status: item.state === "complete" ? "complete" : state,
        work: workFromLegacy(item.tasks),
      },
      legacyId: item.id,
    });
  }

  for (const item of converted) await writePlan(cwd, item.session.planPath, item.plan);
  const active = converted.filter((item) => item.plan.status !== "complete");
  const selectedLegacy = legacy.find((item) => item.id === raw.selectedSessionId);
  const selected = active.find((item) => item.session.title === selectedLegacy?.title);
  const completed = converted
    .filter((item) => item.plan.status === "complete")
    .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))[0];
  const next: KanbanState = {
    schemaVersion: 4,
    sessions: active.map((item) => item.session),
    ...(selected || active[0]
      ? { selectedSessionTitle: (selected ?? active[0])!.session.title }
      : {}),
    updatedAt: now(),
  };
  await writeHandoff(
    cwd,
    next.sessions.length
      ? buildHandoff()
      : buildIdleHandoff(
          completed
            ? { title: completed.session.title, planPath: completed.session.planPath }
            : undefined,
        ),
  );
  await writeState(cwd, next);
  await rm(join(kanbanPaths(cwd).root, "handoffs"), {
    recursive: true,
    force: true,
  });
  await Promise.all(
    converted
      .map((item) => item.legacyId)
      .filter((id): id is string => Boolean(id))
      .map((id) => rm(join(kanbanPaths(cwd).plans, `${id}.json`), { force: true })),
  );
  return next;
}

async function migrateV3Locked(cwd: string, raw: V3State): Promise<KanbanState> {
  const next = normalizeState(raw);
  await writeState(cwd, next);
  return next;
}

async function ensureStateLocked(cwd: string): Promise<KanbanState> {
  const raw = await readRaw(cwd);
  if (raw === undefined) return emptyState();
  if (isV4State(raw)) return normalizeState(raw);
  if (isV3State(raw)) return migrateV3Locked(cwd, raw);
  return migrateLegacyLocked(cwd, raw as LegacyState);
}

export async function initialize(cwd: string): Promise<KanbanState> {
  const release = await acquire(cwd);
  try {
    return await ensureStateLocked(cwd);
  } finally {
    await release();
  }
}

export const load = (cwd: string) => initialize(cwd);

export async function mutate<T>(
  cwd: string,
  update: (state: KanbanState) => T,
): Promise<{ state: KanbanState; value: T }> {
  const release = await acquire(cwd);
  try {
    const state = await ensureStateLocked(cwd);
    const value = update(state);
    await writeState(cwd, state);
    return { state, value };
  } finally {
    await release();
  }
}

export async function mutateAsync<T>(
  cwd: string,
  update: (state: KanbanState) => Promise<T>,
): Promise<{ state: KanbanState; value: T }> {
  const release = await acquire(cwd);
  try {
    const state = await ensureStateLocked(cwd);
    const value = await update(state);
    await writeState(cwd, state);
    return { state, value };
  } finally {
    await release();
  }
}

export function selectedSession(state: KanbanState): Session | undefined {
  return (
    state.sessions.find(
      (session) => session.title === state.selectedSessionTitle,
    ) ?? state.sessions[0]
  );
}

export function requireSelectedSession(state: KanbanState): Session {
  const session = selectedSession(state);
  if (!session) throw new Error("no active Kanban session; create one first");
  return session;
}

export async function createSession(
  cwd: string,
  state: KanbanState,
  title: string,
): Promise<Session> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Kanban title cannot be empty");
  if (state.sessions.some((session) => session.title === normalizedTitle))
    throw new Error(`an active Kanban session named “${normalizedTitle}” already exists`);
  const createdAt = now();
  const session: Session = {
    title: normalizedTitle,
    stage: "refine",
    state: "active",
    planPath: await allocatedPlanPath(cwd, normalizedTitle, createdAt),
    agents: [{ name: "Primary agent", role: "Coordinator", status: "idle" }],
    createdAt,
    updatedAt: createdAt,
  };
  state.sessions.push(session);
  state.selectedSessionTitle = session.title;
  return session;
}

export function setSelectedSession(state: KanbanState, title: string): Session {
  const session = state.sessions.find((item) => item.title === title);
  if (!session) throw new Error("unknown Kanban session");
  state.selectedSessionTitle = title;
  return session;
}

export function renameSession(
  state: KanbanState,
  session: Session,
  title: string,
): void {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Kanban title cannot be empty");
  if (
    state.sessions.some(
      (candidate) => candidate !== session && candidate.title === normalizedTitle,
    )
  )
    throw new Error(`an active Kanban session named “${normalizedTitle}” already exists`);
  const wasSelected = state.selectedSessionTitle === session.title;
  session.title = normalizedTitle;
  if (wasSelected) state.selectedSessionTitle = normalizedTitle;
  session.updatedAt = now();
}

export function setSessionState(session: Session, state: SessionState): void {
  session.state = state;
  session.updatedAt = now();
}

export function removeSession(state: KanbanState, session: Session): void {
  state.sessions = state.sessions.filter((item) => item !== session);
  if (state.selectedSessionTitle === session.title)
    state.selectedSessionTitle = state.sessions[0]?.title;
}

export function replaceAgents(
  session: Session,
  agents: AgentRecord[],
): void {
  const unique = new Set<string>();
  for (const agent of agents) {
    if (!agent.name.trim() || !agent.role.trim())
      throw new Error("each agent needs a name and role");
    if (unique.has(agent.name)) throw new Error("agent names must be unique");
    unique.add(agent.name);
  }
  const primary = agents.find((agent) => agent.name === "Primary agent") ?? {
    name: "Primary agent",
    role: "Coordinator",
    status: "idle" as const,
  };
  session.agents = [primary, ...agents.filter((agent) => agent !== primary)];
  session.updatedAt = now();
}

export function advanceStage(state: KanbanState, session: Session): Stage | undefined {
  const index = STAGES.indexOf(session.stage);
  const next = STAGES[index + 1];
  if (next) {
    session.stage = next;
    session.updatedAt = now();
    return next;
  }
  removeSession(state, session);
  return undefined;
}
