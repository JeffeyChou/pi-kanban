import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  createAgentSession,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { KanbanConfig } from "./config.js";
import { appendLiveOutput, updateLoopProgress } from "./liveprogress.js";
import { reportUsage } from "./usage.js";

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
  if (spec.signal.aborted) return;
  updateLoopProgress(spec.signal, { activity: line });
  try {
    spec.onStatus?.(line);
  } catch {
    // A display callback must not turn child execution into a rejected promise.
  }
}

/** Report activity categories only, never model thoughts, tool arguments, or output. */
function eventStatus(event: AgentSessionEvent): string | undefined {
  if (event.type === "tool_execution_start") return `using ${event.toolName}`;
  if (event.type === "tool_execution_end") return `${event.toolName} finished; model working`;
  if (event.type === "turn_start") return "model working";
  if (event.type === "message_update") {
    const type = event.assistantMessageEvent.type;
    if (type === "thinking_delta") return "model thinking";
    if (type === "text_delta") return "writing findings";
  }
  if (event.type === "auto_retry_start") return `retry ${event.attempt}/${event.maxAttempts}`;
  if (event.type === "compaction_start") return "compacting child context";
  return undefined;
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
          subscribe?: (listener: (event: AgentSessionEvent) => void) => () => void;
          getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
          getSessionStats?: () => { tokens: { total: number }; cost: number; assistantMessages: number };
        }
      | undefined;
    let onAbort: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let sampledAt = 0;
    const sampleUsage = () => {
      try {
        const context = session?.getContextUsage?.();
        const stats = session?.getSessionStats?.();
        // An empty new session has not measured the child prompt yet.
        if (context && (context.tokens === null || context.tokens > 0 || stats?.assistantMessages))
          reportUsage(spec.signal, { contextTokens: context.tokens, contextWindow: context.contextWindow });
        if (stats && (stats.assistantMessages > 0 || stats.tokens.total > 0))
          reportUsage(spec.signal, { totalTokens: stats.tokens.total, cost: stats.cost });
      } catch { /* Optional display data must not fail a child. */ }
      sampledAt = Date.now();
    };

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
      unsubscribe = session.subscribe?.((event) => {
        if (event.type !== "message_update" || Date.now() - sampledAt >= 1000) sampleUsage();
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
          appendLiveOutput(spec.signal, event.assistantMessageEvent.delta);
        if (event.type === "message_end" && event.message.role === "assistant")
          appendLiveOutput(spec.signal, "\n");
        const line = eventStatus(event);
        if (line) reportStatus(spec, line);
      });
      await session.prompt(spec.prompt);
      sampleUsage();

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
        unsubscribe?.();
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
      "--mode", "json",
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
      let pending = "";
      let finalText = "";
      let modelError: string | undefined;
      let sawJson = false;
      let modelAborted = false;
      let totalTokens = 0;
      let totalCost = 0;
      let costReported = false;
      let messageEnds = 0;
      const decoder = new StringDecoder("utf8");
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof spawn> | undefined;

      const messageUsage = (message: any) => {
        const usage = message?.usage;
        if (!usage) return;
        const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
        const tokens = values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
          ? values.reduce((sum, value) => sum + value, 0) : undefined;
        if (tokens !== undefined) totalTokens += tokens;
        if (typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) {
          totalCost += usage.cost.total;
          costReported = true;
        }
        reportUsage(spec.signal, {
          totalTokens,
          ...(costReported ? { cost: totalCost } : {}),
          ...(message.role === "assistant" && tokens !== undefined && message.stopReason !== "error" && message.stopReason !== "aborted"
            ? { contextTokens: tokens, contextWindow: spec.model.contextWindow } : {}),
        });
      };

      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (!event || typeof event.type !== "string") return;
          sawJson = true;
          if (event.type === "message_end") { messageEnds++; messageUsage(event.message); }
          // Some backends emit only agent_end; never recount messages when both are present.
          if (event.type === "agent_end" && messageEnds === 0 && Array.isArray(event.messages)) {
            for (const message of event.messages) messageUsage(message);
            messageEnds = event.messages.length;
          }
          if (event.type === "entry_appended" && event.entry?.type === "branch_summary")
            messageUsage(event.entry);
          if (event.type === "compaction_end" && !event.aborted) {
            messageUsage(event.result);
            reportUsage(spec.signal, { contextTokens: null });
          }
          const activity = eventStatus(event);
          if (activity) reportStatus(spec, activity);
          const message = event.type === "message_end" ? event.message
            : event.type === "agent_end" ? event.messages?.filter((item: any) => item.role === "assistant").at(-1) : undefined;
          if (message?.role === "assistant") {
            finalText = Array.isArray(message.content) ? message.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") : "";
            modelError = message.stopReason === "error" ? (message.errorMessage || "child model request failed") : undefined;
            modelAborted = message.stopReason === "aborted";
          }
        } catch { /* Ignore a non-event diagnostic line. */ }
      };

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
          killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* Already gone. */ } }, 2000);
          killTimer.unref();
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
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        stdout = (stdout + text).slice(-16_000);
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      });
      stderrStream.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-16_000);
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
        if (killTimer) clearTimeout(killTimer);
        consume(pending + decoder.end());
        if (aborted || spec.signal.aborted) {
          finish(abortedResult());
          return;
        }
        if (code === 0) {
          finish(modelAborted ? abortedResult() : modelError
            ? { text: "", aborted: false, errorKind: "model", error: modelError }
            : { text: sawJson ? finalText.trim() : stdout.trim(), aborted: false });
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
