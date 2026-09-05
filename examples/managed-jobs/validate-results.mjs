/** Demonstration CPU adapter. Replace the schema/checks with domain-specific validation. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) throw new Error("Request too large");
}
try {
  const request = JSON.parse(input);
  if (request.operation !== "command") throw new Error("Only local command operations are supported");
  const paths = request.params?.resultFiles;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64 || paths.some((p) => typeof p !== "string"))
    throw new Error("params.resultFiles must contain 1–64 retained JSON paths");
  const results = [];
  for (const path of paths) {
    const record = JSON.parse(await readFile(path, "utf8"));
    if (typeof record.profile !== "string" || record.passed !== true || !Number.isSafeInteger(record.samples) || record.samples <= 0)
      throw new Error(`Invalid demonstration evidence: ${path}`);
    results.push({ path, profile: record.profile, samples: record.samples });
  }
  const directory = join(process.cwd(), "evidence");
  await mkdir(directory, { recursive: true });
  const artifact = join(directory, "accepted-results.json");
  await writeFile(artifact, `${JSON.stringify({ sourceCommit: request.sourceCommit, revision: request.revision, results }, null, 2)}\n`);
  console.log(JSON.stringify({ accepted: true, artifacts: [artifact], metric: results.length }));
} catch (error) {
  console.log(JSON.stringify({ accepted: false, message: String(error) }));
  process.exitCode = 1;
}
