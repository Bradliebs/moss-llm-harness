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

export interface VoteResult {
  samples: number;
  /** samples that agreed with the chosen step */
  agreeing: number;
  /** chosen tool name, or "final answer" */
  choice: string;
}

export interface StepProtocolOptions {
  /** constrained samples per step; the most common step wins. 1 disables voting */
  votes?: number;
  /** sampling temperature for voting, unless the request sets one */
  voteTemperature?: number;
  onVote?: (result: VoteResult) => void;
}

/** Stable identity of a step: the tool and its arguments with sorted keys. */
export function stepKey(events: readonly ProviderStreamEvent[]): string | undefined {
  const call = events.find((event) => event.type === "tool-call");
  if (call?.type === "tool-call") {
    const canonical = (value: unknown): unknown => Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
        : typeof value === "string" ? value.trim() : value;
    let args: unknown;
    try {
      args = JSON.parse(call.toolCall.arguments || "{}");
    } catch {
      args = call.toolCall.arguments;
    }
    return `tool:${call.toolCall.name}:${JSON.stringify(canonical(args))}`;
  }
  return events.some((event) => event.type === "text-delta") ? "final" : undefined;
}

export class StepProtocolProvider implements ChatProvider {
  readonly kind: string;

  constructor(private readonly inner: ChatProvider, private readonly options: StepProtocolOptions = {}) {
    this.kind = inner.kind;
  }

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const tools = req.tools ?? [];
    // The final tool-free round and tool-less turns need no protocol.
    if (tools.length === 0) {
      yield* this.inner.streamChat(req, signal);
      return;
    }
    const votes = Math.max(1, Math.min(5, Math.floor(this.options.votes ?? 1)));
    const temperature = req.temperature ?? (votes > 1 ? this.options.voteTemperature ?? 0.6 : undefined);
    const stepRequest: ChatRequest = {
      model: req.model,
      messages: toStepMessages(req.messages, tools),
      responseSchema: buildStepSchema(tools),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    const sample = async (): Promise<{ events: ProviderStreamEvent[]; usage: ProviderStreamEvent[] }> => {
      let text = "";
      const usage: ProviderStreamEvent[] = [];
      const native: ProviderStreamEvent[] = [];
      for await (const event of this.inner.streamChat(stepRequest, signal)) {
        if (event.type === "text-delta") text += event.text;
        else if (event.type === "usage") usage.push(event);
        else if (event.type === "tool-call") native.push(event);
      }
      return { events: native.length > 0 ? native : [...interpretStep(text, tools)], usage };
    };
    if (votes === 1) {
      const only = await sample();
      yield* only.usage;
      yield* only.events;
      return;
    }
    // Samples run one after another: local servers usually serve a single
    // request at a time, and an early abort then skips the rest.
    const results: Array<{ events: ProviderStreamEvent[]; usage: ProviderStreamEvent[] }> = [];
    for (let index = 0; index < votes; index++) {
      signal.throwIfAborted();
      results.push(await sample());
    }
    for (const result of results) yield* result.usage;
    const tally = new Map<string, number>();
    for (const result of results) {
      const key = stepKey(result.events);
      if (key) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    // Most common step; ties go to the earliest sample.
    const best = results.reduce<{ index: number; count: number }>((winner, result, index) => {
      const count = tally.get(stepKey(result.events) ?? "") ?? 0;
      return count > winner.count ? { index, count } : winner;
    }, { index: 0, count: 0 });
    const chosen = results[best.index].events;
    const call = chosen.find((event) => event.type === "tool-call");
    this.options.onVote?.({ samples: votes, agreeing: best.count, choice: call?.type === "tool-call" ? call.toolCall.name : "final answer" });
    yield* chosen;
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
