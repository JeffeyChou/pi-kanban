import { access } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { readArtifactText } from "./artifacts.js";
import type { Session } from "./store.js";

const PATH_PATTERN =
  /(?:^|[\s`"'(])((?:\.?\.?\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|py|go|rs|java|cpp|cc|h))(?:[\s`"'),.:;]|$)/gim;

function safeRelativePath(cwd: string, raw: string): string | undefined {
  const absolute = resolve(cwd, raw);
  const path = relative(cwd, absolute);
  if (path.startsWith("..") || isAbsolute(path)) return undefined;
  return normalize(path);
}

export async function discoverSessionFiles(
  cwd: string,
  session: Session,
): Promise<string[]> {
  const artifacts = await Promise.all([
    readArtifactText(cwd, session.planArtifact),
    readArtifactText(cwd, session.handoffArtifact),
  ]);
  const candidates = new Set(
    session.sourceFiles
      .map((path) => safeRelativePath(cwd, path))
      .filter((path): path is string => Boolean(path)),
  );
  for (const text of artifacts) {
    for (const match of text.matchAll(PATH_PATTERN)) {
      const path = safeRelativePath(cwd, match[1]!);
      if (path) candidates.add(path);
    }
  }
  const existing: string[] = [];
  for (const path of candidates) {
    try {
      await access(resolve(cwd, path));
      existing.push(path);
    } catch {
      /* preserve non-existent explicit paths in state but do not show as local files */
    }
  }
  return existing.sort();
}
