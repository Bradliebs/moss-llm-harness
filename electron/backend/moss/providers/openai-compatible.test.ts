// electron/backend/moss/providers/openai-compatible.test.ts
//
// Unit tests for the OpenAI-compatible provider. Global fetch is stubbed to
// return canned SSE bodies and model lists, so these exercise the provider's own
// logic: streaming text deltas, accumulating streamed tool calls, flushing on
// finish_reason / [DONE], surfacing usage, and HTTP error handling.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRequest } from "./types";
import { OpenAiCompatibleProvider, toOpenAiMessages } from "./openai-compatible";

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

function stubStream(sse: string, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: init?.status ?? (ok ? 200 : 500),
      body: ok ? bodyFrom(sse) : undefined,
      text: async () => sse,
    })),
  );
}

function sse(...chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

async function collect(provider: OpenAiCompatibleProvider) {
  const events = [];
  for await (const e of provider.streamChat(req, new AbortController().signal)) events.push(e);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleProvider.streamChat", () => {
  it("requests token usage in the streaming response", async () => {
    stubStream(sse());

    await collect(new OpenAiCompatibleProvider("http://x/v1"));

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("max_tokens");
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("reasoning_effort");
  });

  it("disables thinking only when the provider is explicitly configured to do so", async () => {
    stubStream(sse());
    const provider = new OpenAiCompatibleProvider("http://x/v1", undefined, { reasoningEffort: "none" });
    for await (const event of provider.streamChat({ ...req, maxTokens: 256 }, new AbortController().signal)) {
      expect(event).toBeUndefined();
    }

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ reasoning_effort: "none", max_tokens: 256 });
  });

  it("forwards the caller's output token limit to the API", async () => {
    stubStream(sse());
    const provider = new OpenAiCompatibleProvider("http://x/v1");
    const events = [];
    for await (const event of provider.streamChat({ ...req, maxTokens: 256 }, new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([]);
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 256 });
  });

  it("yields text deltas from streamed content", async () => {
    stubStream(
      sse(
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
    ]);
  });

  it("accumulates a streamed tool call and flushes on finish_reason", async () => {
    stubStream(
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "do_thing" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toEqual([
      { type: "tool-call", toolCall: { id: "t1", name: "do_thing", arguments: '{"a":1}' } },
    ]);
  });

  it("flushes accumulated tool calls on [DONE] when no finish_reason arrives", async () => {
    stubStream(
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "f", arguments: "{}" } }] } }] }),
    );
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "t9", name: "f", arguments: "{}" } },
    ]);
  });

  it("keeps distinct tool-call IDs separate when the server reuses an index", async () => {
    stubStream(sse(
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "first", function: { name: "check", arguments: '{"name":' } },
        { index: 0, id: "second", function: { name: "check", arguments: '{"name":"Notifications"}' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { arguments: '"Theme"}' } }] } }] },
    ));
    expect(await collect(new OpenAiCompatibleProvider("http://x/v1"))).toEqual([
      { type: "tool-call", toolCall: { id: "first", name: "check", arguments: '{"name":"Theme"}' } },
      { type: "tool-call", toolCall: { id: "second", name: "check", arguments: '{"name":"Notifications"}' } },
    ]);
  });

  it("rejects unidentified fragments after an index collision", async () => {
    stubStream(sse(
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "first", function: { name: "check", arguments: "{" } },
        { index: 0, id: "second", function: { name: "check", arguments: "{" } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
    ));
    await expect(collect(new OpenAiCompatibleProvider("http://x/v1"))).rejects.toThrow("Ambiguous tool-call fragment");
  });

  it("routes ID-free fragments by distinct indices", async () => {
    stubStream(sse(
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "first", function: { name: "check", arguments: '{"value":' } },
        { index: 1, id: "second", function: { name: "check", arguments: '{"value":' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: "2}" } },
        { index: 0, function: { arguments: "1}" } },
      ] } }] },
    ));
    expect(await collect(new OpenAiCompatibleProvider("http://x/v1"))).toEqual([
      { type: "tool-call", toolCall: { id: "first", name: "check", arguments: '{"value":1}' } },
      { type: "tool-call", toolCall: { id: "second", name: "check", arguments: '{"value":2}' } },
    ]);
  });

  it("retains fragments received before the call ID", async () => {
    stubStream(sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "check", arguments: '{"value":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { arguments: "1}" } }] } }] },
    ));
    expect(await collect(new OpenAiCompatibleProvider("http://x/v1"))).toEqual([
      { type: "tool-call", toolCall: { id: "first", name: "check", arguments: '{"value":1}' } },
    ]);
  });

  it("surfaces token usage", async () => {
    stubStream(sse({ usage: { prompt_tokens: 11, completion_tokens: 22 } }));
    const events = await collect(new OpenAiCompatibleProvider("http://x/v1"));
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 11, outputTokens: 22 } });
  });

  it("throws with the HTTP status on a failed response", async () => {
    stubStream("upstream boom", { ok: false, status: 503 });
    await expect(collect(new OpenAiCompatibleProvider("http://x/v1"))).rejects.toThrow(/HTTP 503/);
  });
});

describe("OpenAiCompatibleProvider.listModels", () => {
  it("returns model ids, dropping empty entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "a" }, { id: "" }, { id: "b" }, {}] }),
      })),
    );
    const models = await new OpenAiCompatibleProvider("http://x/v1").listModels();
    expect(models).toEqual(["a", "b"]);
  });

  it("throws on a failed model list request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "nope" })),
    );
    await expect(new OpenAiCompatibleProvider("http://x/v1").listModels()).rejects.toThrow(/HTTP 500/);
  });
});

describe("toOpenAiMessages", () => {
  it("follows a tool result carrying images with a user image message", () => {
    const out = toOpenAiMessages([
      { role: "tool", content: "Viewing shot.png", toolCallId: "c1", images: ["data:image/png;base64,AAAA"] },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "c1", content: "Viewing shot.png" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ]);
  });

  it("leaves a tool result with no images as a single message", () => {
    const out = toOpenAiMessages([{ role: "tool", content: "done", toolCallId: "c1" }]);
    expect(out).toEqual([{ role: "tool", tool_call_id: "c1", content: "done" }]);
  });

  it("emits a content-parts array for a user message with images", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "what is this?", images: ["data:image/png;base64,AAAA"] },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("expands structured document attachments only in the provider payload", () => {
    const message = {
      role: "user" as const,
      content: "summarize this",
      documents: [{ name: "notes.txt", mediaType: "text/plain", text: "private file body" }],
    };

    expect(toOpenAiMessages([message])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize this" },
          {
            type: "text",
            text: "--- BEGIN ATTACHED FILE: notes.txt (text/plain) ---\nprivate file body\n--- END ATTACHED FILE: notes.txt ---",
          },
        ],
      },
    ]);
    expect(message.content).toBe("summarize this");
  });

  it("keeps a plain string for a user message with no images", () => {
    expect(toOpenAiMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});
