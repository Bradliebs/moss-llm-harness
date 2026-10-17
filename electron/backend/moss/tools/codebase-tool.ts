// electron/backend/moss/tools/codebase-tool.ts
//
// Read-only semantic search over the workspace's persisted embedding index.
// Auto-allowed (see permission.ts) since it only reads indexed content.

import { codebaseIndex } from "../codebase/codebase-index";
import type { Tool, ToolContext, ToolResult } from "./types";

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;

function clampResults(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

export const searchCodebaseTool: Tool = {
  name: "search_codebase",
  description:
    "Semantic search over the workspace's indexed files. Returns the most relevant snippets for a natural-language query, each headed by 'path:startLine-endLine'. Use this to locate where a concept, feature, or behavior lives when you don't know the exact text to grep for; use search_files for exact literal matches. Requires the workspace to have been indexed first (Settings → Codebase index).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language description of what to find" },
      maxResults: {
        type: "number",
        description: `Maximum snippets to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})`,
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, content: "query is required" };
    if (!ctx.workspaceRoot) return { ok: false, content: "No workspace folder selected" };
    if (!ctx.embed || !ctx.embed.model) {
      return { ok: false, content: "search_codebase is not available here: no embedding model is configured. Use search_files (text or regex) or glob_files instead." };
    }
    // An empty result from a workspace that was never indexed would read as
    // "nothing relevant exists", so say why there is nothing to search.
    const status = await codebaseIndex.status(ctx.workspaceRoot).catch(() => undefined);
    if (status && !status.indexed) {
      return { ok: false, content: "search_codebase is not available here: this workspace has not been indexed (Settings → Codebase index). Use search_files (text or regex) or glob_files instead." };
    }

    let hits;
    try {
      hits = await codebaseIndex.search(ctx.workspaceRoot, ctx.embed, query, clampResults(args.maxResults), ctx.signal);
    } catch (err) {
      return { ok: false, content: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (hits.length === 0) {
      return {
        ok: true,
        content: "No indexed matches. If the workspace has not been indexed yet, index it from Settings → Codebase index.",
      };
    }
    const body = hits
      .map((h) => `${h.path}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${h.text}`)
      .join("\n\n---\n\n");
    return { ok: true, content: body };
  },
};
