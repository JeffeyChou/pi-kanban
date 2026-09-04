import assert from "node:assert/strict";
import test from "node:test";
import type { PlanSnapshot } from "../src/artifacts.js";
import type { KanbanConfig } from "../src/config.js";
import {
  RESEARCH_ANGLE_LABELS,
  completionText,
  implementKickoff,
  implementLoopPrompt,
  parseImplementLoopOutput,
  parseStageOutput,
  stagePrompt,
  stageSystemPrompt,
  type StageInputs,
} from "../src/prompts.js";
import { STAGES, type Stage } from "../src/store.js";

function config(overrides: Partial<KanbanConfig> = {}): KanbanConfig {
  return {
    models: {
      refine: null,
      research: null,
      grill: null,
      compose: null,
      implement: null,
      critique: null,
    },
    research: { workers: 3 },
    fastPath: true,
    critique: true,
    runner: "auto",
    piBin: "pi",
    init: {},
    loop: {
      enabled: false,
      direction: "higher",
      maxIterations: 10,
      noImprovementStreak: 3,
      measureTimeoutMs: 300_000,
      hooks: false,
    },
    ...overrides,
  };
}

function inputs(overrides: Partial<StageInputs> = {}): StageInputs {
  return {
    prompt: "Refresh the durable board persistence",
    title: "Durable board refresh",
    sections: {},
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): PlanSnapshot {
  return {
    title: "Durable board refresh",
    prompt: "Refresh the durable board persistence",
    stage: "critique",
    status: "active",
    inScope: [],
    outOfScope: [],
    agents: [],
    work: { done: [], current: [], next: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as PlanSnapshot;
}

test("every stage prompt names its stage, forbids later-stage work, and never mentions init", () => {
  for (const stage of STAGES) {
    const prompt = stagePrompt(stage, inputs({ diff: "diff --git a b" }));
    const system = stageSystemPrompt(stage);
    assert.match(prompt, new RegExp(`exactly the ${stage} stage`));
    assert.match(prompt, new RegExp(`## ${stage}`));
    assert.match(system, new RegExp(`${stage} agent`));
    const later = STAGES.slice(STAGES.indexOf(stage) + 1);
    if (later.length) {
      assert.match(prompt, /Do NOT do a later stage's work/);
      for (const stageName of later) assert.match(prompt, new RegExp(stageName));
    }
    assert.doesNotMatch(prompt, /init/i);
    assert.doesNotMatch(system, /init/i);
  }
});

test("stage prompts carry the request, prior sections, grill answers, and the critique diff", () => {
  const composePrompt = stagePrompt(
    "compose",
    inputs({
      sections: { refine: "Goal: keep plans compact", research: "store.ts owns the lock" },
      grillAnswers: "Q: cap sections?\nA: yes, 300 lines",
    }),
  );
  assert.match(composePrompt, /Refresh the durable board persistence/);
  assert.match(composePrompt, /Goal: keep plans compact/);
  assert.match(composePrompt, /store\.ts owns the lock/);
  assert.match(composePrompt, /Q: cap sections\?/);
  // Prior sections stop at the current stage.
  assert.doesNotMatch(
    stagePrompt("refine", inputs({ sections: { compose: "later section" } })),
    /later section/,
  );
  const critiquePrompt = stagePrompt("critique", inputs({ diff: "diff --git a/src b/src" }));
  assert.match(critiquePrompt, /diff --git a\/src b\/src/);
  assert.match(critiquePrompt, /Gate: PASS/);
  assert.match(
    stagePrompt("critique", inputs()),
    /No diff was captured/,
  );
});

test("research prompts have one per-worker variant per angle", () => {
  const angles = ([1, 2, 3] as const).map((angle) =>
    stagePrompt("research", inputs({ researchAngle: angle })),
  );
  for (const [index, prompt] of angles.entries()) {
    assert.match(prompt, new RegExp(RESEARCH_ANGLE_LABELS[index]!));
    assert.match(prompt, new RegExp(`Your angle is ${index + 1} of 3`));
  }
  assert.notEqual(angles[0], angles[1]);
  assert.notEqual(angles[1], angles[2]);
  // Manual mode has no worker index and asks for every angle in one section.
  assert.match(stagePrompt("research", inputs()), /Cover each research angle/);
});

test("parseStageOutput takes the body after the LAST stage heading, with a whole-text fallback", () => {
  const parsed = parseStageOutput(
    "refine",
    ["## refine", "stale draft", "", "## refine", "Goal: ship it", "Verdict: standard"].join("\n"),
  );
  assert.equal(parsed.body, "Goal: ship it\nVerdict: standard");
  assert.equal(parsed.parseWarning, undefined);

  const fallback = parseStageOutput("compose", "no heading at all");
  assert.equal(fallback.body, "no heading at all");
  assert.equal(fallback.parseWarning, true);
});

test("refine verdicts default to standard and read simple only when stated", () => {
  assert.equal(parseStageOutput("refine", "## refine\nGoal only").verdict, "standard");
  assert.equal(
    parseStageOutput("refine", "## refine\n**Verdict**: simple — one file").verdict,
    "simple",
  );
  assert.equal(parseStageOutput("refine", "## refine\n- Verdict: SIMPLE").verdict, "simple");
  assert.equal(parseStageOutput("refine", "## refine\nVerdict: standard").verdict, "standard");
  assert.equal(parseStageOutput("refine", "Verdict: simple").verdict, "simple");
});

test("grill parses Q:/Recommended: pairs and reports none when unparseable", () => {
  const parsed = parseStageOutput(
    "grill",
    [
      "## grill",
      "### Settled",
      "- The lock already serializes writes.",
      "### Open questions",
      "Q: Cap the workfile sections?",
      "Recommended: yes, 300 lines per section",
      "Q: Delete the workfile at completion?",
      "Recommended: yes",
    ].join("\n"),
  );
  assert.deepEqual(parsed.questions, [
    { q: "Cap the workfile sections?", recommended: "yes, 300 lines per section" },
    { q: "Delete the workfile at completion?", recommended: "yes" },
  ]);
  assert.match(parsed.body, /The lock already serializes writes/);
  assert.deepEqual(
    parseStageOutput("grill", "## grill\nJust prose, no pairs at all.").questions,
    [],
  );
  // A question without a recommendation is not a pair.
  assert.deepEqual(parseStageOutput("grill", "## grill\nQ: unanswered?").questions, []);
});

test("critique gate parsing defaults to FAIL with a safe issue list", () => {
  const passed = parseStageOutput("critique", "## critique\nGate: PASS\nAll checks match the spec.");
  assert.equal(passed.gate, "pass");
  assert.deepEqual(passed.issues, []);

  const failed = parseStageOutput(
    "critique",
    ["## critique", "Gate: FAIL", "- src/store.ts: token is never cleared", "- no test covers the cap"].join(
      "\n",
    ),
  );
  assert.equal(failed.gate, "fail");
  assert.deepEqual(failed.issues, [
    "src/store.ts: token is never cleared",
    "no test covers the cap",
  ]);

  const unparseable = parseStageOutput("critique", "the model rambled without a verdict");
  assert.equal(unparseable.gate, "fail");
  assert.deepEqual(unparseable.issues, ["critique produced no parseable issues"]);
  assert.equal(unparseable.parseWarning, true);

  const bare = parseStageOutput("critique", "## critique\nGate: FAIL");
  assert.deepEqual(bare.issues, ["critique produced no parseable issues"]);
});

test("stage output parsing exposes only the fields its stage owns", () => {
  const research = parseStageOutput("research", "## research\nfacts");
  assert.equal(research.verdict, undefined);
  assert.equal(research.questions, undefined);
  assert.equal(research.gate, undefined);
  const grill: Stage = "grill";
  assert.notEqual(parseStageOutput(grill, "## grill\n").questions, undefined);
});

test("implementKickoff carries init-start, external tools, the checkpoint contract, and the spec", () => {
  const full = implementKickoff(
    config({ init: { start: "./init.sh", check: "./init.sh --check" } }),
    ["subagent", "ask_user_question"],
    "Change src/store.ts, then run the tests.",
  );
  assert.match(full, /Run `\.\/init\.sh` first/);
  assert.doesNotMatch(full, /--check/);
  assert.match(full, /subagent, ask_user_question/);
  assert.match(full, /kanban_update/);
  assert.match(full, /stage_complete/);
  assert.match(full, /Change src\/store\.ts, then run the tests\./);

  const bare = implementKickoff(config(), [], undefined);
  assert.doesNotMatch(bare, /init/i);
  assert.doesNotMatch(bare, /External tools detected/);
  assert.match(bare, /spec unavailable/);
});

test("completionText carries init-check, the suggested commit, and accepted issues", () => {
  const withCheck = completionText(
    config({ init: { check: "./init.sh --check" } }),
    plan({ completion: { critique: "pass" } }),
  );
  assert.match(withCheck, /Run `\.\/init\.sh --check`/);
  assert.match(withCheck, /Suggested commit: kanban: Durable board refresh/);
  assert.doesNotMatch(withCheck, /accepted critique issues/);

  const accepted = completionText(
    config(),
    plan({
      completion: {
        critique: "accepted-issues",
        note: "- store.ts: token cleanup untested\n- docs not updated",
      },
    }),
  );
  assert.doesNotMatch(accepted, /init/i);
  assert.match(accepted, /accepted critique issues/);
  assert.match(accepted, /token cleanup untested/);
  assert.match(accepted, /Suggested commit/);
});

test("the implement loop prompt carries the spec, the lessons, and the verdict grammar", () => {
  const prompt = implementLoopPrompt({
    title: "Loop session",
    prompt: "Raise the value",
    spec: "Edit app.ts so that value is larger.",
    lessons: "Iteration 1 tried a bad edit. Discarded because the validation command failed.",
    iteration: 2,
    maxIterations: 5,
    validate: "npm test",
    hasMetric: true,
    metricName: "score",
    direction: "higher",
    target: 10,
    bestMetric: 4,
  });
  assert.match(prompt, /iteration 2 of 5/);
  assert.match(prompt, /Edit app\.ts so that value is larger\./);
  assert.match(prompt, /Discarded because the validation command failed\./);
  assert.match(prompt, /`npm test`/);
  assert.match(prompt, /strictly higher than the best so far \(4\); the target is 10/);
  assert.match(prompt, /You have NO shell/);
  assert.match(prompt, /Status: complete/);
  assert.match(prompt, /Rationale: <one line>/);
  // The loop prompt must never carry an init command (AGENTS.md).
  assert.equal(/init\.sh/.test(prompt), false);
});

test("the implement loop prompt omits the metric prose when no metric is configured", () => {
  const prompt = implementLoopPrompt({
    title: "Loop session",
    prompt: "Raise the value",
    iteration: 1,
    maxIterations: 3,
    validate: "npm test",
  });
  assert.equal(/A metric/.test(prompt), false);
  assert.match(prompt, /No compose section was recorded/);
});

test("the implement verdict defaults to continue and takes the last Status line", () => {
  assert.deepEqual(parseImplementLoopOutput("Status: complete\nRationale: done"), {
    verdict: "complete",
    decision: "keep",
    rationale: "done",
  });
  assert.deepEqual(parseImplementLoopOutput("**Status:** continue"), { verdict: "continue", decision: "keep" });
  assert.deepEqual(parseImplementLoopOutput("Status: complete\nStatus: continue"), {
    verdict: "continue",
    decision: "keep",
  });
  assert.deepEqual(parseImplementLoopOutput("no verdict at all"), { verdict: "continue", decision: "keep" });
  // A line that merely ECHOES the required grammar must never score as a verdict: this verdict
  // gates the stage advance, so prefix leniency would buy a false advance.
  assert.deepEqual(parseImplementLoopOutput("- Status: complete when the spec is met"), {
    verdict: "continue",
    decision: "keep",
  });
  assert.deepEqual(parseImplementLoopOutput("Status: continue for now, then complete"), {
    verdict: "continue",
    decision: "keep",
  });
  // Markdown emphasis and trailing punctuation around a real verdict still parse.
  assert.deepEqual(parseImplementLoopOutput("Status: **complete**."), { verdict: "complete", decision: "keep" });
  assert.deepEqual(parseImplementLoopOutput(""), { verdict: "continue", decision: "keep" });
  // Case-insensitive, but only for an exact verdict: trailing prose is not a verdict.
  assert.deepEqual(parseImplementLoopOutput("Status: COMPLETE\nRationale: shipped"), {
    verdict: "complete",
    decision: "keep",
    rationale: "shipped",
  });
  assert.deepEqual(parseImplementLoopOutput("Status: Complete now\nRationale: shipped"), {
    verdict: "continue",
    decision: "keep",
    rationale: "shipped",
  });
  assert.deepEqual(parseImplementLoopOutput("Status: continue\nDecision: revert"), {
    verdict: "continue",
    decision: "revert",
  });
});
