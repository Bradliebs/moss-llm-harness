import { describe, expect, it, vi } from "vitest";

import type { EmbedConfig, ToolDefinition } from "../../../../common/types";
import type { ToolContext } from "../tools/types";
import { findToolTool, SemanticIndex, toolText } from "./tool-index";

const tool = (name: string, description: string): ToolDefinition => ({ name, description, parameters: { type: "object", properties: {} } });
const TOOLS = [
  tool("read_file", "Read a text file from the workspace"),
  tool("write_file", "Write a file"),
  tool("run_command", "Run a shell command and return its output"),
  tool("web_search", "Search the web"),
  tool("send_email", "Send an email"),
];
const EMBED: EmbedConfig = { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" };

/** Embeds by keyword so the test controls similarity: the query shares a
 *  dimension with run_command even though they share no words. */
function keywordEmbedder(calls: string[][]) {
  return () => async (texts: string[]) => {
    calls.push(texts);
    return texts.map((text) => [/CI|command|shell/i.test(text) ? 1 : 0, /web/i.test(text) ? 1 : 0, 0.1]);
  };
}

describe("SemanticIndex", () => {
  it("ranks tools by meaning when embeddings are configured and caches tool vectors", async () => {
    const calls: string[][] = [];
    const index = new SemanticIndex(keywordEmbedder(calls));
    const ranked = await index.rankTools(TOOLS, "why is CI red?", 2, EMBED);
    expect(ranked.map((item) => item.name)).toContain("run_command");
    expect(ranked).toHaveLength(2);
    // nomic models get their task prefixes.
    expect(calls[0][0]).toBe("search_query: why is CI red?");
    expect(calls[0][1]).toBe(`search_document: ${toolText(TOOLS[0])}`);
    await index.rankTools(TOOLS, "run the build", 2, EMBED);
    expect(calls[1]).toEqual(["search_query: run the build"]);
  });

  it("keeps a tool the request names and falls back to words without embeddings", async () => {
    const failing = new SemanticIndex(() => async () => { throw new Error("offline"); });
    expect(await failing.similarities("x", ["a"], EMBED)).toBeNull();
    const words = await failing.rankTools(TOOLS, "search the web", 2, EMBED);
    expect(words.map((item) => item.name)).toContain("web_search");
    const index = new SemanticIndex(keywordEmbedder([]));
    expect((await index.rankTools(TOOLS, "use send_email to reply", 1, EMBED)).map((item) => item.name)).toContain("send_email");
    expect(await index.rankTools(TOOLS.slice(0, 2), "anything", 5)).toEqual(TOOLS.slice(0, 2));
    expect(await index.similarities("q", ["a"], undefined)).toBeNull();
  });
});

describe("SemanticIndex failures", () => {
  it("backs off from a failing endpoint instead of retrying every turn", async () => {
    let now = 0;
    const embed = vi.fn(async () => { throw new Error("model not found"); });
    const index = new SemanticIndex(() => embed, () => now);
    expect(await index.similarities("q", ["a"], EMBED)).toBeNull();
    expect(await index.similarities("q", ["a"], EMBED)).toBeNull();
    expect(embed).toHaveBeenCalledOnce();
    now = 10 * 60_000 + 1;
    await index.similarities("q", ["a"], EMBED);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("does not back off when the turn itself was cancelled", async () => {
    const controller = new AbortController();
    const embed = vi.fn(async (_texts: string[], signal?: AbortSignal) => {
      controller.abort();
      signal?.throwIfAborted();
      return [[1]];
    });
    const index = new SemanticIndex(() => embed);
    expect(await index.similarities("q", ["a"], EMBED, controller.signal)).toBeNull();
    await index.similarities("q", ["a"], EMBED);
    expect(embed).toHaveBeenCalledTimes(2);
  });
});

describe("SemanticIndex cold start", () => {
  it("falls back to words on a slow first request but keeps filling the cache for the next turn", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[][] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const index = new SemanticIndex(() => async (texts) => {
        calls.push(texts);
        if (calls.length === 1) await gate;
        return texts.map((text) => [/command/i.test(text) ? 1 : 0, 0.1]);
      });
      const pending = index.similarities("run it", ["run command: x", "read file: y"], EMBED);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toBeNull();
      release();
      await vi.runAllTimersAsync();
      const warm = await index.similarities("run it", ["run command: x", "read file: y"], EMBED);
      expect(warm).toHaveLength(2);
      expect(calls[1]).toEqual(["search_query: run it"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("find_tool", () => {
  const ctx = (findTools?: ToolContext["findTools"]) => ({ signal: new AbortController().signal, workspaceRoot: null, ...(findTools ? { findTools } : {}) }) as unknown as ToolContext;

  it("asks the runner for matching tools", async () => {
    const findTools = vi.fn(async () => "Enabled run_command.");
    expect(await findToolTool.execute({ need: "run the tests" }, ctx(findTools))).toEqual({ ok: true, content: "Enabled run_command." });
    expect(findTools).toHaveBeenCalledWith("run the tests", expect.any(AbortSignal));
  });

  it("explains when there is nothing to find or no need was given", async () => {
    expect(await findToolTool.execute({ need: "x" }, ctx())).toMatchObject({ ok: false });
    expect(await findToolTool.execute({ need: " " }, ctx(vi.fn()))).toEqual({ ok: false, content: "Describe what you need to do." });
  });
});
