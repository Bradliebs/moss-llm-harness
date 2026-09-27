// electron/backend/moss/models/tool-index.ts
//
// Ranks tools (and lessons) by meaning. Word overlap misses requests such as
// "why is CI red?", which shares no words with run_command or read_file, so
// when an embeddings endpoint is configured each tool's name and description is
// embedded once and its cosine similarity is added to the word score.
// Without embeddings, or when the endpoint fails, ranking falls back to words.

import { createHash } from "node:crypto";

import type { EmbedConfig, ToolDefinition } from "../../../../common/types";
import { embedTexts } from "../providers/embeddings";
import type { Tool } from "../tools/types";
import { relevanceScores, selectByScore, selectRelevantTools } from "./scaffolding";

const EMBED_TIMEOUT_MS = 8_000;
/** Weight of meaning relative to the word score, where a word in a tool's
 *  name counts 3 and a core tool starts at 1. */
const SEMANTIC_WEIGHT = 3;
const MAX_CACHE = 2_000;
/** After an endpoint fails, ranking uses words for this long before retrying. */
const FAILURE_BACKOFF_MS = 10 * 60_000;

export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index];
    na += a[index] * a[index];
    nb += b[index] * b[index];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function key(model: string, text: string): string {
  return createHash("sha256").update(`${model}\u0000${text}`).digest("hex");
}

export function toolText(tool: Pick<ToolDefinition, "name" | "description">): string {
  return `${tool.name.replace(/_/g, " ")}: ${tool.description.slice(0, 400)}`;
}

export class SemanticIndex {
  private readonly vectors = new Map<string, number[]>();
  private readonly warming = new Set<string>();
  private readonly unavailableUntil = new Map<string, number>();

  constructor(
    private readonly embedderFor: (config: EmbedConfig) => Embedder = (config) => (texts, signal) => embedTexts(config, texts, signal),
    private readonly now: () => number = Date.now,
  ) {}

  /** Similarity of each text to the query, or null when embeddings are unavailable. */
  async similarities(query: string, texts: readonly string[], config: EmbedConfig | undefined, signal?: AbortSignal): Promise<number[] | null> {
    if (!config?.baseUrl || !config.model || !query.trim() || texts.length === 0) return null;
    const endpointKey = `${config.baseUrl}\u0000${config.model}`;
    if ((this.unavailableUntil.get(endpointKey) ?? 0) > this.now()) return null;
    // nomic-embed models are trained with task prefixes and separate topics
    // noticeably better with them.
    const [queryPrefix, documentPrefix] = /nomic/i.test(config.model) ? ["search_query: ", "search_document: "] : ["", ""];
    const missing = [...new Set(texts.filter((text) => !this.vectors.has(key(config.model, text))))];
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const request = this.embedderFor(config)([queryPrefix + query, ...missing.map((text) => documentPrefix + text)], controller.signal)
      .then(([queryVector, ...fresh]) => {
        missing.forEach((text, index) => this.vectors.set(key(config.model, text), fresh[index]));
        if (this.vectors.size > MAX_CACHE) this.vectors.clear();
        return queryVector;
      }, (error: unknown) => {
        // A missing model or unreachable endpoint would otherwise cost a failed
        // request on every turn; a cancelled turn says nothing about the endpoint.
        if (!controller.signal.aborted) this.unavailableUntil.set(endpointKey, this.now() + FAILURE_BACKOFF_MS);
        throw error;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EMBED_TIMEOUT_MS); });
    try {
      const queryVector = await Promise.race([request, timeout]);
      if (queryVector) return texts.map((text) => cosine(queryVector, this.vectors.get(key(config.model, text)) ?? []));
      // Document vectors are shared across turns, so a slow first request (a
      // cold embedding model) keeps filling the cache after this turn stops
      // waiting. One such request per endpoint at a time.
      if (missing.length > 0 && !this.warming.has(endpointKey)) {
        this.warming.add(endpointKey);
        signal?.removeEventListener("abort", abort);
        void request.catch(() => undefined).finally(() => this.warming.delete(endpointKey));
      } else {
        controller.abort();
        void request.catch(() => undefined);
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Rank tools by meaning added to the word score, keeping registry order for ties. */
  async rankTools(tools: readonly ToolDefinition[], query: string, limit: number, config?: EmbedConfig, signal?: AbortSignal): Promise<ToolDefinition[]> {
    if (tools.length <= limit) return [...tools];
    const similarities = await this.similarities(query, tools.map(toolText), config, signal);
    if (!similarities) return selectRelevantTools(tools, query, limit);
    // Cosines from small embedding models sit in a narrow band, so spread them
    // to [0, 1] before adding them to the word score, which keeps its priors:
    // core tools start ahead, housekeeping behind, and a named tool far ahead.
    const low = Math.min(...similarities);
    const span = Math.max(...similarities) - low || 1;
    const words = relevanceScores(tools, query);
    return selectByScore(tools, words.map((score, index) => score + SEMANTIC_WEIGHT * ((similarities[index] - low) / span)), limit);
  }
}

export const semanticIndex = new SemanticIndex();

export const FIND_TOOL_NAME = "find_tool";

/** Always offered when scaffolding narrows the tool list, so a model can ask
 *  for a capability it was not given instead of failing. */
export const findToolTool: Tool = {
  name: FIND_TOOL_NAME,
  description: "Find and enable a tool you need but were not given. Describe what you want to do, for example \"run the test suite\" or \"search the web\". Matching tools become available on your next step.",
  parameters: {
    type: "object",
    properties: { need: { type: "string", description: "What you need to do." } },
    required: ["need"],
  },
  async execute(args, ctx) {
    if (!ctx.findTools) return { ok: false, content: "Every available tool is already offered." };
    const need = String(args.need ?? "").trim();
    if (!need) return { ok: false, content: "Describe what you need to do." };
    return { ok: true, content: await ctx.findTools(need, ctx.signal) };
  },
};
