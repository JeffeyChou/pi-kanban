/** Deterministic one-step coordinator for the existing fitness/landing contract tests. */
import type { RunCoordinator } from "../src/coordinator.js";
import { IMPLEMENT_CHILD_TOOLS } from "../src/implementloop.js";
import { implementLoopPrompt, parseImplementLoopOutput } from "../src/prompts.js";
import { measure } from "../src/measure.js";

export const scriptedIteration: RunCoordinator = async (input) => {
  const child = await input.handle.child({
    cwd: input.worktree, tools: IMPLEMENT_CHILD_TOOLS, label: `implement ${input.iteration}/${input.loop.maxIterations}`,
    prompt: implementLoopPrompt({
      title: input.handle.title, prompt: input.goal, spec: input.spec,
      iteration: input.iteration, maxIterations: input.loop.maxIterations,
      lessons: input.lessons, hookNote: input.hookNote, validate: input.loop.validate,
      hasMetric: Boolean(input.loop.metric), metricName: input.loop.metric_name,
      direction: input.loop.direction, target: input.loop.target, bestMetric: input.bestMetric,
      decisionPolicy: input.loop.decisionPolicy,
    }),
  });
  if (child.result.errorKind === "model") throw new Error(`implement model did not resolve: ${child.result.error}`);
  const parsed = parseImplementLoopOutput(child.result.text);
  await input.handle.agents("implement", []);
  const measured = child.result.errorKind
    ? { validationPass: false, tail: child.result.error ?? "child failed", metricUnmeasured: true }
    : await (input.measure ?? measure)(input.worktree, input.loop, input.handle.signal, {
      KANBAN_ITERATION: String(input.iteration), KANBAN_MAX_ITERATIONS: String(input.loop.maxIterations),
      KANBAN_BASE: input.base, ...(input.bestMetric === undefined ? {} : { KANBAN_BEST_METRIC: String(input.bestMetric) }),
    });
  return {
    ...parsed, rationale: parsed.rationale ?? child.result.error ?? "no rationale", measured,
    revision: 1, loop: input.loop, goal: input.goal, spec: input.spec, evidence: false,
  };
};
