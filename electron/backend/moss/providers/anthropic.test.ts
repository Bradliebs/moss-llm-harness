// electron/backend/moss/providers/anthropic.test.ts
//
// Unit tests for the native Anthropic provider. Global fetch is stubbed to hand
// back canned Anthropic SSE bodies and model lists, so these exercise the
// provider's own logic: message/system mapping into the request body, streaming
// text deltas, accumulating streamed tool_use blocks, usage, error events, HTTP
// failures, and the listModels static fallback.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRequest, ProviderStreamEvent } from "./types";
import { AnthropicProvider, DEFAULT_MAX_OUTPUT_TOKENS, modelOutputLimit, toAnthropic } from "./anthropic";

/** Minimal stand-in for the fetch Response body's ReadableStream: hands back the
 *  whole SSE payload as a single chunk, then signals done. */
function bodyFrom(sse: string) {
  const chunk = new TextEncoder().encode(sse);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: chunk };
        },
        releaseLock() {
          /* no-op */
        },
      };
    },
  };
}

/** Stub global fetch with a canned SSE stream; returns the mock for arg inspection. */
function stubStream(sse: string, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  const fetchMock = vi.fn(async () => ({
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    body: ok ? bodyFrom(sse) : undefined,
    text: async () => sse,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Build an Anthropic SSE payload (no [DONE] terminator, unlike OpenAI). */
function sse(...events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const req: ChatRequest = { model: "claude", messages: [{ role: "user", content: "hi" }] };

async function collect(provider: AnthropicProvider): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const e of provider.streamChat(req, new AbortController().signal)) events.push(e);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicProvider.streamChat", () => {
  it("emits text-delta events for text_delta blocks", async () => {
    stubStream(
      sse(
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 0 },
      ),
    );
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
    ]);
  });

  it("accumulates a streamed tool_use block and flushes it on content_block_stop", async () => {
    stubStream(
      sse(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu1", name: "do_thing" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
        { type: "content_block_stop", index: 0 },
      ),
    );
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "tu1", name: "do_thing", arguments: '{"a":1}' } },
    ]);
  });

  it("defaults empty tool_use input to {} and generates an id when none is given", async () => {
    stubStream(
      sse(
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "noargs" } },
        { type: "content_block_stop", index: 0 },
      ),
    );
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe("tool-call");
    if (ev.type === "tool-call") {
      expect(ev.toolCall.name).toBe("noargs");
      expect(ev.toolCall.arguments).toBe("{}");
      expect(ev.toolCall.id).toBeTruthy();
    }
  });

  it("maps message_delta usage to a usage event", async () => {
    stubStream(sse({ type: "message_delta", usage: { output_tokens: 42 } }));
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events).toEqual([{ type: "usage", usage: { outputTokens: 42 } }]);
  });

  it("sums fresh, cache-write and cache-read tokens from message_start into input usage", async () => {
    stubStream(
      sse({
        type: "message_start",
        message: {
          usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 },
        },
      }),
    );
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events).toEqual([{ type: "usage", usage: { inputTokens: 1005, cachedInputTokens: 900 } }]);
  });

  it("throws when the stream carries an error event", async () => {
    stubStream(sse({ type: "error", error: { message: "boom" } }));
    await expect(collect(new AnthropicProvider("https://api"))).rejects.toThrow(/boom/);
  });

  it("throws on a non-ok HTTP response", async () => {
    stubStream("", { ok: false, status: 503 });
    await expect(collect(new AnthropicProvider("https://api"))).rejects.toThrow(/HTTP 503/);
  });

  it("extracts system text and maps tools into the request body", async () => {
    const fetchMock = stubStream(sse({ type: "content_block_stop", index: 0 }));
    const withSystem: ChatRequest = {
      model: "claude",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "do_thing", description: "does a thing", parameters: { type: "object" } }],
    };
    const events: ProviderStreamEvent[] = [];
    for await (const e of new AnthropicProvider("https://api", "key").streamChat(
      withSystem,
      new AbortController().signal,
    )) {
      events.push(e);
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.system).toEqual([
      { type: "text", text: "be nice", cache_control: { type: "ephemeral" } },
    ]);
    // The only user message carries this turn's context, so it is not cached.
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
    expect(body.tools).toEqual([
      {
        name: "do_thing",
        description: "does a thing",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("puts the tools cache breakpoint only on the last tool", async () => {
    const fetchMock = stubStream(sse({ type: "content_block_stop", index: 0 }));
    const withTools: ChatRequest = {
      model: "claude",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "first", description: "a", parameters: { type: "object" } },
        { name: "second", description: "b", parameters: { type: "object" } },
      ],
    };
    for await (const _ of new AnthropicProvider("https://api", "key").streamChat(
      withTools,
      new AbortController().signal,
    )) {
      /* drain */
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("caches the history before the latest user message, not the message itself", async () => {
    const fetchMock = stubStream(sse({ type: "content_block_stop", index: 0 }));
    const request: ChatRequest = {
      model: "claude",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second <turn_context>x</turn_context>" },
      ],
    };
    for await (const _ of new AnthropicProvider("https://api", "key").streamChat(request, new AbortController().signal)) {
      /* drain */
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "reply", cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(body.messages[2])).not.toContain("cache_control");
  });

  it("marks the last block of a multi-block final message instead of replacing it", async () => {
    const fetchMock = stubStream(sse({ type: "content_block_stop", index: 0 }));
    const withToolResult: ChatRequest = {
      model: "claude",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "tu1", name: "do_thing", arguments: "{}" }] },
        { role: "tool", content: "done", toolCallId: "tu1" },
      ],
    };
    for await (const _ of new AnthropicProvider("https://api", "key").streamChat(
      withToolResult,
      new AbortController().signal,
    )) {
      /* drain */
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const last = body.messages[body.messages.length - 1];
    expect(last.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu1",
        content: "done",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("allows long replies by default and says when a reply stopped at the limit", async () => {
    const fetchMock = stubStream(sse(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"game.html","content":"<html>' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32000 } },
    ));
    const events = await collect(new AnthropicProvider("https://api"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(events.at(-1)).toEqual({ type: "output-limit" });
  });

  it("asks again with the model's own output limit when the default is too large, and remembers it", async () => {
    const tooLarge = "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022";
    const ok = () => ({ ok: true, status: 200, body: bodyFrom(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })), text: async () => "" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, body: undefined, text: async () => JSON.stringify({ error: { message: tooLarge } }) })
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider("https://api");
    const small: ChatRequest = { ...req, model: "claude-small-output" };
    const drain = async (): Promise<ProviderStreamEvent[]> => {
      const events: ProviderStreamEvent[] = [];
      for await (const e of provider.streamChat(small, new AbortController().signal)) events.push(e);
      return events;
    };
    expect(await drain()).toEqual([{ type: "text-delta", text: "ok" }]);
    await drain();
    // The next turn starts at the limit that worked: no second rejected request.
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).max_tokens)).toEqual([32000, 8192, 8192]);
  });

  it("steps down when a compatible server rejects max_tokens without naming its limit", async () => {
    const vague = { ok: false, status: 400, body: undefined, text: async () => "Invalid max_tokens value" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(vague)
      .mockResolvedValueOnce(vague)
      .mockResolvedValueOnce({ ok: true, status: 200, body: bodyFrom(sse()), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of new AnthropicProvider("https://compatible").streamChat({ ...req, model: "vague-model" }, new AbortController().signal)) { /* drain */ }
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).max_tokens)).toEqual([32000, 16000, 8192]);
  });

  it("passes on a tool call cut off by the limit even without content_block_stop", async () => {
    stubStream(sse(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu9", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"game.html","content":"<html>' } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32000 } },
    ));
    const events = await collect(new AnthropicProvider("https://api"));
    expect(events.filter((event) => event.type !== "usage")).toEqual([
      { type: "tool-call", toolCall: { id: "tu9", name: "write_file", arguments: '{"path":"game.html","content":"<html>' } },
      { type: "output-limit" },
    ]);
  });

  it("does not retry other bad requests", async () => {
    stubStream("model: not found", { ok: false, status: 400 });
    await expect(collect(new AnthropicProvider("https://api"))).rejects.toThrow(/HTTP 400 model: not found/);
  });

  it("sends no thinking field unless a reasoning setting asks for one", async () => {
    const fetchMock = stubStream(sse());
    await collect(new AnthropicProvider("https://api"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).not.toHaveProperty("thinking");
  });

  it("asks for summarized adaptive thinking when extended, without a temperature, and hands back the signed block", async () => {
    const fetchMock = stubStream(sse(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Read the file " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "read_file" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
      { type: "content_block_stop", index: 2 },
    ));
    const events: ProviderStreamEvent[] = [];
    for await (const e of new AnthropicProvider("https://api").streamChat({ ...req, model: "claude-adaptive", reasoning: "high", temperature: 0.2 }, new AbortController().signal)) events.push(e);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body).not.toHaveProperty("temperature");
    expect(events).toEqual([
      { type: "reasoning-delta", text: "Read the file " },
      { type: "reasoning-delta", text: "first." },
      { type: "reasoning-replay", blocks: [{ type: "thinking", thinking: "Read the file first.", signature: "sig-1" }] },
      { type: "reasoning-replay", blocks: [{ type: "redacted_thinking", data: "opaque" }] },
      { type: "tool-call", toolCall: { id: "tu1", name: "read_file", arguments: '{"path":"a"}' } },
    ]);
  });

  it("falls back to a thinking budget, then to no thinking field, and remembers what worked", async () => {
    const rejected = (message: string) => ({ ok: false, status: 400, body: undefined, text: async () => JSON.stringify({ error: { message } }) });
    const ok = () => ({ ok: true, status: 200, body: bodyFrom(sse()), text: async () => "" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected("thinking.type: Input tag 'adaptive' does not match any of the expected tags"))
      .mockResolvedValueOnce(rejected("thinking: this model does not support extended thinking"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider("https://api");
    const old: ChatRequest = { ...req, model: "claude-no-thinking", reasoning: "high" };
    for (let i = 0; i < 2; i++) for await (const _ of provider.streamChat(old, new AbortController().signal)) { /* drain */ }
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).thinking)).toEqual([
      { type: "adaptive", display: "summarized" },
      { type: "enabled", budget_tokens: 16000 },
      undefined,
      undefined,
    ]);
  });

  it("keeps a manual thinking budget below a small output limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, body: undefined, text: async () => "\"thinking.type.adaptive\" is not supported" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: bodyFrom(sse()), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of new AnthropicProvider("https://api").streamChat({ ...req, model: "claude-budget", reasoning: "high", maxTokens: 4096 }, new AbortController().signal)) { /* drain */ }
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("turns thinking off with disabled, omitting the field where a model rejects that", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, body: undefined, text: async () => "\"thinking.type.disabled\" is not supported for this model" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: bodyFrom(sse()), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of new AnthropicProvider("https://api").streamChat({ ...req, model: "claude-always-thinks", reasoning: "none" }, new AbortController().signal)) { /* drain */ }
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).thinking)).toEqual([{ type: "disabled" }, undefined]);
  });
});

describe("modelOutputLimit", () => {
  it("reads the limit only from a max_tokens error", () => {
    expect(modelOutputLimit("max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for x")).toBe(8192);
    expect(modelOutputLimit("max_tokens must be at most 4096 (the maximum for this model)")).toBe(4096);
    expect(modelOutputLimit("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]")).toBe(8192);
    expect(modelOutputLimit("messages: roles must alternate")).toBeUndefined();
    expect(modelOutputLimit("max_tokens: 32000 > 64000")).toBeUndefined();
  });
});

describe("AnthropicProvider.listModels", () => {
  it("returns ids from the API when the response is ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "claude-a" }, { id: "" }, { id: "claude-b" }] }),
      })),
    );
    const ids = await new AnthropicProvider("https://api").listModels();
    expect(ids).toEqual(["claude-a", "claude-b"]);
  });

  it("falls back to the static model list on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const ids = await new AnthropicProvider("https://api").listModels();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("claude"))).toBe(true);
  });

  it("falls back to DeepSeek's own models on its endpoint, which rejects other names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await new AnthropicProvider("https://api.deepseek.com/anthropic").listModels()).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(await new AnthropicProvider("https://notdeepseek.com.example/anthropic").listModels()).not.toContain("deepseek-flash");
  });
});

describe("toAnthropic", () => {
  it("sends thinking blocks back first, unchanged, only to the model that wrote them on a tool round", () => {
    const blocks = [{ type: "thinking", thinking: "plan", signature: "sig" }, { type: "redacted_thinking", data: "x" }];
    const history = [
      { role: "user" as const, content: "go" },
      { role: "assistant" as const, content: "Reading.", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }], reasoningReplay: { model: "claude-a", blocks } },
      { role: "tool" as const, toolCallId: "t1", content: "data" },
    ];
    expect(toAnthropic(history, "claude-a").messages[1].content).toEqual([
      ...blocks,
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "t1", name: "read_file", input: {} },
    ]);
    expect((toAnthropic(history, "claude-b").messages[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "tool_use"]);
    expect((toAnthropic(history).messages[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "tool_use"]);
  });

  it("puts tool-result images in the same user message as the tool result", () => {
    const { messages } = toAnthropic([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "view_image", arguments: "{}" }] },
      { role: "tool", content: "Viewing shot.png", toolCallId: "c1", images: ["data:image/png;base64,AAAA"] },
    ]);
    // Two consecutive user messages would be rejected by the API, so the image
    // must be a sibling block rather than a message of its own.
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "Viewing shot.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("converts a user message with images into text and image blocks", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "describe", images: ["data:image/jpeg;base64,ZZZZ"] },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZZ" } },
        ],
      },
    ]);
  });

  it("expands structured document attachments into text blocks", () => {
    const { messages } = toAnthropic([
      {
        role: "user",
        content: "summarize",
        documents: [{ name: "notes.md", mediaType: "text/markdown", text: "# Notes" }],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "text",
            text: "--- BEGIN ATTACHED FILE: notes.md (text/markdown) ---\n# Notes\n--- END ATTACHED FILE: notes.md ---",
          },
        ],
      },
    ]);
  });

  it("keeps a plain string for a user message with no images", () => {
    const { messages } = toAnthropic([{ role: "user", content: "hi" }]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
