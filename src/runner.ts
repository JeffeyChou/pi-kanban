import { spawn } from "node:child_process";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  createAgentSession,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { KanbanConfig } from "./config.js";

export type ErrorKind = "spawn" | "model" | "aborted" | "other";

export interface ChildResult {
  /** Final assistant text; "" on failure. */
  text: string;
  aborted: boolean;
  errorKind?: ErrorKind;
  error?: string;
}

export interface ChildSpec {
  cwd: string;
  /** Defaults to getAgentDir(). */
  agentDir?: string;
  /** The stage prompt — delivered via prompt()/stdin, never argv. */
  prompt: string;
  /** Short per-stage system prompt. */
  systemPrompt: string;
  /** REQUIRED — resolved by the caller; never defaulted by the runner. */
  model: Model<any>;
  tools: string[];
  signal: AbortSignal;
  onStatus?: (line: string) => void;
}

export type RunChild = (spec: ChildSpec) => Promise<ChildResult>;

type RunnerDependencies = {
  DefaultResourceLoader: typeof DefaultResourceLoader;
  createAgentSession: typeof createAgentSession;
  getAgentDir: typeof getAgentDir;
  SessionManager: typeof SessionManager;
  spawn: typeof spawn;
};

/**
 * Tests may replace individual runtime dependencies through this intentionally private
 * global hook. It keeps the frozen exported runner seam unchanged while allowing unit
 * coverage of the child-session setup without authenticating a real model.
 */
function runnerDependencies(): RunnerDependencies {
  const overrides = (
    globalThis as typeof globalThis & {
      __kanbanRunnerDependencies?: Partial<RunnerDependencies>;
    }
  ).__kanbanRunnerDependencies;
  return {
    DefaultResourceLoader,
    createAgentSession,
    getAgentDir,
    SessionManager,
    spawn,
    ...overrides,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStatus(spec: ChildSpec, line: string): void {
  try {
    spec.onStatus?.(line);
  } catch {
    // A display callback must not turn child execution into a rejected promise.
  }
}

function abortedResult(): ChildResult {
  return { text: "", aborted: true, errorKind: "aborted" };
}

function finalAssistantMessage(session: {
  messages: Array<{
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  }>;
}): { stopReason?: string; errorMessage?: string } | undefined {
  return [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant");
}

function modelResolutionFailure(output: string): boolean {
  return /(?:model|provider)[\s\S]{0,120}(?:resolv|configur|select|available|not found|unknown|missing)|(?:resolv|configur|select|available|not found|unknown|missing)[\s\S]{0,120}(?:model|provider)/i.test(
    output,
  );
}

/** In-process backend: extension-free loader + createAgentSession + in-memory sessions. */
export function createInProcessRunner(): RunChild {
  return async (spec) => {
    if (spec.signal.aborted) return abortedResult();

    const dependencies = runnerDependencies();
    let session:
      | {
          abort: () => Promise<void>;
          dispose: () => void;
          getLastAssistantText: () => string | undefined;
          messages: Array<{
            role?: string;
            stopReason?: string;
            errorMessage?: string;
          }>;
          prompt: (prompt: string) => Promise<void>;
        }
      | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const agentDir = spec.agentDir ?? dependencies.getAgentDir();
      const loader = new dependencies.DefaultResourceLoader({
        cwd: spec.cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: spec.systemPrompt,
      });
      await loader.reload();

      if (spec.signal.aborted) return abortedResult();

      const created = await dependencies.createAgentSession({
        cwd: spec.cwd,
        agentDir,
        model: spec.model,
        tools: spec.tools,
        resourceLoader: loader,
        sessionManager: dependencies.SessionManager.inMemory(spec.cwd),
      });
      session = created.session;

      onAbort = () => {
        void session?.abort().catch(() => undefined);
      };
      spec.signal.addEventListener("abort", onAbort, { once: true });
      if (spec.signal.aborted) {
        onAbort();
        return abortedResult();
      }

      reportStatus(spec, "Running in-process child session.");
      await session.prompt(spec.prompt);

      if (spec.signal.aborted) return abortedResult();
      const final = finalAssistantMessage(session);
      if (final?.stopReason === "error") {
        return {
          text: "",
          aborted: false,
          errorKind: "model",
          error:
            final.errorMessage ??
            session.getLastAssistantText() ??
            "child model request failed",
        };
      }
      if (final?.stopReason === "aborted") return abortedResult();
      return { text: session.getLastAssistantText() ?? "", aborted: false };
    } catch (error: unknown) {
      if (spec.signal.aborted) return abortedResult();
      return {
        text: "",
        aborted: false,
        errorKind: "other",
        error: errorText(error),
      };
    } finally {
      if (onAbort) spec.signal.removeEventListener("abort", onAbort);
      try {
        session?.dispose();
      } catch {
        // Disposal is best-effort and must not turn a ChildResult into a throw.
      }
    }
  };
}

/** Subprocess backend: `pi -p` with full isolation flags; prompt via stdin. */
export function createSubprocessRunner(): RunChild {
  return createSubprocessRunnerFor("pi");
}

function createSubprocessRunnerFor(piBin: string): RunChild {
  return async (spec) => {
    if (spec.signal.aborted) return abortedResult();

    const args = [
      "-p",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-session",
      "--provider",
      spec.model.provider,
      "--model",
      spec.model.id,
      "--tools",
      spec.tools.join(","),
      "--system-prompt",
      spec.systemPrompt,
    ];

    return new Promise<ChildResult>((resolve) => {
      const dependencies = runnerDependencies();
      let settled = false;
      let aborted = false;
      let stdout = "";
      let stderr = "";
      let child: ReturnType<typeof spawn> | undefined;

      const finish = (result: ChildResult) => {
        if (settled) return;
        settled = true;
        spec.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        aborted = true;
        try {
          child?.kill();
        } catch {
          // A process that has already exited needs no additional handling.
        }
        finish(abortedResult());
      };

      try {
        child = dependencies.spawn(piBin, args, {
          cwd: spec.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error: unknown) {
        finish({
          text: "",
          aborted: false,
          errorKind: "spawn",
          error: errorText(error),
        });
        return;
      }

      spec.signal.addEventListener("abort", onAbort, { once: true });
      if (spec.signal.aborted) {
        onAbort();
        return;
      }

      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;
      const stdinStream = child.stdin;
      if (!stdoutStream || !stderrStream || !stdinStream) {
        finish({
          text: "",
          aborted: false,
          errorKind: "other",
          error: "subprocess did not provide standard I/O streams",
        });
        return;
      }

      reportStatus(spec, "Running subprocess child session.");
      stdoutStream.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      stderrStream.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      stdinStream.on("error", () => undefined);
      child.on("error", (error: Error) => {
        finish({
          text: "",
          aborted: false,
          errorKind: "spawn",
          error: errorText(error),
        });
      });
      child.on("close", (code: number | null) => {
        if (aborted || spec.signal.aborted) {
          finish(abortedResult());
          return;
        }
        if (code === 0) {
          finish({ text: stdout.trim(), aborted: false });
          return;
        }
        const output = `${stderr}\n${stdout}`.trim();
        finish({
          text: "",
          aborted: false,
          errorKind: modelResolutionFailure(output) ? "model" : "other",
          error: output || `pi exited with code ${code ?? "unknown"}`,
        });
      });
      try {
        stdinStream.end(spec.prompt);
      } catch (error: unknown) {
        finish({
          text: "",
          aborted: false,
          errorKind: "other",
          error: errorText(error),
        });
      }
    });
  };
}

export function selectRunner(config: KanbanConfig): RunChild {
  return config.runner === "subprocess"
    ? createSubprocessRunnerFor(config.piBin)
    : createInProcessRunner();
}
