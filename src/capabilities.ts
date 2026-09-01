import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
