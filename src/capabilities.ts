import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi's run modes. Mirrored locally because the package does not re-export the union. */
type RunMode = "tui" | "rpc" | "json" | "print";

/**
 * Pi's single-shot run modes. They dispose the runtime as soon as the command returns, so a
 * long-running orchestrator run must be awaited by the command that started it instead of being
 * left armed in the background. `tui` and `rpc` keep the process alive and must not block.
 *
 * The mode is absent in contexts that predate it (and in tests), which is treated as "not
 * single-shot": blocking a caller that never wanted it is the worse failure.
 */
export function isSingleShot(ctx: { mode?: RunMode }): boolean {
  return ctx.mode === "print" || ctx.mode === "json";
}

/**
 * Names of ACTIVE external tools kanban can point the implement-stage agent at:
 * the intersection of pi.getActiveTools() with the known names (`subagent`,
 * `ask_user_question`) plus active tools whose getAllTools() sourceInfo resolves to the
 * pi-background-tasks package.
 */
export function detectExternalTools(_pi: ExtensionAPI): string[] {
  const active = new Set(_pi.getActiveTools());
  const tools = new Set<string>();
  for (const name of ["subagent", "ask_user_question"]) {
    if (active.has(name)) tools.add(name);
  }
  for (const tool of _pi.getAllTools()) {
    if (
      active.has(tool.name) &&
      tool.sourceInfo.path.includes("pi-background-tasks")
    )
      tools.add(tool.name);
  }
  return [...tools];
}
