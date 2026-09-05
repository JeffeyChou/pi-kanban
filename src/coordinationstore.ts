/** Durable iteration control, separate from the compact board and public progress tail. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateLoopRevision, type JobAdapterConfig, type LoopConfig } from "./config.js";
import { mutateAsync } from "./store.js";
import { publishProgress } from "./progressevents.js";

export type LaneState = "ready" | "working" | "waiting" | "candidate" | "accepted" | "blocked" | "failed" | "cancelled" | "retired";
export interface LaneRecord {
  name: string;
  task: string;
  role: "worker" | "reviewer";
  acceptance: string;
  dependsOn: string[];
  claims: string[];
  state: LaneState;
  revision: number;
  attempt: number;
  worktree: string;
  baseCommit: string;
  /** Original integration baseline, carried through partial-work retries. */
  candidateBase?: string;
  sessionFile?: string;
  candidate?: string;
  output?: string;
  question?: string;
  reply?: string;
  error?: string;
  reviewedCandidate?: string;
  reviewOf?: string;
  reviewVerdict?: "pass" | "fail";
  sourceLane?: string;
  sourceWorktree?: string;
  sourceBase?: string;
}

export type JobState = "intent" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown" | "blocked";
export interface JobRecord {
  key: string;
  name: string;
  lane: string;
  adapterName: string;
  adapter: JobAdapterConfig;
  params: Record<string, unknown>;
  /** Public iteration identity only; never persist inherited credentials. */
  env?: Record<string, string>;
  revision: number;
  sourceCommit: string;
  sourceDigest?: string;
  worktree: string;
  state: JobState;
  externalId?: string;
  submitted: boolean;
  cancelRequested?: boolean;
  collected?: boolean;
  accepted?: boolean;
  artifacts?: string[];
  metric?: number;
  output?: string;
  error?: string;
  startedAt: number;
  deadline: number;
  candidateHash?: string;
  acceptanceRevision?: number;
}

export interface ControlRequest {
  action: "steer" | "revise" | "retry" | "reply";
  message: string;
  lane?: string;
  loop?: Partial<LoopConfig>;
  inScope?: string[];
  outOfScope?: string[];
}

export interface CoordinatorEvent {
  id: string;
  kind: string;
  message: string;
  lane?: string;
  at: string;
  handled: boolean;
}

export interface CoordinationState {
  version: 1;
  title: string;
  token: string;
  iteration: number;
  status: "running" | "waiting" | "paused" | "blocked" | "finished";
  goal: string;
  spec: string;
  revision: number;
  loop: LoopConfig;
  /** New metric definitions cannot reuse old comparisons. */
  baselineMetric?: number;
  metricReset?: boolean;
  pendingRevision?: { id: string; request: ControlRequest };
  revisions: Array<{ revision: number; goal: string; at: string }>;
  sessionFile?: string;
  worktree: string;
  lanes: Record<string, LaneRecord>;
  jobs: Record<string, JobRecord>;
  events: CoordinatorEvent[];
  submissions: number;
  childRuns: number;
  coordinatorTurns: number;
  measurement?: { revision: number; sourceCommit: string; worktree?: string; validationPass: boolean; metric?: number; metricUnmeasured: boolean; tail: string };
  measurementPatch?: string;
  finish?: { decision: "keep" | "revert"; verdict: "complete" | "continue"; rationale: string; revision: number; resultJob?: string };
  blocker?: string;
  updatedAt: string;
}

export function coordinationPath(cwd: string, base: string): string {
  return join(cwd, ".kanban", "loop", `${base}.coordinator.json`);
}

export async function readCoordination(cwd: string, base: string): Promise<CoordinationState | undefined> {
  let content: string;
  try { content = await readFile(coordinationPath(cwd, base), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = JSON.parse(content) as CoordinationState;
  if (value.version !== 1 || !Number.isInteger(value.iteration) || !value.jobs || !value.lanes || !Array.isArray(value.events))
    throw new Error("Invalid coordinator recovery record; preserve it and repair before resuming");
  return value;
}

/** Only called inside the board lock. A complete snapshot includes pending event delivery. */
export async function writeCoordination(cwd: string, base: string, value: CoordinationState): Promise<void> {
  const path = coordinationPath(cwd, base);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  value.updatedAt = new Date().toISOString();
  // Never prune undelivered events. Retain a bounded history of delivered transitions.
  const recent = new Set(value.events.filter((event) => event.handled).slice(-128).map((event) => event.id));
  value.events = value.events.filter((event) => !event.handled || recent.has(event.id));
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
  publishProgress(cwd, "records");
}

export function addCoordinatorEvent(value: CoordinationState, kind: string, message: string, lane?: string, id: string = randomUUID()): string {
  if (!value.events.some((event) => event.id === id))
    value.events.push({ id, kind, message: message.slice(0, 12000), ...(lane ? { lane } : {}), at: new Date().toISOString(), handled: false });
  return id;
}

type Wake = () => void;
const observers = new Map<string, Wake>();
const key = (cwd: string, base: string) => JSON.stringify([cwd, base]);
export function observeCoordinator(cwd: string, base: string, wake: Wake): () => void {
  observers.set(key(cwd, base), wake);
  return () => { if (observers.get(key(cwd, base)) === wake) observers.delete(key(cwd, base)); };
}
export function wakeCoordinator(cwd: string, base: string): void { observers.get(key(cwd, base))?.(); }

export async function updateCoordination<T>(
  cwd: string, base: string, title: string, token: string,
  change: (value: CoordinationState) => T | Promise<T>,
  options: { allowPaused?: boolean } = {},
): Promise<T> {
  const result = await mutateAsync(cwd, async (board) => {
    const session = board.sessions.find((item) => item.title === title);
    if (!session || session.stage !== "implement" ||
      (!options.allowPaused && session.state !== "active") || session.pipelineToken !== token)
      throw new Error("The coordinator no longer owns this implement session");
    const value = await readCoordination(cwd, base);
    if (!value || value.token !== token) throw new Error("The coordinator run was replaced");
    const changed = await change(value);
    await writeCoordination(cwd, base, value);
    return changed;
  });
  wakeCoordinator(cwd, base);
  return result.value;
}

/** Main-conversation control is durable even if no coordinator currently owns a process. */
export function recordControl(value: CoordinationState, request: ControlRequest): void {
  if (!request.message.trim()) throw new Error("A control message is required");
  if (request.loop) validateLoopRevision(request.loop);
  if (request.action !== "revise" && (request.loop || request.inScope || request.outOfScope))
    throw new Error("Settings and scope changes require action revise");
  if (request.lane && !value.lanes[request.lane]) throw new Error(`Unknown lane: ${request.lane}`);
  if (request.action === "reply") {
    const lane = request.lane ? value.lanes[request.lane] : undefined;
    if (!lane?.question) throw new Error("Name a lane with a pending question");
    lane.reply = request.message;
  }
  const id = randomUUID();
  if (request.action === "revise") {
    const previous = value.pendingRevision?.request;
    value.pendingRevision = { id, request: previous ? {
      ...previous, ...request,
      message: `${previous.message}\nSubsequent user update: ${request.message}`,
      ...((previous.loop || request.loop) ? { loop: { ...previous.loop, ...request.loop } } : {}),
    } : request };
    delete value.finish;
  }
  if (value.status === "finished") { value.status = "running"; delete value.finish; }
  addCoordinatorEvent(value, `user_${request.action}`, JSON.stringify(request), request.lane, id);
}

export async function requestControl(cwd: string, base: string, title: string, request: ControlRequest): Promise<string> {
  await mutateAsync(cwd, async (board) => {
    const session = board.sessions.find((item) => item.title === title);
    if (!session || board.selectedSessionTitle !== title || session.stage !== "implement" || session.state !== "active")
      throw new Error("Select an active implement session before sending control");
    const value = await readCoordination(cwd, base);
    if (!value) throw new Error("Start or resume the implement coordinator first");
    recordControl(value, request);
    await writeCoordination(cwd, base, value);
  });
  wakeCoordinator(cwd, base);
  return `Control recorded (${request.action}); ${request.action === "revise" ? "goal revision is pending application" : "the coordinator will act on it"}.`;
}

export function unresolvedJob(job: JobRecord): boolean {
  return ["intent", "queued", "running", "unknown", "blocked"].includes(job.state);
}

export function coordinationLines(value: CoordinationState): string[] {
  return [
    `Coordinator: ${value.status} · goal revision ${value.revision}${value.pendingRevision ? " · revision pending" : ""}`,
    `Jobs: ${Object.values(value.jobs).filter(unresolvedJob).length} outstanding · submissions ${value.submissions}${value.loop.maxSubmissions === undefined ? "" : `/${value.loop.maxSubmissions}`}`,
    ...Object.values(value.lanes).map((lane) => `${lane.name}: ${lane.state} · attempt ${lane.attempt}${lane.question ? ` · needs answer: ${lane.question}` : lane.error ? ` · ${lane.error}` : ""}`),
    ...Object.values(value.jobs).slice(-12).map((job) => `${job.name}: ${job.state}${job.externalId ? ` · job ${job.externalId}` : ""}${job.collected ? ` · evidence ${job.accepted ? "accepted" : "not accepted"}` : ""}${job.error ? ` · ${job.error}` : ""}`),
  ];
}
