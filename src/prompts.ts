import type { PlanSnapshot } from "./artifacts.js";
import type { KanbanConfig } from "./config.js";
import { STAGES, type Stage } from "./store.js";

export interface StageInputs {
  /** Original session prompt (plan.prompt). */
  prompt: string;
  title: string;
  /** Prior workfile sections (bodies without headings). */
  sections: Partial<Record<Stage, string>>;
  /** Research workers only. */
  researchAngle?: 1 | 2 | 3;
  /** Orchestrator-collected grill Q&A (compose input). */
  grillAnswers?: string;
  /** Critique only: tool-computed, bounded diff. */
  diff?: string;
}

export interface ParsedStageOutput {
  /** Text after the LAST `## <stage>` line; the whole text when absent (with a warning). */
  body: string;
  /** refine only; defaults to "standard". */
  verdict?: "simple" | "standard";
  /** grill only. */
  questions?: Array<{ q: string; recommended: string }>;
  /** critique only; missing/unparseable ⇒ "fail". */
  gate?: "pass" | "fail";
  /** critique FAIL bullets; empty ⇒ ["critique produced no parseable issues"]. */
  issues?: string[];
  /** True when the stage section heading was missing and the whole text was used. */
  parseWarning?: boolean;
}

/** One research angle per worker, in order (D2). */
export const RESEARCH_ANGLE_LABELS = [
  "repository structure and conventions",
  "affected code paths and facts",
  "validation commands and test layout",
] as const;

const RESEARCH_ANGLE_BRIEFS = [
  "Map the parts of this repository the request touches: module layout, naming and style conventions, the artifacts and durable files involved, and the rules the repository documents for changing them.",
  "Establish the concrete code facts the change depends on: the exact functions, types, call sites, and data shapes involved, each with its file path, and the behavior they have today.",
  "Establish how a change here is validated: the test layout, the commands the repository documents for type checking and testing, and where a new test for this work belongs. Discover them by READING configuration, scripts, and docs — never by running them.",
] as const;

const RESPONSIBILITIES: Record<Stage, string> = {
  refine:
    "State the goal, the audience, what is in and out of scope, the constraints that bind the work, and the success criteria that decide whether it is done. Resolve the request into something a later stage can act on; do not design the change and do not survey the repository beyond what the scope statement needs.",
  research:
    "Verify the repository facts, APIs, and external constraints the request depends on, with a file path for every claim. Report what IS, not what should be built.",
  grill:
    "Challenge the work: name the assumptions it rests on, the failure modes, the compatibility and safety risks, and the decisions still open. Settle what the repository can answer, and surface the rest as questions for the user.",
  compose:
    "Produce the decision-complete implementation spec: every file to change, the change in each, the order to make them in, the validation to run, and the risks to watch. A capable agent must be able to execute it without asking a further question.",
  implement:
    "Execute the composed spec and validate the result. Keep the durable Kanban record current at material milestones only.",
  critique:
    "Independently review the change against the composed spec and its validation evidence. Report what is wrong, not how you would have built it.",
};

const READ_ONLY_STAGES: Stage[] = ["refine", "research", "grill", "compose"];

function laterStages(stage: Stage): Stage[] {
  return STAGES.slice(STAGES.indexOf(stage) + 1);
}

function fence(body: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce(
    (width, match) => Math.max(width, match[0].length),
    0,
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return [ticks, body, ticks].join("\n");
}

function priorSections(sections: Partial<Record<Stage, string>>, stage: Stage): string[] {
  const lines: string[] = [];
  for (const prior of STAGES.slice(0, STAGES.indexOf(stage))) {
    const body = sections[prior]?.trim();
    if (!body) continue;
    lines.push("", `### Recorded ${prior} section`, "", body);
  }
  return lines.length ? ["", "## Prior stage findings", ...lines] : [];
}

function outputRules(stage: Stage, inputs: StageInputs): string[] {
  const rules = [
    "",
    "## Required output",
    "",
    `End your reply with a single \`## ${stage}\` heading followed by the section body. Everything after that heading is recorded verbatim as the \`## ${stage}\` section of the Kanban work file, so write nothing after it that does not belong in the record.`,
  ];
  if (stage === "refine")
    rules.push(
      "",
      "The section MUST contain a line `Verdict: simple` or `Verdict: standard`, followed by one sentence of justification. Use `simple` only when the request is small and self-evident enough that neither repository research nor an assumption review would change how it is built.",
    );
  if (stage === "research")
    rules.push(
      "",
      inputs.researchAngle
        ? `Report your angle only. Another worker covers each of the other angles, and the Kanban pipeline merges the ${RESEARCH_ANGLE_LABELS.length} sections.`
        : "Cover each research angle under its own `###` sub-heading.",
    );
  if (stage === "grill")
    rules.push(
      "",
      "Put what you settled yourself under a `### Settled` sub-heading. Then, under a `### Open questions` sub-heading, write every question that still needs the user's decision as a `Q:` line followed immediately by a `Recommended:` line carrying your best answer. Use exactly those two prefixes, one question per pair; the pipeline asks the user each pair and records the answers. Write no other `Q:` or `Recommended:` lines.",
    );
  if (stage === "compose")
    rules.push(
      "",
      "The section IS the spec: files to change with their paths, the change in each, the order of the changes, the exact validation commands to run afterwards, and the risks to watch. Decide every open choice; do not hand the reader options.",
    );
  if (stage === "critique")
    rules.push(
      "",
      "The section's FIRST line MUST be `Gate: PASS` or `Gate: FAIL`. When it is FAIL, follow that line with one `- ` bullet per issue, each naming the file and what is wrong. PASS only when the change matches the spec and the validation evidence holds; otherwise FAIL.",
    );
  return rules;
}

export function stagePrompt(stage: Stage, inputs: StageInputs): string {
  const later = laterStages(stage);
  const responsibility =
    stage === "research" && inputs.researchAngle
      ? `${RESEARCH_ANGLE_BRIEFS[inputs.researchAngle - 1]}\n\nYour angle is ${inputs.researchAngle} of ${RESEARCH_ANGLE_LABELS.length}: ${RESEARCH_ANGLE_LABELS[inputs.researchAngle - 1]}.`
      : RESPONSIBILITIES[stage];
  const lines: string[] = [
    `# Kanban ${stage} stage — “${inputs.title}”`,
    "",
    `You are executing exactly the ${stage} stage of the Kanban workflow.`,
    later.length
      ? `Do NOT do a later stage's work (${later.join(", ")}); each of those stages has its own owner and runs after this one.`
      : "This is the last stage of the workflow.",
    "",
    "## Original request",
    "",
    inputs.prompt.trim() || inputs.title,
    ...priorSections(inputs.sections, stage),
  ];

  if (stage === "compose" && inputs.grillAnswers?.trim())
    lines.push("", "## User answers recorded during grill", "", inputs.grillAnswers.trim());

  if (stage === "critique")
    lines.push(
      "",
      "## Working tree diff (computed by Kanban; the only evidence of the change)",
      "",
      inputs.diff?.trim()
        ? fence(inputs.diff.trim())
        : "No diff was captured. Treat an empty diff as a failed review unless the recorded spec required no change.",
    );

  lines.push("", "## Your single responsibility", "", responsibility, "", "## Working rules", "");
  if (READ_ONLY_STAGES.includes(stage))
    lines.push(
      "- Investigate read-only: read, grep, find, and list files. Do not edit files and do not run commands.",
    );
  if (stage === "critique")
    lines.push(
      "- Investigate read-only: read, grep, find, and list files, plus the diff above. Do not edit files and do not run commands.",
    );
  lines.push(
    "- Cite a file path (with line numbers when it helps) for every claim you make about this repository.",
    `- Stay inside the ${stage} responsibility above; leave everything else to the stage that owns it.`,
    "- Be concise and concrete. No preamble, no restatement of these rules, no questions back to the user outside the required output format.",
    ...outputRules(stage, inputs),
  );
  return `${lines.join("\n")}\n`;
}

export function stageSystemPrompt(stage: Stage): string {
  const readOnly =
    READ_ONLY_STAGES.includes(stage) || stage === "critique"
      ? " Work read-only: never edit a file and never run a command."
      : "";
  return `You are the Kanban ${stage} agent for a software repository. You do exactly the ${stage} stage and nothing that belongs to a later stage.${readOnly} Reply with the one Markdown section you were asked for and nothing else.`;
}

function headingIndex(lines: string[], stage: Stage): number {
  const heading = new RegExp(`^\\s{0,3}##\\s+${stage}\\s*:?\\s*$`, "i");
  let index = -1;
  for (const [position, line] of lines.entries()) if (heading.test(line)) index = position;
  return index;
}

function labelled(line: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.*)$`, "i").exec(
    line,
  );
  return match ? match[1]!.trim() : undefined;
}

function parseQuestions(body: string): Array<{ q: string; recommended: string }> {
  const questions: Array<{ q: string; recommended: string }> = [];
  let pending: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const question = labelled(line, "Q");
    if (question !== undefined) {
      pending = question || undefined;
      continue;
    }
    const recommended = labelled(line, "Recommended");
    if (recommended === undefined) continue;
    if (pending && recommended) questions.push({ q: pending, recommended });
    pending = undefined;
  }
  return questions;
}

function parseIssues(body: string, gateLine: number): string[] {
  const issues: string[] = [];
  for (const line of body.split(/\r?\n/).slice(gateLine + 1)) {
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (match) issues.push(match[1]!);
  }
  return issues;
}

export function parseStageOutput(stage: Stage, text: string): ParsedStageOutput {
  const source = text ?? "";
  const lines = source.split(/\r?\n/);
  const index = headingIndex(lines, stage);
  const parseWarning = index === -1;
  const body = (parseWarning ? source : lines.slice(index + 1).join("\n")).trim();
  const parsed: ParsedStageOutput = { body, ...(parseWarning ? { parseWarning: true } : {}) };

  if (stage === "refine") {
    let verdict: "simple" | "standard" = "standard";
    for (const line of (body || source).split(/\r?\n/)) {
      const value = labelled(line, "Verdict");
      if (value && /^simple\b/i.test(value)) verdict = "simple";
      else if (value && /^standard\b/i.test(value)) verdict = "standard";
    }
    return { ...parsed, verdict };
  }

  if (stage === "grill") return { ...parsed, questions: parseQuestions(body) };

  if (stage === "critique") {
    const bodyLines = body.split(/\r?\n/);
    let gateLine = -1;
    let gate: "pass" | "fail" = "fail";
    for (const [position, line] of bodyLines.entries()) {
      const value = labelled(line, "Gate");
      if (value === undefined) continue;
      if (/^pass\b/i.test(value)) gate = "pass";
      else if (/^fail\b/i.test(value)) gate = "fail";
      else continue;
      gateLine = position;
      break;
    }
    if (gate === "pass") return { ...parsed, gate, issues: [] };
    const issues = parseIssues(body, gateLine);
    return {
      ...parsed,
      gate,
      issues: issues.length ? issues : ["critique produced no parseable issues"],
    };
  }

  return parsed;
}

/** The ONLY text that may carry the configured init-start command and external tools line. */
export function implementKickoff(
  config: KanbanConfig,
  externalTools: string[],
  spec: string | undefined,
): string {
  const lines = [
    "Kanban implement stage. The pipeline stages are finished; execute the composed spec in this conversation.",
  ];
  if (config.init.start)
    lines.push(
      "",
      `Run \`${config.init.start}\` first, then read the selected plan it names.`,
    );
  if (externalTools.length)
    lines.push(
      "",
      `External tools detected in this Pi session and available for this work: ${externalTools.join(", ")}.`,
    );
  lines.push(
    "",
    "Checkpoint contract: call `kanban_update` with `checkpoint` only at material milestones — a scope change, an agent-roster change, a meaningful work-summary change, or a new handoff note. Never call it per file, command, or tool call. Call `stage_complete` once the whole implementation is done and validated; that arms the critique gate.",
  );
  lines.push(
    "",
    spec?.trim()
      ? `Composed spec (authoritative):\n\n${spec.trim()}`
      : "Composed spec: spec unavailable — no compose section was recorded for this session. Work from the selected plan and the handoff instead, and confirm the scope before making changes.",
  );
  return lines.join("\n");
}

/** The ONLY text that may carry the configured init-check command. */
export function completionText(config: KanbanConfig, plan: PlanSnapshot): string {
  const lines = [`Completed the Kanban session “${plan.title}”.`];
  if (config.init.check)
    lines.push("", `Run \`${config.init.check}\` and report its result before handing off.`);
  const completion = plan.completion;
  if (completion?.critique === "accepted-issues" && completion.note?.trim())
    lines.push(
      "",
      "Completed with accepted critique issues:",
      "",
      completion.note.trim(),
    );
  lines.push(
    "",
    `Kanban stages verified session changes at final completion when their ownership is known. Review the staged diff, then decide whether to commit. Suggested commit: kanban: ${plan.title}`,
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------ *
 * The implement-experiment loop (plan v2.5). One prompt per iteration; the `Status:` verdict
 * GATES the advance, so the grammar is as load-bearing as the critique gate's `Gate:` line.
 * ------------------------------------------------------------------------------------------ */

export interface ImplementLoopInputs {
  title: string;
  /** Original session prompt (plan.prompt). */
  prompt: string;
  /** The recorded `## compose` section — the spec being implemented. */
  spec?: string;
  /** The bounded living summary of earlier iterations (`.kanban/loop/<base>.md`). */
  lessons?: string;
  iteration: number;
  maxIterations: number;
  /** The fitness signals, described (never executed) for the child. */
  validate?: string;
  /** True when `loop.metric` is configured; `direction` alone always has a default. */
  hasMetric?: boolean;
  metricName?: string;
  direction?: "higher" | "lower";
  /** The host's final safety policy for an agent keep/revert decision. */
  decisionPolicy?: "strict-metric" | "agent-with-validation";
  target?: number;
  /** Best metric so far, for context. */
  bestMetric?: number;
  /** Bounded stdout of an opt-in before-iteration hook. */
  hookNote?: string;
}

export interface ImplementLoopVerdict {
  /** `complete` gates SUCCESS; anything unparseable is `continue` (never a false success). */
  verdict: "complete" | "continue";
  /** One-line self-report recorded with the iteration. */
  rationale?: string;
  /** The experiment agent's explicit disposition for its candidate. */
  decision: "keep" | "revert";
}

function fitnessLines(inputs: ImplementLoopInputs): string[] {
  const lines: string[] = ["", "## How your work is judged", ""];
  if (inputs.validate)
    lines.push(
      `- Kanban runs \`${inputs.validate}\` in this worktree after you stop. A non-zero exit discards everything you did in this iteration.`,
    );
  else
    lines.push(
      "- No validation command is configured, so the metric below is the only fitness signal.",
    );
  if (inputs.hasMetric) {
    const goal =
      inputs.direction === "lower" ? "strictly lower" : "strictly higher";
    lines.push(
      inputs.decisionPolicy === "agent-with-validation"
        ? `- A metric${inputs.metricName ? ` (\`${inputs.metricName}\`)` : ""} is recorded for every attempt. You decide whether its trade-off is worth keeping, but Kanban rejects a missing metric and any failed validation${inputs.target === undefined ? "" : `; the target is ${inputs.target}`}.`
        : `- A metric${inputs.metricName ? ` (\`${inputs.metricName}\`)` : ""} is also measured, and your work is kept only when it is ${goal} than the best so far${inputs.bestMetric === undefined ? "" : ` (${inputs.bestMetric})`}${inputs.target === undefined ? "" : `; the target is ${inputs.target}`}.`,
    );
  }
  lines.push(
    "- A discarded iteration is reverted completely, and only the lesson survives. A kept iteration becomes the base the next iteration builds on.",
  );
  return lines;
}

/** The per-iteration implement prompt: spec + injected lessons + the smallest-change rule. */
export function implementLoopPrompt(inputs: ImplementLoopInputs): string {
  const lines: string[] = [
    `# Kanban implement stage — iteration ${inputs.iteration} of ${inputs.maxIterations} — “${inputs.title}”`,
    "",
    "You are executing the implement stage of the Kanban workflow as ONE experiment in an iterative loop.",
    "Your working directory is a private experiment worktree. Kept iterations are committed by Kanban to the session's kanban-autoresearch branch; reverted iterations are discarded completely.",
    "",
    "## Original request",
    "",
    inputs.prompt.trim() || inputs.title,
  ];
  if (inputs.spec?.trim())
    lines.push("", "## The recorded spec — implement exactly this", "", inputs.spec.trim());
  else
    lines.push(
      "",
      "## The recorded spec",
      "",
      "No compose section was recorded. Implement the original request directly, and keep the change minimal.",
    );
  if (inputs.lessons?.trim())
    lines.push(
      "",
      "## What earlier iterations already learned — do not repeat a failed hypothesis",
      "",
      inputs.lessons.trim(),
    );
  if (inputs.hookNote?.trim())
    lines.push("", "## Repository note for this iteration", "", inputs.hookNote.trim());
  lines.push(...fitnessLines(inputs));
  lines.push(
    "",
    "## Working rules",
    "",
    "- Make the SMALLEST change that advances the spec. One coherent step per iteration; the loop runs again after this one.",
    "- Read before you write: this worktree already contains any change earlier iterations got kept.",
    "- You can read, search, edit and write files. You have NO shell: you cannot run commands, tests, or git. Kanban runs the validation for you, so do not ask for it and do not fake evidence of it.",
    "- Stay inside this worktree. Never edit an absolute path outside it and never reach upwards with `../`.",
    "- Follow the repository's own conventions and its AGENTS.md; Kanban, not you, stages or commits an accepted experiment.",
    "",
    "## Required output",
    "",
    "End your reply with exactly these three lines:",
    "",
    "`Status: complete` when the recorded spec is now FULLY implemented and you would hand it to review, or `Status: continue` when more iterations are needed.",
    "`Rationale: <one line>` — what you changed this iteration and why.",
    "`Decision: keep` when this candidate should become the next experiment base, or `Decision: revert` when it should be discarded. State your real judgement; Kanban still enforces validation and configured-metric safety.",
    "",
    "`Status: complete` is a claim Kanban acts on: it ends the loop and advances the session to critique. Only write it when the spec is genuinely finished.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Last `Status:` line wins; anything unparseable is `continue`.
 *
 * The value must be EXACTLY `complete` or `continue` (markdown emphasis and trailing
 * punctuation aside). A prefix match would score a line that merely ECHOES the required
 * grammar — `- Status: complete when the spec is met` — as a real verdict, and since this
 * verdict gates the stage advance, leniency here buys a false advance.
 */
export function parseImplementLoopOutput(text: string): ImplementLoopVerdict {
  let verdict: "complete" | "continue" = "continue";
  let rationale: string | undefined;
  // `keep` is the compatibility default for an existing iteration child which
  // predates the explicit decision grammar. New prompts require the line.
  let decision: "keep" | "revert" = "keep";
  for (const line of (text ?? "").split(/\r?\n/)) {
    const status = labelled(line, "Status");
    if (status !== undefined) {
      const value = status.replace(/[`*_]/g, "").replace(/[.!;,]+$/, "").trim().toLowerCase();
      if (value === "complete") verdict = "complete";
      else if (value === "continue") verdict = "continue";
      continue;
    }
    const reason = labelled(line, "Rationale");
    if (reason) rationale = reason;
    const disposition = labelled(line, "Decision");
    if (disposition !== undefined) {
      const value = disposition.replace(/[`*_]/g, "").replace(/[.!;,]+$/, "").trim().toLowerCase();
      if (value === "keep") decision = "keep";
      else if (value === "revert" || value === "discard") decision = "revert";
    }
  }
  return { verdict, decision, ...(rationale ? { rationale } : {}) };
}
