import { readPlan } from "./artifacts.js";
import { readAttention } from "./attention.js";
import { readLoopLog, readLoopRun } from "./looplog.js";
import { displayText, loopProgress } from "./liveprogress.js";
import { hasLiveRun } from "./orchestrator.js";
import { readSnapshot, selectedSession } from "./store.js";
import { getUsage, usageLines } from "./usage.js";
import { readWorkfile, workfileBase } from "./workfile.js";
import { attentionItems, coordinationLines, readCoordination } from "./coordinationstore.js";

export interface StatusQuery {
  view?: "summary" | "attention" | "output" | "results" | "plan";
  iteration?: number;
}

/** A bounded, read-only answer. Calling this never starts, joins, or resumes a task. */
export async function queryStatus(cwd: string, query: StatusQuery = {}): Promise<string> {
  const session = selectedSession(await readSnapshot(cwd));
  if (!session) return "No selected Kanban session.";
  const base = workfileBase(session.planPath);
  const live = loopProgress(cwd, base);
  const [plan, manifest, records, coordinator] = await Promise.all([
    readPlan(cwd, session.planPath), readLoopRun(cwd, base), readLoopLog(cwd, base), readCoordination(cwd, base),
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
  const attention = coordinator ? attentionItems(coordinator) : [];
  if (query.view === "attention") {
    const logged = await readAttention(cwd, 5).catch(() => []);
    return displayText([...header, ...(attention.length
      ? [`ATTENTION (${attention.length}) — nothing moves until these are answered:`,
         ...attention.map((item) => `- ${item}`),
         "",
         "Answer a waiting lane with /kanban answer <lane> <message>, or send the coordinator a",
         "general instruction with /kanban say <message>. A user message is always delivered, even",
         "when the campaign is out of budget."]
      : ["Nothing is waiting on you. No blocker, no unanswered lane question, no unhandled event."]),
      ...(logged.length ? ["", "Recent escalations (.kanban/attention.md):", ...logged] : []),
    ].join("\n")).slice(0, 12000);
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
    ].join("\n")), ...(selected.length ? [] : ["No completed iterations yet."]),
      ...(coordinator && query.iteration === undefined ? Object.values(coordinator.jobs).slice(-12).map((job) =>
        `${job.name}: ${job.state}; evidence ${job.accepted ? "accepted" : "not accepted"}; submitted revision ${job.revision}${job.acceptanceRevision ? `; accepted revision ${job.acceptanceRevision}` : ""}\n${(job.artifacts ?? []).join("\n")}${job.error ? `\n${job.error}` : ""}`) : []),
    ].join("\n\n")).slice(0, 12000);
  }
  const usage = getUsage(cwd, session.title);
  return displayText([...header,
    // Attention leads: a blocker or an unanswered child question is the only thing on this page
    // that requires the reader to act, and burying it under telemetry is why it goes unread.
    ...(attention.length ? [[`ATTENTION (${attention.length}) — see /kanban check attention:`,
      ...attention.slice(0, 6).map((item) => `- ${item}`),
      ...(attention.length > 6 ? [`- …and ${attention.length - 6} more`] : [])].join("\n")] : []),
    ...(live ? [`Activity: ${live.activity} (reported ${Math.max(0, Math.floor((Date.now() - live.updatedAt) / 1000))}s ago)`,
      `Iteration ${live.iteration}/${live.maxIterations} (attempt budget); ${live.childCount ?? (live.childRunning ? 1 : 0)} children running; ${live.jobCount ?? 0} jobs outstanding`,
      `Metric: baseline ${live.baseline ?? "—"}, latest ${live.latest ?? "—"}, best ${live.best ?? "—"}, target ${live.target ?? "not set"}`,
      ...(live.comment ? [`Latest decision: ${live.comment}`] : []),
    ] : (plan?.work.current ?? []).map((line) => `Checkpoint: ${line}`)),
    ...(coordinator ? coordinationLines(coordinator) : []),
    ...(manifest ? [`Saved result: ${records.length} attempts; best ${manifest.bestMetric ?? "—"}; branch ${manifest.branch}; commit ${manifest.bestCommit}`] : []),
    ...(usage ? usageLines(usage) : []),
    "Query output or results only when needed. Do not poll or keep a monitoring turn running.",
  ].join("\n")).slice(0, 12000);
}
