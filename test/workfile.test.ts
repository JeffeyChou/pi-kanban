import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKFILE_SECTION_MAX_LINES,
  deleteWorkfile,
  readWorkfile,
  sweepOrphanWorkfiles,
  workfileBase,
  workfilePath,
  writeWorkfileSection,
} from "../src/workfile.js";

async function sandbox() {
  return mkdtemp(join(tmpdir(), "kanban-workfile-test-"));
}

test("workfile paths derive from plan basenames and missing files read as empty", async () => {
  const cwd = await sandbox();
  try {
    assert.equal(workfileBase("plans/2026-09-01-a.title.json"), "2026-09-01-a.title");
    assert.equal(
      workfilePath(cwd, "2026-09-01-a.title"),
      join(cwd, ".kanban", "work", "2026-09-01-a.title.md"),
    );
    assert.deepEqual(await readWorkfile(cwd, "missing"), { sections: {} });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writing one workfile section replaces it atomically while preserving other bodies", async () => {
  const cwd = await sandbox();
  try {
    await writeWorkfileSection(cwd, "session", "refine", "First refine body");
    await writeWorkfileSection(cwd, "session", "research", "Research body");
    await writeWorkfileSection(cwd, "session", "refine", "Replacement refine body");
    assert.deepEqual(await readWorkfile(cwd, "session"), {
      sections: {
        refine: "Replacement refine body",
        research: "Research body",
      },
    });
    const content = await readFile(workfilePath(cwd, "session"), "utf8");
    assert.match(content, /^## refine$/m);
    assert.match(content, /^## research$/m);
    assert.doesNotMatch((await readWorkfile(cwd, "session")).sections.refine!, /^## /);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workfile sections are capped at 300 lines and deletion/sweeping are idempotent", async () => {
  const cwd = await sandbox();
  try {
    await writeWorkfileSection(
      cwd,
      "keep",
      "compose",
      Array.from({ length: WORKFILE_SECTION_MAX_LINES + 5 }, (_, index) => `line ${index + 1}`).join(
        "\n",
      ),
    );
    await writeWorkfileSection(cwd, "orphan", "refine", "discard me");
    const body = (await readWorkfile(cwd, "keep")).sections.compose!;
    assert.equal(body.split("\n").length, WORKFILE_SECTION_MAX_LINES);
    assert.match(body, /truncated: section limited to 300 lines/);

    await sweepOrphanWorkfiles(cwd, ["keep"]);
    await assert.rejects(access(workfilePath(cwd, "orphan")));
    await deleteWorkfile(cwd, "keep");
    await deleteWorkfile(cwd, "keep");
    await assert.rejects(access(workfilePath(cwd, "keep")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
