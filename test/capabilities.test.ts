import assert from "node:assert/strict";
import test from "node:test";
import { detectExternalTools } from "../src/capabilities.js";

test("external-tool detection includes only active known tools and active background-task tools", () => {
  const pi = {
    getActiveTools: () => ["subagent", "ask_user_question", "background_task", "other"],
    getAllTools: () => [
      {
        name: "background_task",
        sourceInfo: {
          path: "/Users/test/.pi/agent/extensions/pi-background-tasks/index.mjs",
        },
      },
      {
        name: "disabled_background_task",
        sourceInfo: { path: "/packages/pi-background-tasks/tool.mjs" },
      },
      { name: "other", sourceInfo: { path: "/packages/other/index.mjs" } },
    ],
  };
  assert.deepEqual(detectExternalTools(pi as any), [
    "subagent",
    "ask_user_question",
    "background_task",
  ]);
});

test("registered but inactive tools are never advertised", () => {
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [
      { name: "subagent", sourceInfo: { path: "/extension/subagent.mjs" } },
      {
        name: "background_task",
        sourceInfo: { path: "/extension/pi-background-tasks/index.mjs" },
      },
    ],
  };
  assert.deepEqual(detectExternalTools(pi as any), []);
});
