import { readPlan } from "./artifacts.js";
import { readLoopLog, readLoopRun } from "./looplog.js";
import { displayText, loopProgress } from "./liveprogress.js";
import { hasLiveRun } from "./orchestrator.js";
import { readSnapshot, selectedSession } from "./store.js";
import { getUsage, usageLines } from "./usage.js";
import { readWorkfile, workfileBase } from "./workfile.js";

export interface StatusQuery {
  view?: "summary" | "output" | "results" | "plan";
  iteration?: number;
}

/** A bounded, read-only answer. Calling this never starts, joins, or resumes a task. */
export async function queryStatus(cwd: string, query: StatusQuery = {}): Promise<string> {
  const session = selectedSession(await readSnapshot(cwd));
  if (!session) return "No selected Kanban session.";
  const base = workfileBase(session.planPath);
  const live = loopProgress(cwd, base);
  const [plan, manifest, records] = await Promise.all([
    readPlan(cwd, session.planPath), readLoopRun(cwd, base), readLoopLog(cwd, base),
  ]);
  const header = [
    `${session.title} · ${session.stage} · ${session.state}`,
    `Goal: ${plan?.prompt || session.title}`,
    hasLiveRun(session.title) ? "Task is running in the background in this Pi process. The main conversation is available."
      : `No live task in this Pi process.${manifest ? ` Saved run: ${manifest.status}; this is not proof of a live worker.` : ""}`,
  ];
  if (query.view === "plan") {
    const body = (await readWorkfile(cwd, base)).sections.compose;
    return displayText([...header, body ? `## compose\n${body}` : "No composed plan recorded."].join("\n\n")).slice(0, 24000);
  }
  const chosen = query.iteration === undefined ? records.at(-1) : records.find((record) => record.iteration === query.iteration);
  if (query.iteration !== undefined && !chosen)
    return [...header, `Iteration ${query.iteration} has no completed record yet.`].join("\n");
  if (query.view === "output")
    return displayText([...header,
      query.iteration === undefined && live?.output ? `Current child/measurement output tail:\n${live.output}`
        : chosen?.validationTail ? `Saved iteration ${chosen.iteration} validation tail:\n${chosen.validationTail}`
          : "No captured output for this request. Live output is process-local; saved records are not full transcripts.",
    ].join("\n\n")).slice(-12000);
  if (query.view === "results" || query.iteration !== undefined) {
    const selected = query.iteration === undefined ? records.slice(-8) : [chosen!];
    return displayText([...header, ...selected.map((record) => [
      `Iteration ${record.iteration}: ${record.decision} · metric ${record.metric ?? "not measured"} · validation ${record.validation === undefined ? "not recorded" : record.validation ? "pass" : "FAIL"}`,
      `Comment: ${record.failureReason ?? record.changed ?? record.lesson ?? "none recorded"}`,
      ...(record.commit ? [`Accepted commit: ${record.commit}`] : []),
      ...(record.auditCommit ? [`Audit commit: ${record.auditCommit}`] : []),
    ].join("\n")), ...(selected.length ? [] : ["No completed iterations yet."])].join("\n\n")).slice(0, 12000);
  }
  const usage = getUsage(cwd, session.title);
  return displayText([...header,
    ...(live ? [`Activity: ${live.activity} (reported ${Math.max(0, Math.floor((Date.now() - live.updatedAt) / 1000))}s ago)`,
      `Iteration ${live.iteration}/${live.maxIterations} (attempt budget); ${live.childRunning ? 1 : 0} child running`,
      `Metric: baseline ${live.baseline ?? "—"}, latest ${live.latest ?? "—"}, best ${live.best ?? "—"}, target ${live.target ?? "not set"}`,
      ...(live.comment ? [`Latest decision: ${live.comment}`] : []),
    ] : (plan?.work.current ?? []).map((line) => `Checkpoint: ${line}`)),
    ...(manifest ? [`Saved result: ${records.length} attempts; best ${manifest.bestMetric ?? "—"}; branch ${manifest.branch}; commit ${manifest.bestCommit}`] : []),
    ...(usage ? usageLines(usage) : []),
    "Query output or results only when needed. Do not poll or keep a monitoring turn running.",
  ].join("\n")).slice(0, 12000);
}
