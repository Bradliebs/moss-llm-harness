import { wrapExternalContent } from "../safety/untrusted-wrap";
import { ToolOutputStore, toolOutputStore } from "../context/tool-output-store";
import type { Tool, ToolResult } from "./types";

const MAX_READ_CHARS = 12_000;
const MAX_MATCHES = 20;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

export function createReadToolOutputTool(store: ToolOutputStore): Tool {
  return {
    name: "read_tool_output",
    description: "Read a bounded range from a stored tool-output artifact, or search it for a literal string.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Opaque artifact id from a truncated tool result" },
        offset: { type: "number", description: "Character offset for a range read (default 0)" },
        limit: { type: "number", description: `Maximum characters to return (default and maximum: what fits in one result, at most ${MAX_READ_CHARS})` },
        query: { type: "string", description: "Optional case-sensitive literal search text" },
      },
      required: ["id"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      // A page larger than what the model sees of one result would lose its middle.
      const maxChars = Math.max(1_000, Math.min(MAX_READ_CHARS, (ctx?.maxResultChars ?? MAX_READ_CHARS) - 400));
      let record;
      try {
        record = await store.get(String(args.id ?? ""));
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
      if (!record) return { ok: false, content: "Tool output artifact was not found or has expired" };

      const query = typeof args.query === "string" ? args.query : "";
      let content: string;
      if (query) {
        const lines = record.content.split("\n");
        const matches = lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter((match) => match.line.includes(query))
          .slice(0, MAX_MATCHES);
        content = matches.length > 0
          ? matches.map((match) => `${match.number}: ${match.line}`).join("\n").slice(0, maxChars)
          : `No matches for ${JSON.stringify(query)}`;
      } else {
        const offset = clamp(args.offset, 0, 0, record.content.length);
        const limit = clamp(args.limit, maxChars, 1, maxChars);
        const body = record.content.slice(offset, offset + limit);
        content = `${body}\n\n[characters ${offset}-${offset + body.length} of ${record.content.length}]`;
      }
      return {
        ok: true,
        content: record.external ? wrapExternalContent(record.toolName, content) : content,
        ...(record.external ? { untrustedSources: [record.toolName] } : {}),
      };
    },
  };
}

export const readToolOutputTool = createReadToolOutputTool(toolOutputStore);