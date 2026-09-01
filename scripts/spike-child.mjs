import {
  DefaultResourceLoader,
  createAgentSession,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Manual A1 evidence spike. Install this file as a Pi extension, start a session in a
 * repository, and inspect the terminal for SPIKE-RESULT. It creates exactly one
 * extension-free, read-only in-process child and disposes it after the response.
 */
export default function spikeChild(pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.model) {
      console.log("SPIKE-RESULT no parent model was available");
      return;
    }
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt:
        "You are a read-only child-session spike. Use the read tool exactly once, then report what you read.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model: ctx.model,
      tools: ["read"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
    });
    try {
      await session.prompt(
        "Read package.json with the read tool. Reply with a one-sentence confirmation of its package name.",
      );
      console.log(`SPIKE-RESULT ${session.getLastAssistantText() ?? ""}`);
    } catch (error) {
      console.log(
        `SPIKE-RESULT ERROR ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      session.dispose();
    }
  });
}
