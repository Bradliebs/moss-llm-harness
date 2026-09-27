import { describe, expect, it, vi } from "vitest";

import type { AgentMessage, ToolDefinition } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { buildStepSchema, interpretStep, StepProtocolProvider, stepKey, toStepMessages } from "./step-protocol";

const READ: ToolDefinition = {
  name: "read_file",
  description: "Read a file.\nMore detail.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function fakeProvider(reply: ProviderStreamEvent[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    kind: "openai-compatible",
    requests,
    async *streamChat(req) {
      requests.push(req);
      yield* reply;
    },
    async listModels() { return ["m"]; },
  };
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("buildStepSchema", () => {
  it("offers a final answer or exactly one call per tool with its own argument schema", () => {
    const schema = buildStepSchema([READ]) as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> };
    expect(schema.anyOf).toHaveLength(2);
    expect(schema.anyOf[0].properties.action).toEqual({ const: "final" });
    expect(schema.anyOf[1].properties).toEqual({ action: { const: "tool" }, tool: { const: "read_file" }, arguments: READ.parameters });
    expect(schema.anyOf[1].required).toEqual(["action", "tool", "arguments"]);
  });
});

describe("toStepMessages", () => {
  it("rewrites native tool history as plain turns and adds the protocol to the system prompt", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Read a.md" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"a.md\"}" }] },
      { role: "tool", toolCallId: "c1", content: "hello" },
      { role: "user", content: "And then?" },
    ];
    const out = toStepMessages(messages, [READ]);
    expect(out[0].content).toMatch(/^Be helpful\.\n\nResponse protocol/);
    expect(out[0].content).toContain("- read_file: Read a file. Parameters: {\"path\":{\"type\":\"string\"}}");
    expect(out[2]).toEqual({ role: "assistant", content: "{\"action\":\"tool\",\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.md\"}}" });
    // The tool result and the next user message merge into one user turn.
    expect(out[3]).toEqual({ role: "user", content: "Result of read_file:\nhello\n\nAnd then?" });
    expect(out.some((message) => message.role === "tool")).toBe(false);
  });

  it("adds a system message when the conversation has none", () => {
    expect(toStepMessages([{ role: "user", content: "hi" }], [READ])[0].role).toBe("system");
  });
});

describe("interpretStep", () => {
  it("turns steps into tool calls or answer text", () => {
    const [toolEvent] = [...interpretStep('{"arguments":{"path":"a.md"},"tool":"read_file","action":"tool"}', [READ])];
    expect(toolEvent).toMatchObject({ type: "tool-call", toolCall: { name: "read_file", arguments: "{\"path\":\"a.md\"}" } });
    expect([...interpretStep('<think>hmm</think>{"action":"final","answer":"Done."}', [READ])]).toEqual([{ type: "text-delta", text: "Done." }]);
  });

  it("salvages a text call or passes through plain text when the schema was not enforced", () => {
    expect([...interpretStep('<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>', [READ])][0]).toMatchObject({ type: "tool-call", toolCall: { name: "read_file" } });
    expect([...interpretStep("Just words.", [READ])]).toEqual([{ type: "text-delta", text: "Just words." }]);
    expect([...interpretStep("  ", [READ])]).toEqual([]);
  });
});

describe("StepProtocolProvider", () => {
  it("sends a response schema instead of native tools and yields the step as a tool call", async () => {
    const inner = fakeProvider([
      { type: "text-delta", text: "{\"action\":\"tool\"," },
      { type: "text-delta", text: "\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.md\"}}" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
    const events = await collect(new StepProtocolProvider(inner).streamChat({ model: "m", messages: [{ role: "user", content: "read" }], tools: [READ], maxTokens: 100 }, new AbortController().signal));
    expect(inner.requests[0].tools).toBeUndefined();
    expect(inner.requests[0].responseSchema).toEqual(buildStepSchema([READ]));
    expect(inner.requests[0].maxTokens).toBe(100);
    expect(events.map((event) => event.type)).toEqual(["usage", "tool-call"]);
  });

  it("passes tool-free requests straight through", async () => {
    const inner = fakeProvider([{ type: "text-delta", text: "hi" }]);
    const request: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(await collect(new StepProtocolProvider(inner).streamChat(request, new AbortController().signal))).toEqual([{ type: "text-delta", text: "hi" }]);
    expect(inner.requests[0]).toBe(request);
  });
});


describe("voting on constrained steps", () => {
  function sequenced(replies: string[]): ChatProvider & { requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    let index = 0;
    return {
      kind: "openai-compatible",
      requests,
      async *streamChat(req) {
        requests.push(req);
        yield { type: "text-delta", text: replies[index++ % replies.length] };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
      },
      async listModels() { return []; },
    };
  }
  const ask = (provider: ChatProvider) => collect(provider.streamChat({ model: "m", messages: [{ role: "user", content: "read" }], tools: [READ] }, new AbortController().signal));

  it("runs the most common step and reports the agreement", async () => {
    const inner = sequenced([
      '{"action":"tool","tool":"read_file","arguments":{"path":"b.md"}}',
      '{"action":"tool","tool":"read_file","arguments":{"path":" a.md"}}',
      '{"arguments":{"path":"a.md"},"tool":"read_file","action":"tool"}',
    ]);
    const onVote = vi.fn();
    const events = await ask(new StepProtocolProvider(inner, { votes: 3, onVote }));
    expect(inner.requests).toHaveLength(3);
    expect(inner.requests.every((req) => req.temperature === 0.6)).toBe(true);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({ toolCall: { arguments: "{\"path\":\" a.md\"}" } });
    expect(onVote).toHaveBeenCalledWith({ samples: 3, agreeing: 2, choice: "read_file" });
  });

  it("breaks ties toward the earliest sample and lets a majority finish", async () => {
    const tie = sequenced(['{"action":"final","answer":"First."}', '{"action":"tool","tool":"read_file","arguments":{"path":"x"}}']);
    expect((await ask(new StepProtocolProvider(tie, { votes: 2 }))).filter((event) => event.type === "text-delta")).toEqual([{ type: "text-delta", text: "First." }]);
    expect(stepKey([{ type: "text-delta", text: "a" }])).toBe("final");
    expect(stepKey([])).toBeUndefined();
  });

  it("keeps a single sample at the request temperature", async () => {
    const inner = sequenced(['{"action":"final","answer":"ok"}']);
    await ask(new StepProtocolProvider(inner, { votes: 1 }));
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0].temperature).toBeUndefined();
  });
});