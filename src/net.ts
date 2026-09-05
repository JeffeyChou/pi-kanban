/**
 * Outbound network for child agents.
 *
 * Kanban children deliberately have no shell — a child with one could leave its worktree or commit
 * to the operator's checkout — and Pi ships no built-in web tool. The consequence was that the
 * research stage could not reach the network at all, and no lane could fetch a pinned source.
 * These tools restore that capability without restoring a shell.
 *
 * Everything here runs inside the operator's own Pi process, on their network, with their routing.
 * That makes an unrestricted fetch tool a server-side request forgery primitive pointed at the
 * operator's own machine and private network, so the guards below are load-bearing rather than
 * decorative: an explicit host allowlist, re-checked on every redirect, and a refusal to reach any
 * address that resolves into loopback, link-local or private space.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { NetworkConfig } from "./config.js";

export interface FetchRequest {
  url: string;
  maxBytes?: number;
}

export interface FetchOutcome {
  ok: boolean;
  url: string;
  status?: number;
  bytes?: number;
  contentType?: string;
  /** Extracted text on success. */
  text?: string;
  error?: string;
  truncated?: boolean;
}

/** Hostname matches an allowlist entry: exactly, or under a single `*.` wildcard label. */
export function hostAllowed(hostname: string, allow: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const pattern = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === pattern;
  });
}

/**
 * Address ranges a fetch tool must never reach.
 *
 * The operator's loopback interface and private network are exactly what an untrusted instruction
 * in fetched content would try to make a child request — cloud metadata endpoints, internal
 * dashboards, a local scheduler API. None of them is ever a legitimate research target.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 127) return true;             // this-host, loopback
    if (a === 10) return true;                          // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC1918
    if (a === 192 && b === 168) return true;            // RFC1918
    if (a === 169 && b === 254) return true;            // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
    if (a >= 224) return true;                          // multicast and reserved
    return false;
  }
  if (version === 6) {
    const host = address.toLowerCase().split("%")[0]!;
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb"))
      return true;                                       // link-local
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local
    // An IPv4-mapped address inherits the IPv4 verdict rather than bypassing it.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  return false;
}

async function resolvesPrivately(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    // Any private answer is disqualifying: a name with a mixed answer set is a rebinding attempt.
    return addresses.some((entry) => isPrivateAddress(entry.address));
  } catch {
    // A name that will not resolve cannot be fetched anyway; let the request fail with a real error.
    return false;
  }
}

/** Reject a URL before any connection is made. Returns an operator-readable reason, or undefined. */
export async function refuseUrl(raw: string, config: NetworkConfig): Promise<string | undefined> {
  let url: URL;
  try { url = new URL(raw); } catch { return `Not a valid absolute URL: ${raw}`; }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return `Only http(s) is supported; refused ${url.protocol}//`;
  if (!hostAllowed(url.hostname, config.allow))
    return `Host ${url.hostname} is not in network.allow. Add it in /kanban config to fetch from it.`;
  if (url.protocol === "http:")
    return `Refused plaintext http for ${url.hostname}; use https.`;
  if (await resolvesPrivately(url.hostname))
    return `Host ${url.hostname} resolves into loopback, link-local or private address space, which this tool never fetches.`;
  return undefined;
}

/** Strip markup to readable text. Deliberately simple: children need prose, not a DOM. */
export function extractText(body: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return body;
  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Append a provenance record. Acquisition that cannot be traced is not evidence. */
export async function logFetch(
  cwd: string, base: string, record: Record<string, unknown>,
): Promise<void> {
  const path = join(cwd, ".kanban", "loop", `${base}.net.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8")
    .catch(() => undefined);
}

export interface FetchDeps {
  fetch: typeof globalThis.fetch;
  refuse: typeof refuseUrl;
}

/**
 * Fetch one URL under the configured limits.
 *
 * Redirects are followed manually so every hop is re-checked against the allowlist. `redirect:
 * "follow"` would let an allowlisted host bounce a child onto any address at all, which defeats
 * the point of having an allowlist.
 */
export async function webFetch(
  request: FetchRequest,
  config: NetworkConfig,
  signal?: AbortSignal,
  deps: Partial<FetchDeps> = {},
): Promise<FetchOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const refuse = deps.refuse ?? refuseUrl;
  const limit = Math.min(request.maxBytes ?? config.maxBytes, config.maxBytes);
  let target = request.url;

  for (let hop = 0; hop < 5; hop++) {
    const reason = await refuse(target, config);
    if (reason) return { ok: false, url: target, error: reason };

    const timer = new AbortController();
    const onAbort = () => timer.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => timer.abort(), config.timeoutMs);
    try {
      const response = await doFetch(target, {
        redirect: "manual",
        signal: timer.signal,
        headers: { accept: "text/*, application/json;q=0.9, */*;q=0.5" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, url: target, status: response.status, error: "Redirect without a location header" };
        target = new URL(location, target).toString();
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok)
        return { ok: false, url: target, status: response.status, error: `HTTP ${response.status} ${response.statusText}`.trim() };

      const { text, bytes, truncated } = await readBounded(response, limit);
      return {
        ok: true, url: target, status: response.status, bytes, contentType,
        text: extractText(text, contentType), ...(truncated ? { truncated } : {}),
      };
    } catch (error) {
      const aborted = timer.signal.aborted && !signal?.aborted;
      return {
        ok: false, url: target,
        error: aborted ? `Timed out after ${config.timeoutMs}ms` : error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { ok: false, url: target, error: "Too many redirects" };
}

/** Read at most `limit` bytes, abandoning the rest rather than buffering an unbounded response. */
async function readBounded(
  response: Response, limit: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", bytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (bytes + value.byteLength > limit) {
        chunks.push(value.subarray(0, Math.max(0, limit - bytes)));
        bytes = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
}

export function contentDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface SearchOutcome {
  ok: boolean;
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
  error?: string;
}

/**
 * Query the configured search backend.
 *
 * Pi has no built-in search, so there is nothing to fall back to. An unconfigured backend says so
 * plainly rather than returning an empty result set, which a child would read as "nothing exists".
 */
export async function webSearch(
  query: string,
  config: NetworkConfig,
  signal?: AbortSignal,
  deps: Partial<FetchDeps> = {},
): Promise<SearchOutcome> {
  const search = config.search;
  if (!search)
    return { ok: false, error: "web_search has no backend configured. Set network.search.endpoint in /kanban config, or use web_fetch with a direct URL." };
  const key = search.apiKeyEnv ? process.env[search.apiKeyEnv] : undefined;
  if (search.apiKeyEnv && !key)
    return { ok: false, error: `web_search backend needs ${search.apiKeyEnv} in the environment; it is unset.` };

  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = new URL(search.endpoint);
  url.searchParams.set("q", query);
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => timer.abort(), config.timeoutMs);
  try {
    const response = await doFetch(url.toString(), {
      signal: timer.signal,
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    });
    if (!response.ok) return { ok: false, error: `Search backend returned HTTP ${response.status}` };
    const payload = (await response.json()) as { results?: SearchOutcome["results"]; web?: { results?: SearchOutcome["results"] } };
    const results = payload.results ?? payload.web?.results ?? [];
    return { ok: true, results: results.slice(0, 10) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}
