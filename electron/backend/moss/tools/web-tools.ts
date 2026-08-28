// electron/backend/moss/tools/web-tools.ts
//
// Keyless web access: search via DuckDuckGo's HTML endpoint and fetch a single
// page as readable text. Both tools reach the public internet, so they are
// permission-gated (not in AUTO_ALLOW) exactly like run_command — the approval
// card shows the model-chosen query/URL before any request is made.

import type { Tool, ToolContext, ToolResult } from "./types";
import { fetchPublicUrl } from "./outbound-http";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";
const DUCKDUCKGO_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const FETCH_CAP = 100_000;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

// Short-lived result cache + per-host throttle so repeated identical lookups in
// a single turn don't re-hit the network, and we stay polite to each host.
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 100;
const MIN_HOST_INTERVAL_MS = 1_000;
// Vitest stubs fetch, so the real politeness delay would only slow the suite.
const THROTTLE_ENABLED = !process.env.VITEST;

const resultCache = new Map<string, { expires: number; content: string }>();
const lastHostHit = new Map<string, number>();

function cacheGet(key: string): string | null {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return hit.content;
}

function cacheSet(key: string, content: string): void {
  if (resultCache.size >= CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, { expires: Date.now() + CACHE_TTL_MS, content });
}

/** Resolve after `ms`, or early if the turn aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onDone = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onDone);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    signal.addEventListener("abort", onDone, { once: true });
  });
}

/** Enforce a minimum gap between requests to the same host. */
async function throttleHost(host: string, signal: AbortSignal): Promise<void> {
  if (!THROTTLE_ENABLED) return;
  const last = lastHostHit.get(host) ?? 0;
  const wait = MIN_HOST_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await delay(wait, signal);
  lastHostHit.set(host, Date.now());
}

/** Test-only: clear cache and throttle state between cases. */
export function __resetWebToolsCache(): void {
  resultCache.clear();
  lastHostHit.clear();
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Decode HTML entities that appear in DuckDuckGo result markup. */
function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip tags and collapse whitespace to a plain-text line. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded>. Unwrap it. */
function unwrapRedirect(href: string): string {
  const normalized = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(normalized);
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : normalized;
  } catch {
    return normalized;
  }
}

/** Bing wraps result links in /ck/a URLs whose `u` parameter is `a1` plus a
 * base64url-encoded target. Return the target when it can be decoded. */
function unwrapBingRedirect(href: string): string {
  const normalized = decodeEntities(href);
  try {
    const url = new URL(normalized);
    const encoded = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : null;
    if (!encoded?.startsWith("a1")) return normalized;
    const target = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    return /^https?:\/\//i.test(target) ? target : normalized;
  } catch {
    return normalized;
  }
}

function parseResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each result anchor: <a ... class="result__a" href="...">Title</a>
  const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets: <a ... class="result__snippet" ...>snippet</a>
  const snippets: string[] = [];
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = anchor.exec(html)) !== null && hits.length < limit) {
    const url = unwrapRedirect(decodeEntities(m[1]));
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      i += 1;
      continue;
    }
    hits.push({ title, url, snippet: snippets[i] ?? "" });
    i += 1;
  }
  return hits;
}

function parseBingResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const block = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = block.exec(html)) !== null && hits.length < limit) {
    const title = /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(match[1]);
    if (!title) continue;
    const url = unwrapBingRedirect(title[1]);
    const text = stripTags(title[2]);
    if (!text || !/^https?:\/\//i.test(url)) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(match[1]);
    hits.push({ title: text, url, snippet: snippet ? stripTags(snippet[1]) : "" });
  }
  return hits;
}

async function searchBing(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `${BING_SEARCH_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
  await throttleHost("www.bing.com", signal);
  const response = await fetch(url, { headers: { "User-Agent": UA }, signal });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  return parseBingResults(await response.text(), limit);
}

async function searchDuckDuckGo(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
  await throttleHost("html.duckduckgo.com", signal);
  const response = await fetch(DUCKDUCKGO_SEARCH_ENDPOINT, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (response.status !== 200) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  return parseResults(await response.text(), limit);
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web and return the top results as title, URL, and snippet. Use fetch_url to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: {
        type: "number",
        description: `Number of results to return (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS})`,
      },
    },
    required: ["query"],
  },
  timeoutMs: FETCH_TIMEOUT_MS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, content: "query is required" };
    const requested = Number(args.count);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_RESULTS)
      : DEFAULT_RESULTS;

    const cacheKey = `search:${limit}:${query.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return { ok: true, content: cached };

    let hits: SearchHit[] = [];
    const failures: string[] = [];
    try {
      hits = await searchBing(query, limit, ctx.signal);
    } catch (e) {
      failures.push((e as Error).message);
    }
    if (hits.length === 0) {
      try {
        hits = await searchDuckDuckGo(query, limit, ctx.signal);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (hits.length === 0) {
      if (failures.length === 2) return { ok: false, content: `Search failed: ${failures.join("; ")}` };
      return { ok: true, content: `No results for "${query}".` };
    }

    const formatted = hits
      .map((h, idx) => {
        const snippet = h.snippet ? `\n   ${h.snippet}` : "";
        return `${idx + 1}. ${h.title}\n   ${h.url}${snippet}`;
      })
      .join("\n\n");
    cacheSet(cacheKey, formatted);
    return { ok: true, content: formatted };
  },
};

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a single http(s) web page and return its readable text content (scripts, styles, and markup stripped). Returns up to 100k characters.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL" } },
    required: ["url"],
  },
  timeoutMs: FETCH_TIMEOUT_MS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args.url ?? "").trim();
    if (!raw) return { ok: false, content: "url is required" };
    try {
      const target = new URL(raw);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return { ok: false, content: "Only http and https URLs are supported" };
      }
      if (target.username || target.password) {
        return { ok: false, content: "URLs with embedded credentials are not allowed" };
      }
    } catch {
      return { ok: false, content: `Invalid URL: ${raw}` };
    }
    const cacheKey = `fetch:${raw}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return { ok: true, content: cached };

    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetchPublicUrl(raw, timeout.signal, {
        beforeRequest: (url) => throttleHost(url.host, ctx.signal),
      });
    } catch (e) {
      return { ok: false, content: `Fetch failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
    if (!res.ok) return { ok: false, content: `Fetch failed with HTTP ${res.status}` };

    const contentType = res.headers["content-type"] ?? "";
    const text = res.body;
    let readable: string;
    if (contentType.includes("text/html") || /<html[\s>]/i.test(text)) {
      readable = text
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
        .replace(/<[^>]+>/g, "");
      readable = decodeEntities(readable)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    } else {
      readable = text.trim();
    }

    const truncated = readable.length > FETCH_CAP;
    const content = truncated ? `${readable.slice(0, FETCH_CAP)}\n…[truncated]` : readable;
    cacheSet(cacheKey, content);
    return { ok: true, content };
  },
};
