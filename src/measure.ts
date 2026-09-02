import { spawn } from "node:child_process";
import type { LoopConfig } from "./config.js";

export interface MeasureOutcome {
  /** `true` when `loop.validate` is unset (metric-only fitness), else exit code === 0. */
  validationPass: boolean;
  /** Bounded tail of the validation/metric output, for the discard lesson. */
  tail: string;
  /** Parsed `METRIC <name>=<value>`; absent when unmeasured or no metric is configured. */
  metric?: number;
  /** `loop.metric` is configured but this run produced no finite METRIC line. */
  metricUnmeasured: boolean;
}

export const MEASURE_TAIL_MAX_LINES = 40;

interface CommandOutcome {
  code: number | null;
  output: string;
  stdout: string;
  spawnError: boolean;
  timedOut: boolean;
  aborted: boolean;
}

function boundedTail(output: string): string {
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-MEASURE_TAIL_MAX_LINES).join("\n");
}

function commandFailed(result: CommandOutcome): boolean {
  return (
    result.code !== 0 ||
    result.spawnError ||
    result.timedOut ||
    result.aborted
  );
}

/**
 * Start one configured command in a separate process group. This is intentionally shell-backed:
 * loop commands are an explicit, user-authored opt-in and need normal shell composition such as
 * `npm test && npm run typecheck`.
 */
function runCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  if (signal.aborted) {
    return Promise.resolve({
      code: null,
      output: "",
      stdout: "",
      spawnError: false,
      timedOut: false,
      aborted: true,
    });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;

    const finish = (result: Omit<CommandOutcome, "output" | "stdout">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ...result, output, stdout });
    };

    const killGroup = () => {
      try {
        if (child.pid) {
          // `detached` makes the shell a group leader. Kill the group, not only bash, so a
          // backgrounded descendant cannot outlive a timeout or loop abort.
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // The child may have exited between its event and this kill attempt.
      }
    };

    const onAbort = () => {
      killGroup();
      finish({
        code: null,
        spawnError: false,
        timedOut: false,
        aborted: true,
      });
    };

    try {
      child = spawn("bash", ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({
        code: null,
        spawnError: true,
        timedOut: false,
        aborted: false,
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      output += text;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.once("error", () => {
      finish({
        code: null,
        spawnError: true,
        timedOut: false,
        aborted: false,
      });
    });
    child.once("close", (code) => {
      finish({
        code,
        spawnError: false,
        timedOut: false,
        aborted: false,
      });
    });

    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      killGroup();
      finish({
        code: null,
        spawnError: false,
        timedOut: true,
        aborted: false,
      });
    }, timeoutMs);
  });
}

/**
 * Last finite `METRIC <name>=<value>` line (a later duplicate wins). `name` narrows to one
 * metric name; undefined accepts any name. Non-finite values are ignored.
 */
export function parseMetric(output: string, name?: string): number | undefined {
  let latest: number | undefined;
  for (const line of output.split("\n")) {
    const match = /^METRIC\s+([^\s=]+)=([^\s]+)\s*$/.exec(line);
    if (!match || (name !== undefined && match[1] !== name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) latest = value;
  }
  return latest;
}

/**
 * Run `loop.validate` and (when set) `loop.metric` in `cwd`, shell-backed
 * (`spawn("bash", ["-c", cmd], { cwd, detached: true })`) and group-killed
 * (`process.kill(-pid)`) on `loop.measureTimeoutMs` or `signal`.
 *
 * Never throws: every failure becomes a MeasureOutcome with `validationPass: false`.
 */
export async function measure(
  cwd: string,
  loop: LoopConfig,
  signal: AbortSignal,
): Promise<MeasureOutcome> {
  if (signal.aborted) {
    return {
      validationPass: false,
      tail: "",
      metricUnmeasured: loop.metric !== undefined,
    };
  }

  try {
    const validation = loop.validate !== undefined
      ? await runCommand(cwd, loop.validate, loop.measureTimeoutMs, signal)
      : undefined;
    const metricCommand = loop.metric !== undefined
      ? await runCommand(cwd, loop.metric, loop.measureTimeoutMs, signal)
      : undefined;
    const metric = metricCommand
      ? parseMetric(metricCommand.stdout, loop.metric_name)
      : undefined;

    // An unavailable validation command, or a command interrupted before it can complete,
    // never establishes fitness. Metric-command exits do not redefine validation success; an
    // unmeasured metric independently makes the loop discard the candidate.
    const validationPass =
      !signal.aborted &&
      !(validation?.spawnError || validation?.timedOut || validation?.aborted) &&
      !(metricCommand?.spawnError || metricCommand?.timedOut || metricCommand?.aborted) &&
      (loop.validate === undefined || validation?.code === 0);
    const failingOutput = [validation, metricCommand].find(
      (result): result is CommandOutcome =>
        result !== undefined && commandFailed(result),
    )?.output;
    const combinedOutput = [validation?.output, metricCommand?.output]
      .filter((output): output is string => output !== undefined)
      .join("");

    return {
      validationPass,
      tail: boundedTail(failingOutput ?? combinedOutput),
      ...(metric === undefined ? {} : { metric }),
      metricUnmeasured: loop.metric !== undefined && metric === undefined,
    };
  } catch {
    // This is intentionally a final safety net. Measurement must be an observational seam and
    // never let a process-management edge case abort the surrounding orchestration run.
    return {
      validationPass: false,
      tail: "",
      metricUnmeasured: loop.metric !== undefined,
    };
  }
}
