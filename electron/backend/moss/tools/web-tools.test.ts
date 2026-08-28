// electron/backend/moss/tools/web-tools.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";

const outbound = vi.hoisted(() => ({
  fetchPublicUrl: vi.fn(),
}));

vi.mock("./outbound-http", () => outbound);

import type { ToolContext } from "./types";
import { __resetWebToolsCache, fetchUrlTool, webSearchTool } from "./web-tools";

function ctx(): ToolContext {
  return { workspaceRoot: "", signal: new AbortController().signal };
}

function mockFetch(body: string, init?: { ok?: boolean; status?: number; contentType?: string }) {
  const ok = init?.ok ?? true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: init?.status ?? (ok ? 200 : 500),
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? init?.contentType ?? "text/html" : null) },
      text: async () => body,
    })),
  );
  outbound.fetchPublicUrl.mockResolvedValue({
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    headers: { "content-type": init?.contentType ?? "text/html" },
    body,
    finalUrl: "https://example.com/",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  outbound.fetchPublicUrl.mockReset();
  __resetWebToolsCache();
});

describe("web_search", () => {
  it("parses Bing result blocks and unwraps encoded redirects", async () => {
    const target = "https://example.com/world-news";
    const encoded = Buffer.from(target).toString("base64url");
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${encoded}">World News</a></h2><p>Today's headlines.</p></li>`;
    mockFetch(html);

    const res = await webSearchTool.execute({ query: "world news" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("1. World News");
    expect(res.content).toContain(target);
    expect(res.content).toContain("Today's headlines.");
  });

  it("falls back to DuckDuckGo when Bing has no parseable results", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">First &amp; Best</a>
        <a class="result__snippet">Snippet about <b>example</b> one.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second Result</a>
        <a class="result__snippet">Second snippet.</a>
      </div>`;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "<div>no Bing results</div>" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => html }));

    const res = await webSearchTool.execute({ query: "example" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("1. First & Best");
    expect(res.content).toContain("https://example.com/a");
    expect(res.content).toContain("Snippet about example one.");
    expect(res.content).toContain("2. Second Result");
    expect(res.content).toContain("https://example.org/b");
  });

  it("respects the count cap", async () => {
    const block = (n: number) =>
      `<a class="result__a" href="https://e${n}.com">R${n}</a><a class="result__snippet">s${n}</a>`;
    mockFetch([1, 2, 3, 4, 5].map(block).join(""));
    const res = await webSearchTool.execute({ query: "x", count: 2 }, ctx());
    expect(res.content).toContain("1. R1");
    expect(res.content).toContain("2. R2");
    expect(res.content).not.toContain("3. R3");
  });

  it("requires a query", async () => {
    const res = await webSearchTool.execute({ query: "  " }, ctx());
    expect(res.ok).toBe(false);
  });

  it("reports a no-results query honestly", async () => {
    mockFetch("<div>nothing here</div>");
    const res = await webSearchTool.execute({ query: "zzz" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No results");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("does not cache empty results", async () => {
    mockFetch("<div>nothing here</div>");
    await webSearchTool.execute({ query: "retry me" }, ctx());
    await webSearchTool.execute({ query: "retry me" }, ctx());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });

  it("does not treat DuckDuckGo's HTTP 202 challenge as empty results", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" })
      .mockResolvedValueOnce({ ok: true, status: 202, text: async () => "challenge" }));
    const res = await webSearchTool.execute({ query: "news" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Bing HTTP 503");
    expect(res.content).toContain("DuckDuckGo HTTP 202");
  });

  it("serves a repeat query from cache without re-fetching", async () => {
    const html = `<li class="b_algo"><h2><a href="https://e1.com">R1</a></h2><p>s1</p></li>`;
    mockFetch(html);
    const first = await webSearchTool.execute({ query: "cached" }, ctx());
    const second = await webSearchTool.execute({ query: "cached" }, ctx());
    expect(second.content).toBe(first.content);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("fetch_url", () => {
  it("strips scripts, styles, and tags to readable text", async () => {
    const html =
      "<html><head><style>.x{color:red}</style><script>alert(1)</script></head>" +
      "<body><h1>Title</h1><p>Hello &amp; welcome.</p></body></html>";
    mockFetch(html, { contentType: "text/html" });
    const res = await fetchUrlTool.execute({ url: "https://example.com" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Title");
    expect(res.content).toContain("Hello & welcome.");
    expect(res.content).not.toContain("alert(1)");
    expect(res.content).not.toContain("color:red");
  });

  it("rejects non-http protocols", async () => {
    const res = await fetchUrlTool.execute({ url: "file:///etc/passwd" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("http");
  });

  it("rejects an invalid URL", async () => {
    const res = await fetchUrlTool.execute({ url: "not a url" }, ctx());
    expect(res.ok).toBe(false);
  });
});
