import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { artifactPaths, type Session } from "./store.js";

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function persistSessionArtifacts(
  cwd: string,
  session: Session,
): Promise<void> {
  const paths = artifactPaths(cwd, session.id);
  session.planArtifact = relative(cwd, paths.plan);
  session.handoffArtifact = relative(cwd, paths.handoff);
  await atomicWrite(
    paths.plan,
    `${JSON.stringify(
      {
        sessionId: session.id,
        title: session.title,
        status: session.state,
        stage: session.stage,
        currentActivity: session.currentActivity,
        sourceFiles: session.sourceFiles,
        tasks: session.tasks,
        importantCriteria: session.importantCriteria,
        progress: session.liveProgress,
        updatedAt: session.updatedAt,
      },
      null,
      2,
    )}\n`,
  );
  await atomicWrite(
    paths.handoff,
    `# ${session.title} handoff\n\n- Stage: ${session.stage}\n- State: ${session.state}\n- Current activity: ${session.currentActivity}\n- Progress: ${session.liveProgress.completed}/${session.liveProgress.total}\n- Pi conversation: ${session.piConversationPath ?? "unavailable"}\n\n## Source files\n${session.sourceFiles.map((path) => `- ${path}`).join("\n") || "- None recorded"}\n\n## Evidence\n${session.evidence.map((entry) => `- ${entry}`).join("\n") || "- None recorded"}\n\n## Resume instructions\nContinue the selected Kanban session from its current stage. Preserve unfinished tasks, todo state, evidence, and review records.\n`,
  );
}

export async function readArtifactText(
  cwd: string,
  path: string,
): Promise<string> {
  try {
    return await readFile(`${cwd}/${path}`, "utf8");
  } catch {
    return "";
  }
}
