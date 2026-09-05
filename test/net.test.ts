import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { NetworkConfig } from "../src/config.js";
import {
  extractText, hostAllowed, isPrivateAddress, logFetch, refuseUrl, webFetch, webSearch,
} from "../src/net.js";
import { networkEnabledFor, networkTools } from "../src/nettools.js";

const config = (overrides: Partial<NetworkConfig> = {}): NetworkConfig => ({
  enabled: true,
  allow: ["github.com", "*.githubusercontent.com"],
  maxBytes: 1000,
  timeoutMs: 5000,
  lanes: [],
  ...overrides,
});

/** Never resolves anything privately, so allowlist behavior can be tested on its own. */
const publicOnly = async (raw: string, cfg: NetworkConfig): Promise<string | undefined> => {
  const url = new URL(raw);
  if (url.protocol !== "https:") return `Only https is supported; refused ${url.protocol}//`;
  return hostAllowed(url.hostname, cfg.allow) ? undefined : `Host ${url.hostname} is not in network.allow.`;
};

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", ...init.headers },
  });
}

test("hostAllowed matches exactly and under a single wildcard label, never as a bare suffix", () => {
  const allow = ["github.com", "*.githubusercontent.com"];
  assert.equal(hostAllowed("github.com", allow), true);
  assert.equal(hostAllowed("GitHub.Com.", allow), true);
  assert.equal(hostAllowed("raw.githubusercontent.com", allow), true);
  assert.equal(hostAllowed("githubusercontent.com", allow), true);
  assert.equal(hostAllowed("api.github.com", allow), false, "a wildcard was not granted for github.com");
  assert.equal(hostAllowed("evil-github.com", allow), false);
  assert.equal(hostAllowed("github.com.evil.net", allow), false, "suffix confusion must not pass");
  assert.equal(hostAllowed("github.com", []), false);
});

test("isPrivateAddress covers loopback, RFC1918, link-local, CGNAT and IPv4-mapped IPv6", () => {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "239.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:169.254.169.254",
  ]) assert.equal(isPrivateAddress(address), true, `${address} must be refused`);

  for (const address of ["8.8.8.8", "140.82.121.4", "172.32.0.1", "2606:4700::1111"])
    assert.equal(isPrivateAddress(address), false, `${address} must be reachable`);
});

test("refuseUrl rejects non-https, unlisted hosts, and anything resolving into private space", async () => {
  const cfg = config();
  assert.match((await refuseUrl("file:///etc/passwd", cfg))!, /Only http\(s\)/);
  assert.match((await refuseUrl("not a url", cfg))!, /valid absolute URL/);
  assert.match((await refuseUrl("https://example.com/x", cfg))!, /not in network\.allow/);
  assert.match((await refuseUrl("http://github.com/x", cfg))!, /plaintext http/);
  // An allowlisted name is still refused when it points inside the operator's own network.
  assert.match(
    (await refuseUrl("https://127.0.0.1/x", config({ allow: ["127.0.0.1"] })))!,
    /loopback, link-local or private/,
  );
  assert.equal(await refuseUrl("https://github.com/x", cfg), undefined);
});

test("webFetch re-checks the allowlist on every redirect hop", async () => {
  const visited: string[] = [];
  const outcome = await webFetch({ url: "https://github.com/start" }, config(), undefined, {
    refuse: publicOnly,
    fetch: (async (input: string) => {
      visited.push(String(input));
      if (String(input).endsWith("/start"))
        return new Response(null, { status: 302, headers: { location: "https://evil.example/payload" } });
      return response("should never be reached");
    }) as unknown as typeof fetch,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /not in network\.allow/);
  assert.deepEqual(visited, ["https://github.com/start"], "the off-allowlist hop must not be requested");
});

test("webFetch caps the body at maxBytes and reports the truncation", async () => {
  const outcome = await webFetch({ url: "https://github.com/big" }, config({ maxBytes: 10 }), undefined, {
    refuse: publicOnly,
    fetch: (async () => response("0123456789ABCDEFGHIJ")) as unknown as typeof fetch,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.bytes, 10);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text, "0123456789");
});

test("webFetch reports HTTP failures and redirect loops instead of returning empty success", async () => {
  const missing = await webFetch({ url: "https://github.com/gone" }, config(), undefined, {
    refuse: publicOnly,
    fetch: (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /404/);

  const looping = await webFetch({ url: "https://github.com/a" }, config(), undefined, {
    refuse: publicOnly,
    fetch: (async () =>
      new Response(null, { status: 302, headers: { location: "https://github.com/a" } })) as unknown as typeof fetch,
  });
  assert.equal(looping.ok, false);
  assert.match(looping.error!, /Too many redirects/);
});

test("extractText strips scripts, styles and markup but leaves plain bodies alone", () => {
  const html = "<html><style>p{color:red}</style><script>steal()</script><p>Hello</p><p>World &amp; co</p></html>";
  const text = extractText(html, "text/html; charset=utf-8");
  assert.ok(!text.includes("steal()"));
  assert.ok(!text.includes("color:red"));
  assert.match(text, /Hello/);
  assert.match(text, /World & co/);
  assert.equal(extractText("raw {\"a\":1}", "application/json"), "raw {\"a\":1}");
});

test("web_search says it is unconfigured rather than reporting no results", async () => {
  const outcome = await webSearch("marin recipe", config({ search: undefined }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /no backend configured/);

  const missingKey = await webSearch("marin recipe",
    config({ search: { endpoint: "https://search.example/api", apiKeyEnv: "KANBAN_TEST_ABSENT_KEY" } }));
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.error!, /KANBAN_TEST_ABSENT_KEY/);
});

test("networkEnabledFor requires enablement, an allowlist, and lane membership", () => {
  assert.equal(networkEnabledFor(undefined, "research"), false);
  assert.equal(networkEnabledFor(config({ enabled: false }), "research"), false);
  assert.equal(networkEnabledFor(config({ allow: [] }), "research"), false, "an empty allowlist reaches nothing");
  assert.equal(networkEnabledFor(config(), "research"), true, "an empty lane list means every lane");
  assert.equal(networkEnabledFor(config({ lanes: ["research"] }), "research"), true);
  assert.equal(networkEnabledFor(config({ lanes: ["research"] }), "adapters"), false);
});

test("the fetch tool delimits untrusted content and records provenance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-net-"));
  const [fetchTool] = networkTools({ cwd, base: "demo", lane: "research", config: config() });

  const refused = await fetchTool!.execute("1", { url: "https://example.com/x" }, undefined as never, undefined as never, undefined as never);
  assert.match(refused.content[0]!.text, /not in network\.allow/);

  const log = await readFile(join(cwd, ".kanban", "loop", "demo.net.jsonl"), "utf8");
  const record = JSON.parse(log.trim().split("\n").at(-1)!);
  assert.equal(record.lane, "research");
  assert.equal(record.ok, false);
  assert.equal(record.url, "https://example.com/x");
  assert.ok(record.at, "every fetch attempt is timestamped");
});

test("logFetch appends one JSON record per attempt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kanban-net-"));
  await logFetch(cwd, "base", { lane: "a", ok: true });
  await logFetch(cwd, "base", { lane: "b", ok: false });
  const lines = (await readFile(join(cwd, ".kanban", "loop", "base.net.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]!).lane, "b");
});
