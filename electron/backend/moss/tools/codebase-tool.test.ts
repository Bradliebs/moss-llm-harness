// electron/backend/moss/tools/codebase-tool.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { codebaseIndex } from "../codebase/codebase-index";
import { searchCodebaseTool } from "./codebase-tool";
import type { ToolContext } from "./types";

vi.mock("../codebase/codebase-index", () => ({
  codebaseIndex: { search: vi.fn(), status: vi.fn() },
}));

const search = vi.mocked(codebaseIndex.search);
const status = vi.mocked(codebaseIndex.status);

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: "/ws",
    signal: new AbortController().signal,
    embed: { baseUrl: "http://x", model: "embed-v1" },
    ...overrides,
  };
}

beforeEach(() => {
  status.mockResolvedValue({ indexed: true, files: 2, chunks: 4, model: "embed-v1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchCodebaseTool", () => {
  it("requires a query", async () => {
    const res = await searchCodebaseTool.execute({ query: "  " }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/query is required/);
  });

  it("requires a workspace", async () => {
    const res = await searchCodebaseTool.execute({ query: "x" }, ctx({ workspaceRoot: "" }));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/No workspace/);
  });

  it("requires an embedding model", async () => {
    const res = await searchCodebaseTool.execute({ query: "x" }, ctx({ embed: undefined }));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no embedding model is configured.*search_files/);
  });

  it("says an unindexed workspace cannot be searched, instead of reporting no matches", async () => {
    status.mockResolvedValue({ indexed: false, files: 0, chunks: 0, model: "" });
    const res = await searchCodebaseTool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/has not been indexed.*search_files/);
    expect(search).not.toHaveBeenCalled();
  });

  it("formats ranked hits", async () => {
    search.mockResolvedValue([
      { path: "src/a.ts", startLine: 1, endLine: 5, score: 0.92, text: "const a = 1;" },
      { path: "src/b.ts", startLine: 10, endLine: 12, score: 0.41, text: "const b = 2;" },
    ]);
    const res = await searchCodebaseTool.execute({ query: "find a", maxResults: 2 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("src/a.ts:1-5 (score 0.920)");
    expect(res.content).toContain("const a = 1;");
    expect(res.content).toContain("src/b.ts:10-12 (score 0.410)");
    expect(search).toHaveBeenCalledWith("/ws", expect.objectContaining({ model: "embed-v1" }), "find a", 2, expect.anything());
  });

  it("reports when nothing is indexed", async () => {
    search.mockResolvedValue([]);
    const res = await searchCodebaseTool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/No indexed matches/);
  });

  it("surfaces a search failure", async () => {
    search.mockRejectedValue(new Error("embeddings down"));
    const res = await searchCodebaseTool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Search failed: embeddings down/);
  });
});
