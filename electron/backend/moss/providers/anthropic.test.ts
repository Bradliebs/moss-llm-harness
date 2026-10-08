// electron/backend/moss/providers/anthropic.test.ts
//
// Unit tests for the native Anthropic provider. Global fetch is stubbed to hand
// back canned Anthropic SSE bodies and model lists, so these exercise the
// provider's own logic: message/system mapping into the request body, streaming
// text deltas, accumulating streamed tool_use blocks, usage, error events, HTTP
// failures, and the listModels static fallback.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRequest, ProviderStreamEvent } from "./types";
import { AnthropicProvider, toAnthropic } from "./anthropic";

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
});

describe("toAnthropic", () => {
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
