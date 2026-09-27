// Scaffolding and routing hooks in the turn loop: the per-round tool call cap
// and the auxiliary model used for read-only subagents.

import { describe, expect, it } from "vitest";

import type { MossEvent, ToolDefinition } from "../../../common/types";
import { runTurn } from "./agent-runner";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./providers/types";
import type { Tool } from "./tools";
import { delegateTool } from "./tools/delegate-tool";

function scripted(rounds: ProviderStreamEvent[][], requests: ChatRequest[]): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const event of events) yield event;
    },
    listModels: async () => [],
  };
}

const readTool: Tool = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  execute: async (args) => ({ ok: true, content: `contents of ${String(args.path)}` }),
};

describe("runTurn scaffolding hooks", () => {
  it("runs only the first tool call per round when capped and tells the model", async () => {
    const requests: ChatRequest[] = [];
    const events: MossEvent[] = [];
    const provider = scripted([
      [
        { type: "tool-call", toolCall: { id: "a", name: "read_file", arguments: "{\"path\":\"a.txt\"}" } },
        { type: "tool-call", toolCall: { id: "b", name: "read_file", arguments: "{\"path\":\"b.txt\"}" } },
      ],
      [{ type: "text-delta", text: "done" }],
    ], requests);
    const tools: ToolDefinition[] = [{ name: readTool.name, description: readTool.description, parameters: readTool.parameters }];
    await runTurn({
      provider,
      model: "small",
      messages: [{ role: "user", content: "read both" }],
      tools,
      toolRegistry: new Map([[readTool.name, readTool]]),
      workspaceRoot: "/work",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
      maxToolCallsPerRound: 1,
    });
    expect(events.filter((event) => event.type === "tool-result").map((event) => (event as { callId: string }).callId)).toEqual(["a"]);
    const secondRound = requests[1].messages;
    const assistant = secondRound.find((message) => message.role === "assistant");
    expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(["a"]);
    expect(secondRound.at(-1)?.content).toMatch(/skipped 1 more/);
    expect(events.some((event) => event.type === "notice" && /Skipped 1 extra tool call/.test(event.message))).toBe(true);
    const complete = events.find((event) => event.type === "turn-complete") as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("sends read-only subagents to the auxiliary model", async () => {
    const requests: ChatRequest[] = [];
    const provider = scripted([
      [{ type: "tool-call", toolCall: { id: "d", name: "delegate", arguments: "{\"task\":\"summarize the repo\"}" } }],
      [{ type: "text-delta", text: "report" }],
      [{ type: "text-delta", text: "final" }],
    ], requests);
    const registry = new Map<string, Tool>([[readTool.name, readTool], [delegateTool.name, delegateTool]]);
    await runTurn({
      provider,
      model: "small",
      auxiliaryModel: "fast",
      messages: [{ role: "user", content: "delegate it" }],
      tools: [...registry.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      toolRegistry: registry,
      workspaceRoot: "/work",
      signal: new AbortController().signal,
      onEvent: () => undefined,
      requestApproval: async () => ({ approved: true }),
      autoApprove: true,
    });
    expect(requests.map((request) => request.model)).toEqual(["small", "fast", "small"]);
  });
});
