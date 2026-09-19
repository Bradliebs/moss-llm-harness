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
    delta?: { content?: string; tool_calls?: OAToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiModelList {
  data?: Array<{ id?: string }>;
}

export function toOpenAiMessages(messages: AgentMessage[]): unknown[] {
  // flatMap, not map: a tool result carrying images expands into two messages.
  return messages.flatMap((m): unknown[] => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return [
        {
          role: "assistant",
          content: m.content || null,
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
    const tools =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    const res = await fetch(joinUrl(this.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAiMessages(req.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(this.options.reasoningEffort !== undefined ? { reasoning_effort: this.options.reasoningEffort } : {}),
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ProviderError(`OpenAI-compatible request failed: HTTP ${res.status} ${await safeText(res)}`, res.status);
    }

    const toolAcc = new Set<{ id: string; name: string; args: string }>();
    const toolsById = new Map<string, { id: string; name: string; args: string }>();
    const toolsByIndex = new Map<number, { id: string; name: string; args: string }>();
    const ambiguousIndices = new Set<number>();
    let flushed = false;
    const flush = (): ProviderStreamEvent[] => {
      if (flushed) return [];
      flushed = true;
      const events: ProviderStreamEvent[] = [];
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
          if (d.function?.name) cur.name = d.function.name;
          if (d.function?.arguments) cur.args += d.function.arguments;
          toolsByIndex.set(idx, cur);
          toolAcc.add(cur);
        }
      }
      if (json.usage) {
        yield {
          type: "usage",
          usage: { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens },
        };
      }
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
