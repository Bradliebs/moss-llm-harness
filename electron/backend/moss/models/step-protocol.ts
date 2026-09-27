// electron/backend/moss/models/step-protocol.ts
//
// Constrained step protocol for models that cannot use native tool calling
// reliably. Instead of advertising tools, each request carries a JSON schema
// whose branches are "call exactly this tool with arguments matching its
// schema" or "give the final answer". The server enforces the schema with
// grammar-constrained decoding, so every response is a valid tool call or a
// final answer. The decorator translates steps back into ordinary provider
// events, so the agent loop is unchanged.

import { randomUUID } from "node:crypto";

import type { AgentMessage, ToolDefinition } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { parseTextToolCalls } from "./tool-repair";

export function buildStepSchema(tools: readonly ToolDefinition[]): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: "object",
        properties: { action: { const: "final" }, answer: { type: "string" } },
        required: ["action", "answer"],
      },
      ...tools.map((tool) => ({
        type: "object",
        properties: {
          action: { const: "tool" },
          tool: { const: tool.name },
          arguments: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object" },
        },
        required: ["action", "tool", "arguments"],
      })),
    ],
  };
}

export function stepInstructions(tools: readonly ToolDefinition[]): string {
  return [
    "Response protocol: reply with exactly one JSON object and nothing else.",
    '- To use a tool: {"action":"tool","tool":"<name>","arguments":{...}} with arguments matching that tool\'s parameters.',
    '- To finish: {"action":"final","answer":"<your complete reply to the user, in Markdown>"}.',
    "Use one tool per response. After each tool result, decide the next step. Give the final answer only when the task is done or you need the user.",
    "Available tools:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description.split("\n")[0].slice(0, 200)} Parameters: ${JSON.stringify((tool.parameters as { properties?: unknown }).properties ?? {})}`),
  ].join("\n");
}

/** Rewrite native tool history into plain turns, since the request no longer
 *  advertises tools and some servers reject tool messages without them. */
export function toStepMessages(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      const call = message.toolCalls[0];
      names.set(call.id, call.name);
      let args: unknown;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      out.push({ role: "assistant", content: JSON.stringify({ action: "tool", tool: call.name, arguments: args }) });
      for (const extra of message.toolCalls.slice(1)) names.set(extra.id, extra.name);
    } else if (message.role === "tool") {
      const name = message.toolCallId ? names.get(message.toolCallId) : undefined;
      out.push({ role: "user", content: `Result of ${name ?? "the tool"}:\n${message.content}`, ...(message.images?.length ? { images: message.images } : {}) });
    } else {
      out.push(message);
    }
  }
  const instructions = stepInstructions(tools);
  const systemIndex = out.findIndex((message) => message.role === "system");
  if (systemIndex >= 0) out[systemIndex] = { ...out[systemIndex], content: `${out[systemIndex].content}\n\n${instructions}` };
  else out.unshift({ role: "system", content: instructions });
  // Adjacent same-role turns confuse some chat templates; merge them.
  return out.reduce<AgentMessage[]>((merged, message) => {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role && message.role === "user" && !last.images && !message.images) {
      merged[merged.length - 1] = { ...last, content: `${last.content}\n\n${message.content}` };
    } else merged.push(message);
    return merged;
  }, []);
}

export class StepProtocolProvider implements ChatProvider {
  readonly kind: string;

  constructor(private readonly inner: ChatProvider) {
    this.kind = inner.kind;
  }

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const tools = req.tools ?? [];
    // The final tool-free round and tool-less turns need no protocol.
    if (tools.length === 0) {
      yield* this.inner.streamChat(req, signal);
      return;
    }
    let text = "";
    for await (const event of this.inner.streamChat({
      model: req.model,
      messages: toStepMessages(req.messages, tools),
      responseSchema: buildStepSchema(tools),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }, signal)) {
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "usage") yield event;
      else if (event.type === "tool-call") yield event;
    }
    yield* interpretStep(text, tools);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }
}

export function* interpretStep(text: string, tools: readonly ToolDefinition[]): Iterable<ProviderStreamEvent> {
  let step: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
    if (value && typeof value === "object" && !Array.isArray(value)) step = value as Record<string, unknown>;
  } catch {
    step = undefined;
  }
  if (step?.action === "final" && typeof step.answer === "string") {
    yield { type: "text-delta", text: step.answer };
    return;
  }
  if (step?.action === "tool" && typeof step.tool === "string") {
    yield {
      type: "tool-call",
      toolCall: { id: `step-${randomUUID()}`, name: step.tool, arguments: JSON.stringify(step.arguments ?? {}) },
    };
    return;
  }
  // The server did not enforce the schema; salvage a call or show the text.
  const salvaged = parseTextToolCalls(text, tools);
  if (salvaged.length > 0) {
    yield { type: "tool-call", toolCall: salvaged[0] };
    return;
  }
  if (text.trim()) yield { type: "text-delta", text };
}
