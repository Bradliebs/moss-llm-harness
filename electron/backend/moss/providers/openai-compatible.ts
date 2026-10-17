// electron/backend/moss/providers/openai-compatible.ts
//
// Covers Ollama (via its /v1 endpoint), OpenAI, LM Studio, vLLM, Groq,
// OpenRouter, and any other server exposing /chat/completions + /models.
// Supports streaming text and OpenAI-style function/tool calls.

import { randomUUID } from "node:crypto";

import type { AgentMessage } from "../../../../common/types";
import { joinUrl, safeText } from "./http";
import { readSSE } from "./sse";
import { ProviderError } from "./types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./types";

interface OAToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OAStreamChunk {
  choices?: Array<{
    /** reasoning: Ollama; reasoning_content: vLLM, DeepSeek, and others */
    delta?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: OAToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface OpenAiModelList {
  data?: Array<{ id?: string }>;
}

export function toOpenAiMessages(messages: AgentMessage[], model?: string): unknown[] {
  // Reasoning goes back only on the latest round that called tools, by the model
  // that wrote it: enough to keep its train of thought, and a small local
  // context window is not filled with every earlier round's thinking.
  let replayAt = -1;
  if (model) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.toolCalls?.length) {
        if (m.reasoningReplay?.text && m.reasoningReplay.model === model) replayAt = i;
        break;
      }
    }
  }
  // flatMap, not map: a tool result carrying images expands into two messages.
  return messages.flatMap((m, i): unknown[] => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return [
        {
          role: "assistant",
          content: m.content || null,
          ...(i === replayAt ? { [m.reasoningReplay?.field ?? "reasoning"]: m.reasoningReplay?.text } : {}),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      ];
    }
    if (m.role === "tool") {
      const toolMsg = { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      // A tool message may only carry a string, so images a tool produced follow
      // as their own user message. Unlike Anthropic, this API does not require
      // roles to alternate, so an extra user turn here is well formed.
      if ((m.images?.length ?? 0) > 0) {
        return [
          toolMsg,
          {
            role: "user",
            content: (m.images ?? []).map((url) => ({ type: "image_url", image_url: { url } })),
          },
        ];
      }
      return [toolMsg];
    }
    if (m.role === "user" && ((m.images?.length ?? 0) > 0 || (m.documents?.length ?? 0) > 0)) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const document of m.documents ?? []) {
        parts.push({
          type: "text",
          text: `--- BEGIN ATTACHED FILE: ${document.name} (${document.mediaType}) ---\n${document.text}\n--- END ATTACHED FILE: ${document.name} ---`,
        });
      }
      for (const url of m.images ?? []) parts.push({ type: "image_url", image_url: { url } });
      return [{ role: "user", content: parts }];
    }
    return [{ role: m.role, content: m.content }];
  });
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly kind = "openai-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly options: { reasoningEffort?: "none" } = {},
  ) {}

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    // A response schema replaces native tools; servers may reject both together.
    const tools =
      !req.responseSchema && req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    const reasoning = req.reasoning ?? this.options.reasoningEffort;
    const send = (withReasoning: boolean): Promise<Response> => fetch(joinUrl(this.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAiMessages(req.messages, withReasoning ? req.model : undefined),
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: "moss_step", schema: req.responseSchema } } } : {}),
        ...(withReasoning && reasoning !== undefined ? { reasoning_effort: reasoning } : {}),
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    let res = await send(true);
    // Some servers and models reject reasoning_effort (or the value "none"), or
    // reasoning sent back on an assistant message; the request is valid without.
    const replays = req.messages.some((m) => m.reasoningReplay?.text);
    if (res.status === 400 && (reasoning !== undefined || replays)) {
      const detail = await safeText(res);
      if (/reasoning|think/i.test(detail)) res = await send(false);
      else throw new ProviderError(`OpenAI-compatible request failed: HTTP 400 ${detail}`, 400);
    }
    if (!res.ok || !res.body) {
      throw new ProviderError(`OpenAI-compatible request failed: HTTP ${res.status} ${await safeText(res)}`, res.status);
    }

    const toolAcc = new Set<{ id: string; name: string; args: string }>();
    const toolsById = new Map<string, { id: string; name: string; args: string }>();
    const toolsByIndex = new Map<number, { id: string; name: string; args: string }>();
    const ambiguousIndices = new Set<number>();
    let flushed = false;
    // finish_reason "length": the server stopped at max_tokens or the context window.
    let cutOff = false;
    // The message field reasoning streamed in, so it can be sent back the same way.
    let reasoningField: "reasoning" | "reasoning_content" | undefined;
    const flush = (): ProviderStreamEvent[] => {
      if (flushed) return [];
      flushed = true;
      const events: ProviderStreamEvent[] = [];
      if (cutOff) events.push({ type: "output-limit" });
      if (reasoningField) events.push({ type: "reasoning-replay", field: reasoningField });
      for (const tc of toolAcc.values()) {
        if (tc.name) {
          events.push({
            type: "tool-call",
            toolCall: { id: tc.id || randomUUID(), name: tc.name, arguments: tc.args || "{}" },
          });
        }
      }
      return events;
    };

    for await (const data of readSSE(res.body, signal)) {
      if (data === "[DONE]") {
        yield* flush();
        return;
      }
      let json: OAStreamChunk;
      try {
        json = JSON.parse(data) as OAStreamChunk;
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        reasoningField ??= delta?.reasoning ? "reasoning" : "reasoning_content";
        yield { type: "reasoning-delta", text: reasoning };
      }
      if (delta?.content) yield { type: "text-delta", text: delta.content };
      if (delta?.tool_calls) {
        for (const d of delta.tool_calls) {
          const idx = d.index ?? 0;
          const indexed = toolsByIndex.get(idx);
          if (!d.id && ambiguousIndices.has(idx)) {
            throw new ProviderError("Ambiguous tool-call fragment: reused index requires a call ID");
          }
          if (d.id && indexed?.id && indexed.id !== d.id) ambiguousIndices.add(idx);
          const cur = (d.id
            ? toolsById.get(d.id) ?? (indexed?.id ? undefined : indexed)
            : indexed) ?? { id: "", name: "", args: "" };
          if (d.id) {
            cur.id = d.id;
            toolsById.set(d.id, cur);
          }
          if (d.function?.name && !cur.name) yield { type: "tool-call-start", name: d.function.name };
          if (d.function?.name) cur.name = d.function.name;
          if (d.function?.arguments) cur.args += d.function.arguments;
          toolsByIndex.set(idx, cur);
          toolAcc.add(cur);
        }
      }
      if (json.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            ...(json.usage.prompt_tokens_details?.cached_tokens ? { cachedInputTokens: json.usage.prompt_tokens_details.cached_tokens } : {}),
          },
        };
      }
      if (choice?.finish_reason === "length") cutOff = true;
      if (choice?.finish_reason === "tool_calls") yield* flush();
    }
    yield* flush();
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(joinUrl(this.baseUrl, "/models"), {
      headers: { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    });
    if (!res.ok) throw new Error(`List models failed: HTTP ${res.status} ${await safeText(res)}`);
    const json = (await res.json()) as OpenAiModelList;
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  }
}
