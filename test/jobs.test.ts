import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JobManager, parseAdapterResult, runJobCommand, type RunJobCommand } from "../src/jobs.js";
import { unresolvedJob, type CoordinationState, type JobRecord } from "../src/coordinationstore.js";

const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), output: JSON.stringify(value) });
function fixture(command: RunJobCommand, patch: Partial<JobRecord> = {}) {
  const controller = new AbortController();
  const state = {
    jobs: { key: {
      key: "key", name: "capture", lane: "TP", revision: 1, sourceCommit: "sha", worktree: "/private-snapshot", adapterName: "gpu",
      adapter: { kind: "scheduled", submit: "submit", status: "status", cancel: "cancel", collect: "collect", pollIntervalMs: 5 },
      state: "intent", submitted: false, params: {}, startedAt: Date.now(), deadline: Date.now() + 10000, ...patch,
    } }, events: [],
  } as unknown as CoordinationState;
  let writes = 0;
  const manager = new JobManager({
    read: async () => structuredClone(state),
    change: async (fn) => { writes++; return fn(state); },
    signal: controller.signal, env: {}, output() {},
  }, command);
  return { state, manager, controller, get writes() { return writes; } };
}

test("ambiguous submission reconnects by the durable key without a duplicate submission", async () => {
  let submitted = 0;
  const f = fixture(async (input) => {
    if (input.payload.operation === "status") return result(submitted ? { state: "succeeded", externalId: "original-job" } : { state: "missing" });
    if (input.payload.operation === "submit") { submitted++; return { code: 1, stdout: "", output: "connection lost after scheduler accepted request" }; }
    return result({ accepted: true, artifacts: ["/retained/result.json"] });
  });
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(f.state.jobs.key.state, "unknown");
  assert.equal(f.state.jobs.key.submitted, true);
  await f.manager.reconnect(); await f.manager.settled();
  assert.equal(submitted, 1);
  assert.equal(f.state.jobs.key.externalId, "original-job");
  assert.equal(f.state.jobs.key.accepted, true);
  const events = f.state.events.length;
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(f.state.events.length, events, "reattaching a collected receipt is a no-op");
});

test("missing scheduler history with a recorded ID is unknown, never permission to resubmit", async () => {
  const operations: unknown[] = [];
  const f = fixture(async (input) => { operations.push(input.payload.operation); return result({ state: "missing" }); }, { externalId: "lost-history", submitted: true });
  f.manager.watch("key"); await f.manager.settled();
  assert.deepEqual(operations, ["status"]);
  assert.equal(f.state.jobs.key.state, "unknown");
  assert.ok(unresolvedJob(f.state.jobs.key));
});

test("a pending goal revision defers a reserved but not yet submitted job", async () => {
  const f = fixture(async (input) => { assert.equal(input.payload.operation, "status"); return result({ state: "missing" }); });
  f.state.pendingRevision = { id: "new-goal", request: { action: "revise", message: "No GPU jobs" } };
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(f.state.jobs.key.submitted, false);
  assert.equal(f.state.jobs.key.state, "cancelled");
});

test("unchanged scheduler polling does not write state or emit model events", async () => {
  let polls = 0;
  const f = fixture(async () => {
    polls++;
    if (polls === 5) f.controller.abort();
    return result({ state: "running", externalId: "job" });
  }, { state: "running", submitted: true, externalId: "job" });
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(polls, 5);
  assert.equal(f.writes, 0);
  assert.equal(f.state.events.length, 0);
});

test("reconnect collects terminal failed jobs and distinguishes scheduler failure from accepted evidence", async () => {
  const operations: unknown[] = [];
  const f = fixture(async (input) => {
    operations.push(input.payload.operation);
    return input.payload.operation === "status" ? result({ state: "failed", externalId: "dp" })
      : result({ accepted: true, artifacts: ["/retained/valid-capture.json"], message: "Capture valid; only postprocessing failed" });
  }, { state: "failed", submitted: true, externalId: "dp" });
  await f.manager.reconnect(); await f.manager.settled();
  assert.deepEqual(operations, ["status", "collect"]);
  assert.equal(f.state.jobs.key.state, "failed");
  assert.equal(f.state.jobs.key.accepted, true);
});

test("collection failures are reported, and malformed local adapter output cannot establish acceptance", async () => {
  const f = fixture(async (input) => input.payload.operation === "status" ? result({ state: "succeeded", externalId: "job" })
    : { code: 1, stdout: "", output: "result validation failed" });
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(f.state.jobs.key.accepted, false);
  assert.match(f.state.jobs.key.error!, /Collection failed/);
  const local = fixture(async () => ({ code: 0, stdout: "{broken", output: "{broken" }), { adapter: { kind: "local", command: "check" } });
  local.manager.watch("key"); await local.manager.settled();
  assert.equal(local.state.jobs.key.accepted, false);
  assert.match(local.state.jobs.key.error!, /Invalid local adapter/);
});

test("deadline cancellation requires a terminal confirmation and preserves an unknown job", async () => {
  const f = fixture(async (input) => input.payload.operation === "status" ? result({ state: "running", externalId: "job" }) : result({ state: "unknown" }), { deadline: Date.now() - 1 });
  f.manager.watch("key"); await f.manager.settled();
  assert.equal(f.state.jobs.key.state, "unknown");
  assert.match(f.state.jobs.key.error!, /not confirmed/);
  assert.ok(unresolvedJob({ ...f.state.jobs.key, state: "blocked" }));
});

test("adapter protocol rejects malformed, nonfinite and unbounded result fields", () => {
  for (const value of ["not json", "null", "[]", '{"state":"done"}', '{"metric":1e999}', '{"accepted":"yes"}', '{"externalId":""}', JSON.stringify({ artifacts: Array(65).fill("path") })])
    assert.throws(() => parseAdapterResult(value));
  assert.deepEqual(parseAdapterResult('log output\n{"accepted":true,"metric":0}'), { accepted: true, metric: 0 });
});

test("configured local commands receive JSON stdin, inherit environment, and bound public output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-job-command-"));
  try {
    const code = "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{process.stdout.write('x'.repeat(90000));console.log(JSON.stringify({payload:JSON.parse(s),env:process.env.KANBAN_TEST_PARAM}));});";
    const command = `node -e ${JSON.stringify(code)}`;
    const response = await runJobCommand({ cwd, command, payload: { text: "$(touch never-created); literal" }, env: { KANBAN_TEST_PARAM: "inherited" }, timeoutMs: 3000, signal: new AbortController().signal });
    assert.equal(response.code, 0);
    assert.ok(response.stdout.length <= 65536);
    assert.ok(response.output.length <= 8000);
    assert.match(response.stdout, /inherited/);
    assert.match(response.stdout, /literal/);
    const timed = await runJobCommand({ cwd, command: "sleep 60 & wait", payload: {}, env: {}, timeoutMs: 25, signal: new AbortController().signal });
    assert.equal(timed.timedOut, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("the documented CPU adapter validates retained evidence without changing its input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-adapter-example-"));
  try {
    const source = join(cwd, "DP.json");
    const content = JSON.stringify({ profile: "DP", passed: true, samples: 12 });
    await writeFile(source, content);
    const script = fileURLToPath(new URL("../examples/managed-jobs/validate-results.mjs", import.meta.url));
    const response = await runJobCommand({ cwd, command: `node ${JSON.stringify(script)}`,
      payload: { operation: "command", key: "cpu", params: { resultFiles: [source] }, revision: 2, sourceCommit: "sha" },
      env: {}, signal: new AbortController().signal, timeoutMs: 5000,
    });
    assert.equal(response.code, 0, response.output);
    const accepted = parseAdapterResult(response.stdout);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.metric, 1);
    assert.equal(await readFile(source, "utf8"), content);
    const evidence = JSON.parse(await readFile(accepted.artifacts![0], "utf8"));
    assert.equal(evidence.revision, 2);
    assert.equal(evidence.results[0].samples, 12);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
