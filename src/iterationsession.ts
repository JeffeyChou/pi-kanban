/** Long-lived, extension-free sessions used only by the implement coordinator. */
import { mkdir } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beginChildUsage, finishChildUsage, reportUsage } from "./usage.js";

export interface IterationSessionSpec {
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  systemPrompt: string;
  label: string;
  model: Model<any>;
  tools: string[];
  customTools: ToolDefinition[];
  signal: AbortSignal;
  runSignal: AbortSignal;
  output: (text: string) => void;
  activity: (text: string) => void;
  turn?: () => void;
}

export interface IterationSession {
  sessionFile?: string;
  /** Returns at an assistant response boundary; the owner decides whether work is complete. */
  send(message: string): Promise<string>;
  close(): Promise<void>;
}

export type IterationSessionFactory = (spec: IterationSessionSpec) => Promise<IterationSession>;

export function createIterationSessionFactory(sdk = { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager }): IterationSessionFactory {
  return async (spec) => {
  await mkdir(spec.sessionDir, { recursive: true });
  const agentDir = sdk.getAgentDir();
  const loader = new sdk.DefaultResourceLoader({
    cwd: spec.cwd, agentDir, noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true, systemPrompt: spec.systemPrompt,
  });
  await loader.reload();
  const manager = spec.sessionFile
    ? sdk.SessionManager.open(spec.sessionFile, spec.sessionDir, spec.cwd)
    : sdk.SessionManager.create(spec.cwd, spec.sessionDir);
  const { session } = await sdk.createAgentSession({
    cwd: spec.cwd, agentDir, model: spec.model, resourceLoader: loader,
    tools: [...spec.tools, ...spec.customTools.map((tool) => tool.name)],
    customTools: spec.customTools, sessionManager: manager,
  });
  beginChildUsage(spec.runSignal, spec.signal, "implement", spec.label, spec.model);
  // A restored SDK session reports lifetime totals. Count only usage since this attachment.
  const initial = session.getSessionStats();
  const sample = () => {
    const context = session.getContextUsage();
    const stats = session.getSessionStats();
    reportUsage(spec.signal, {
      ...(context ? { contextTokens: context.tokens, contextWindow: context.contextWindow } : {}),
      totalTokens: Math.max(0, stats.tokens.total - initial.tokens.total),
      cost: Math.max(0, stats.cost - initial.cost),
    });
  };
  const unsubscribe = session.subscribe((event) => {
    if (spec.signal.aborted) return;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      spec.output(event.assistantMessageEvent.delta);
    if (event.type === "tool_execution_start") spec.activity(`${spec.label}: ${event.toolName}`);
    if (event.type === "turn_start") { spec.activity(`${spec.label}: working`); spec.turn?.(); }
    if (event.type === "message_end" || event.type === "agent_end" || event.type === "compaction_end") sample();
  });
  const abort = () => { void session.abort().catch(() => undefined); };
  spec.signal.addEventListener("abort", abort, { once: true });
  if (spec.signal.aborted) abort();
  return {
    sessionFile: manager.getSessionFile(),
    async send(message) {
      if (spec.signal.aborted) throw new Error("Iteration session suspended");
      await session.sendCustomMessage({
        customType: "kanban_iteration_event", content: message, display: true,
      }, { triggerTurn: true, deliverAs: "steer" });
      sample();
      if (spec.signal.aborted) throw new Error("Iteration session suspended");
      const last = [...session.messages].reverse().find((entry) => entry.role === "assistant");
      if (last?.role === "assistant" && last.stopReason === "error")
        throw new Error(last.errorMessage || "Iteration model request failed");
      return session.getLastAssistantText() ?? "";
    },
    async close() {
      spec.signal.removeEventListener("abort", abort);
      unsubscribe();
      await session.abort().catch(() => undefined);
      session.dispose();
      finishChildUsage(spec.signal);
    },
  };
  };
}

export const createIterationSession = createIterationSessionFactory();
