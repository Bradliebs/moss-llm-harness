// electron/backend/moss/providers/anthropic.ts
//
// Native Anthropic Messages API client with streaming text and tool use.

import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../../../../common/types";
import { joinUrl, safeText } from "./http";
import { readSSE } from "./sse";
import { ProviderError } from "./types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./types";

const DEFAULT_ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
];

/** DeepSeek's Anthropic-format endpoint rejects model names that are neither
 *  its own nor claude-*, so it gets its own list when it cannot list models. */
const DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

function isDeepSeek(baseUrl: string): boolean {
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Prompt-cache breakpoint. Anthropic caches the whole prefix (tools, then
 *  system, then messages) up to and including the block this is attached to, so
 *  a later request with an identical prefix reads it back at 10% of the input
 *  price instead of reprocessing it. Breakpoints themselves are free; writing a
 *  prefix costs 1.25x and entries live for 5 minutes, refreshed on every hit. */
const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: { type: "base64"; media_type: string; data: string };
  cache_control?: typeof CACHE_BREAKPOINT;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string | null };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

interface AnthropicModelList {
  data?: Array<{ id?: string }>;
}

/** Output tokens allowed per reply when the caller sets none. 4,096 cut a
 *  single-file page or game off after about 300 lines; current Claude models
 *  allow 32,000 or more, and a model that allows less says so and is asked again. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** The output limit a "max_tokens is too large" error names, for example
 *  "max_tokens: 32000 > 8192, which is the maximum allowed number of output
 *  tokens for claude-3-5-sonnet". Undefined for any other 400 error. */
export function modelOutputLimit(detail: string): number | undefined {
  if (!/max_tokens/i.test(detail)) return undefined;
  const match = /max_tokens[^0-9]*\d+\s*>\s*(\d+)/i.exec(detail)
    ?? /range[^[]{0,40}\[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(detail)
    ?? /(?:at most|maximum[^0-9]{0,80}?)\s*(\d{3,})/i.exec(detail);
  const limit = match ? Number(match[1]) : NaN;
  return Number.isInteger(limit) && limit > 0 && limit < DEFAULT_MAX_OUTPUT_TOKENS ? limit : undefined;
}

/** Limits to try, largest first, when a server rejects max_tokens without naming its own. */
const FALLBACK_OUTPUT_LIMITS = [16_000, 8_192, 4_096];

/** The output limit that worked for each endpoint and model, so a lower limit
 *  costs one rejected request per session rather than one per turn. */
const workingOutputLimits = new Map<string, number>();

/** Ways to ask for each reasoning setting, preferred first. Claude 4.6 and later
 *  think with "adaptive" (4.7 and later reject "enabled"); older thinking models
 *  know only "enabled"; Sonnet 5.5 rejects "disabled". A server that rejects
 *  one, saying why, is asked the next way; the last omits the field. */
const THINKING_MODES = {
  high: ["adaptive", "enabled", "omit"],
  none: ["disabled", "omit"],
  default: ["omit"],
} as const;
type ThinkingModeName = (typeof THINKING_MODES)[keyof typeof THINKING_MODES][number];

/** The thinking field for a mode. A manual budget must be at least 1,024 and
 *  below max_tokens, so it is half the output limit, up to 16,000. */
export function thinkingParam(mode: ThinkingModeName, maxTokens: number): Record<string, unknown> | undefined {
  if (mode === "adaptive") return { type: "adaptive", display: "summarized" };
  if (mode === "disabled") return { type: "disabled" };
  if (mode === "enabled" && maxTokens > 1_024) {
    return { type: "enabled", budget_tokens: Math.max(1_024, Math.min(16_000, Math.floor(maxTokens / 2))) };
  }
  return undefined;
}

/** The thinking mode that worked for each endpoint, model, and setting. */
const workingThinkingModes = new Map<string, number>();

/** Split a data URL (data:<mime>;base64,<payload>) into the media type and raw
 *  base64 payload Anthropic's image block expects, or null if it is not one. */
function parseDataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

export function toAnthropic(messages: AgentMessage[], model?: string): { system?: string; messages: AnthropicMessage[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      if ((m.images?.length ?? 0) > 0 || (m.documents?.length ?? 0) > 0) {
        const blocks: AnthropicBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const document of m.documents ?? []) {
          blocks.push({
            type: "text",
            text: `--- BEGIN ATTACHED FILE: ${document.name} (${document.mediaType}) ---\n${document.text}\n--- END ATTACHED FILE: ${document.name} ---`,
          });
        }
        for (const url of m.images ?? []) {
          const parsed = parseDataUrl(url);
          if (parsed) {
            blocks.push({ type: "image", source: { type: "base64", media_type: parsed.media_type, data: parsed.data } });
          }
        }
        out.push({ role: "user", content: blocks });
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      // Thinking from a round that called tools goes back first and unchanged,
      // or the model loses its reasoning when the tool results arrive.
      const replay = m.reasoningReplay;
      if (replay?.blocks?.length && replay.model === model && m.toolCalls?.length) {
        for (const block of replay.blocks) blocks.push(block as unknown as AnthropicBlock);
      }
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : m.content });
    } else if (m.role === "tool") {
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      const target = last && last.role === "user" && Array.isArray(last.content) ? last.content : null;
      if (target) target.push(block);
      else out.push({ role: "user", content: [block] });
      // Images a tool produced ride in the same user message as sibling blocks.
      // A separate user message would put two user turns back to back, which
      // Anthropic rejects, so they are never pushed as their own message.
      if ((m.images?.length ?? 0) > 0) {
        const content = target ?? (out[out.length - 1].content as AnthropicBlock[]);
        for (const url of m.images ?? []) {
          const parsed = parseDataUrl(url);
          if (parsed) {
            content.push({ type: "image", source: { type: "base64", media_type: parsed.media_type, data: parsed.data } });
          }
        }
      }
    }
  }

  return { system: system || undefined, messages: out };
}

/** Mark a message's final content block as a cache breakpoint. Empty blocks
 *  cannot be cached, so a message with no content is left alone. */
function markBreakpoint(message: AnthropicMessage | undefined): void {
  if (!message) return;
  if (typeof message.content === "string") {
    if (!message.content) return;
    message.content = [{ type: "text", text: message.content, cache_control: CACHE_BREAKPOINT }];
    return;
  }
  const block = message.content[message.content.length - 1];
  if (block) block.cache_control = CACHE_BREAKPOINT;
}

const isToolResults = (message: AnthropicMessage): boolean =>
  message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");

/** Two conversation breakpoints (with the system and tools ones, the API's limit
 *  of four). The latest user message carries this turn's <turn_context>, which
 *  the next turn will not repeat, so a cache written there would never be read.
 *  Instead: one on the message before it, the end of the history every later
 *  turn repeats, and one on the last message when it is a tool result, which
 *  the next round of the same turn repeats. Mutates the freshly built array
 *  from `toAnthropic`. */
function markConversationBreakpoints(messages: AnthropicMessage[]): void {
  let latestUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isToolResults(messages[i])) {
      latestUser = i;
      break;
    }
  }
  if (latestUser > 0) markBreakpoint(messages[latestUser - 1]);
  const last = messages[messages.length - 1];
  if (last && (latestUser < 0 || isToolResults(last))) markBreakpoint(last);
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const { system, messages } = toAnthropic(req.messages, req.model);
    markConversationBreakpoints(messages);

    // Breakpoints ordered by how often each section changes: tools are stable
    // for a whole session, the system prompt nearly so, and the conversation
    // grows every round. If a later section changes, the earlier caches still hit.
    const reqTools = req.tools;
    const tools =
      reqTools && reqTools.length > 0
        ? reqTools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
            ...(i === reqTools.length - 1 ? { cache_control: CACHE_BREAKPOINT } : {}),
          }))
        : undefined;

    const send = (maxTokens: number, thinking: Record<string, unknown> | undefined): Promise<Response> => fetch(joinUrl(this.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: maxTokens,
        ...(system ? { system: [{ type: "text", text: system, cache_control: CACHE_BREAKPOINT }] } : {}),
        messages,
        stream: true,
        // Thinking does not combine with a changed temperature.
        ...(req.temperature !== undefined && !(thinking && thinking.type !== "disabled") ? { temperature: req.temperature } : {}),
        ...(thinking ? { thinking } : {}),
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    // Models allow different output sizes. A model with a smaller limit
    // rejects the default, usually naming its own maximum; ask again with that,
    // or step down when the error names none. Only when the caller set no limit.
    // A rejected thinking setting moves to the next way of asking for it.
    const limitKey = `${this.baseUrl}\u0000${req.model}`;
    const modes = THINKING_MODES[req.reasoning ?? "default"];
    const thinkingKey = `${limitKey}\u0000${req.reasoning ?? "default"}`;
    let modeIndex = workingThinkingModes.get(thinkingKey) ?? 0;
    let maxTokens = req.maxTokens ?? workingOutputLimits.get(limitKey) ?? DEFAULT_MAX_OUTPUT_TOKENS;
    let res = await send(maxTokens, thinkingParam(modes[modeIndex], maxTokens));
    while (res.status === 400) {
      const detail = await safeText(res);
      const named = modelOutputLimit(detail);
      // Each retry either lowers the limit or moves to a later mode, so this ends.
      const next = req.maxTokens !== undefined
        ? undefined
        : named !== undefined && named < maxTokens
          ? named
          : /max_tokens/i.test(detail) ? FALLBACK_OUTPUT_LIMITS.find((limit) => limit < maxTokens) : undefined;
      if (next !== undefined) maxTokens = next;
      else if (modeIndex < modes.length - 1 && /thinking/i.test(detail)) modeIndex++;
      else throw new ProviderError(`Anthropic request failed: HTTP 400 ${detail}`, 400);
      res = await send(maxTokens, thinkingParam(modes[modeIndex], maxTokens));
    }
    if (res.ok && req.maxTokens === undefined) workingOutputLimits.set(limitKey, maxTokens);
    if (res.ok) workingThinkingModes.set(thinkingKey, modeIndex);
    if (!res.ok || !res.body) {
      throw new ProviderError(`Anthropic request failed: HTTP ${res.status} ${await safeText(res)}`, res.status);
    }

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; thinking?: string; signature?: string; data?: string }>();

    for await (const data of readSSE(res.body, signal)) {
      let json: AnthropicStreamEvent;
      try {
        json = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (json.type) {
        case "message_start": {
          // Anthropic splits the prompt across three counters once caching is on:
          // `input_tokens` only covers what follows the last breakpoint. Sum them
          // so the runner sees the real prompt size, as it does for OpenAI.
          const u = json.message?.usage;
          if (u) {
            yield {
              type: "usage",
              usage: {
                inputTokens:
                  (u.input_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0),
                ...(u.cache_read_input_tokens ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
              },
            };
          }
          break;
        }
        case "content_block_start":
          blocks.set(json.index ?? 0, {
            type: json.content_block?.type ?? "",
            id: json.content_block?.id,
            name: json.content_block?.name,
            json: "",
            thinking: "",
            signature: "",
            data: json.content_block?.data,
          });
          break;
        case "content_block_delta":
          if (json.delta?.type === "text_delta" && json.delta.text) {
            yield { type: "text-delta", text: json.delta.text };
          } else if (json.delta?.type === "input_json_delta" && typeof json.delta.partial_json === "string") {
            const b = blocks.get(json.index ?? 0);
            if (b) b.json += json.delta.partial_json;
          } else if (json.delta?.type === "thinking_delta" && typeof json.delta.thinking === "string") {
            const b = blocks.get(json.index ?? 0);
            if (b) b.thinking += json.delta.thinking;
            if (json.delta.thinking) yield { type: "reasoning-delta", text: json.delta.thinking };
          } else if (json.delta?.type === "signature_delta" && typeof json.delta.signature === "string") {
            const b = blocks.get(json.index ?? 0);
            if (b) b.signature += json.delta.signature;
          }
          break;
        case "content_block_stop": {
          const b = blocks.get(json.index ?? 0);
          if (b && b.type === "tool_use") {
            yield {
              type: "tool-call",
              toolCall: { id: b.id || randomUUID(), name: b.name ?? "", arguments: b.json || "{}" },
            };
          } else if (b && b.type === "thinking") {
            yield { type: "reasoning-replay", blocks: [{ type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" }] };
          } else if (b && b.type === "redacted_thinking" && b.data) {
            yield { type: "reasoning-replay", blocks: [{ type: "redacted_thinking", data: b.data }] };
          }
          blocks.delete(json.index ?? 0);
          break;
        }
        case "message_delta":
          if (json.usage) yield { type: "usage", usage: { outputTokens: json.usage.output_tokens } };
          if (json.delta?.stop_reason === "max_tokens") {
            // A tool_use block cut off by the limit may never get its
            // content_block_stop: pass it on as it is, so the runner can say
            // why it did not run instead of the call vanishing.
            for (const [index, b] of blocks) {
              if (b.type === "tool_use") {
                yield { type: "tool-call", toolCall: { id: b.id || randomUUID(), name: b.name ?? "", arguments: b.json } };
                blocks.delete(index);
              }
            }
            yield { type: "output-limit" };
          }
          break;
        case "error":
          throw new Error(json.error?.message ?? "Anthropic stream error");
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(joinUrl(this.baseUrl, "/v1/models"), {
        headers: {
          "anthropic-version": "2023-06-01",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
      });
      if (res.ok) {
        const json = (await res.json()) as AnthropicModelList;
        const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        if (ids.length > 0) return ids;
      }
    } catch {
      /* fall through to static list */
    }
    return isDeepSeek(this.baseUrl) ? DEEPSEEK_MODELS : DEFAULT_ANTHROPIC_MODELS;
  }
}
