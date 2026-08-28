#!/usr/bin/env bash
set -euo pipefail

kanban_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$kanban_root"

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--check" ]; }; then
  echo "Usage: ./init.sh [--check]" >&2
  exit 2
fi

node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const statePath = join(root, ".kanban", "state.json");
if (!existsSync(statePath)) {
  console.log("Kanban: no durable session yet.");
  process.exit(0);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.schemaVersion !== 4) {
  console.log(`Kanban: legacy schema v${state.schemaVersion ?? "unknown"} detected.`);
  console.log("Reload Pi or start a Kanban session to run the built-in migration before relying on this report.");
  process.exit(0);
}
const session = state.sessions?.find((item) => item.title === state.selectedSessionTitle) ?? state.sessions?.[0];
if (!session) {
  console.log("Kanban: no active session.");
} else {
  console.log(`Kanban: ${session.title}`);
  console.log(`Stage: ${session.stage} · ${session.state}`);
  console.log(`Plan: .kanban/${session.planPath}`);
  console.log(`Agents: ${session.agents?.map((agent) => `${agent.name} (${agent.role}, ${agent.status})`).join(", ") || "none"}`);
}
'

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
echo "Branch: $branch"
echo "Recent commits:"
git log -5 --pretty=format:'  %h %s' || true
echo
echo "Working tree:"
git status --short
echo "Rules: run ./init.sh --check before handoff; never commit automatically; provide a suggested commit."

if [ "${1:-}" != "--check" ]; then
  exit 0
fi

node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const board = join(root, ".kanban");
const statePath = join(board, "state.json");
const handoffPath = join(board, "handoff.md");
const fail = (message) => { console.error(`init.sh --check: ${message}`); process.exit(1); };
if (!existsSync(statePath)) fail(".kanban/state.json is missing");
if (!existsSync(handoffPath)) fail(".kanban/handoff.md is missing");
let state;
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { fail("state.json is not valid JSON"); }
if (state.schemaVersion !== 4 || !Array.isArray(state.sessions)) fail("state.json is not schema version 4");
if (state.sessions.some((session) => session.state === "complete")) fail("completed sessions must not remain in state.json");
if (state.selectedSessionTitle && !state.sessions.some((session) => session.title === state.selectedSessionTitle)) fail("selectedSessionTitle does not name an active session");
for (const session of state.sessions) {
  if (typeof session.title !== "string" || typeof session.planPath !== "string") fail("session title or planPath is invalid");
  if ("piConversationPath" in session) fail("Pi conversation paths must not be stored in state.json");
  const planPath = resolve(board, session.planPath);
  if (relative(board, planPath).startsWith("..") || !relative(board, planPath).startsWith("plans/")) fail(`unsafe plan path for ${session.title}`);
  if (!existsSync(planPath)) fail(`plan is missing for ${session.title}`);
  try { JSON.parse(readFileSync(planPath, "utf8")); } catch { fail(`plan is invalid JSON for ${session.title}`); }
}
const handoffText = readFileSync(handoffPath, "utf8");
const handoffLines = handoffText ? handoffText.replace(/\n$/, "").split(/\r?\n/).length : 0;
if (handoffLines > 200) fail(`handoff.md has ${handoffLines} lines; maximum is 200`);
console.log("Kanban structure: valid");
'

git diff --check
git diff --cached --check
npm run typecheck
npm test

suggested_title="$(node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const handoff = join(root, ".kanban", "handoff.md");
const state = join(root, ".kanban", "state.json");
let title;
if (existsSync(state)) {
  const board = JSON.parse(readFileSync(state, "utf8"));
  title = board.sessions?.find((item) => item.title === board.selectedSessionTitle)?.title ?? board.sessions?.[0]?.title;
}
if (!title && existsSync(handoff)) {
  title = readFileSync(handoff, "utf8").match(/Latest completed plan: .* — (.+)$/m)?.[1];
}
process.stdout.write(title || "Kanban update");
')"

echo "Validation: passed"
echo "Suggested commit (do not execute automatically):"
printf "  git commit -m %q\n" "kanban: $suggested_title"
echo "Suggested files:"
{ git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u | sed 's/^/  /'
