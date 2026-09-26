// Scripted fake models for capability probe tests. Test-only; excluded from the build.

import type { AgentMessage } from "../../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../../providers/types";

export type Reply = { text?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; inputTokens?: number };

/** A scripted fake model: `respond` sees each request and returns a reply. */
export function scriptedProvider(respond: (req: ChatRequest) => Reply | Error): ChatProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let id = 0;
  return {
    kind: "fake",
    calls,
    async *streamChat(req: ChatRequest): AsyncIterable<ProviderStreamEvent> {
      calls.push(req);
      const reply = respond(req);
      if (reply instanceof Error) throw reply;
      if (reply.text) yield { type: "text-delta", text: reply.text };
      for (const call of reply.toolCalls ?? []) {
        yield { type: "tool-call", toolCall: { id: `call-${++id}`, name: call.name, arguments: JSON.stringify(call.arguments) } };
      }
      yield { type: "usage", usage: { inputTokens: reply.inputTokens ?? 50, outputTokens: 10 } };
    },
    async listModels() {
      return ["fake"];
    },
  };
}

export function lastUser(messages: AgentMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

/** Answers every probe correctly. */
export function idealReply(req: ChatRequest): Reply {
  const user = lastUser(req.messages);
  const system = req.messages.find((message) => message.role === "system")?.content ?? "";
  const tools = req.tools?.map((tool) => tool.name) ?? [];
  if (tools.includes("read_register")) {
    const count = Number(req.messages.find((message) => message.role === "user")?.content.match(/r1 through r(\d+)/)?.[1]);
    const results = req.messages.filter((message) => message.role === "tool").map((message) => Number(message.content));
    if (results.length < count) return { toolCalls: [{ name: "read_register", arguments: { name: `r${results.length + 1}` } }] };
    return { toolCalls: [{ name: "submit_answer", arguments: { value: results.reduce((sum, value) => sum + value, 0) } }] };
  }
  if (user.includes("vault passcode")) {
    return { text: user.match(/vault passcode is ([0-9A-Z-]+)\./)?.[1] ?? "unknown", inputTokens: Math.round(user.length / 4) };
  }
  if (tools.length === 1 && tools[0] === "get_weather") {
    const city = user.match(/Paris|Tokyo|Nairobi/)?.[0] ?? "Unknown";
    return { toolCalls: [{ name: "get_weather", arguments: { city, ...(/celsius/.test(user) ? { unit: "celsius" } : {}) } }] };
  }
  if (tools.includes("calculate")) {
    if (/multiplied/.test(user)) return { toolCalls: [{ name: "calculate", arguments: { expression: "1847 * 23" } }] };
    if (/config\.yaml/.test(user)) return { toolCalls: [{ name: "search_files", arguments: { pattern: "**/config.yaml" } }] };
    if (/README\.md/.test(user)) return { toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }] };
    if (/Email/.test(user)) return { toolCalls: [{ name: "send_email", arguments: { to: "alex@example.com", subject: "Standup", body: "Running ten minutes late." } }] };
    if (/word: ready/.test(user)) return { text: "ready" };
    return { text: "Paris" };
  }
  if (/Maya Chen/.test(user)) return { text: JSON.stringify({ name: "Maya Chen", age: 34, city: "Lisbon", languages: ["Portuguese", "Mandarin"] }) };
  if (/Order #5521/.test(user)) {
    return { text: JSON.stringify({ order_id: 5521, items: [{ item: "notebook", quantity: 3, unit_price: 4.5 }, { item: "pen", quantity: 2, unit_price: 1.25 }] }) };
  }
  if (/design review/.test(user)) return { text: JSON.stringify({ date: "2026-03-14", time: "09:30", room: "B12", attendees: ["Priya", "Tom"] }) };
  if (system.includes("<END>")) return { text: "Mars <END>" };
  if (/three fruits/.test(user)) return { text: "- apple\n- banana\n- cherry" };
  if (/lighthouse/.test(user)) return { text: "The lighthouse guided every ship safely home!" };
  if (/uppercase/.test(user)) return { text: "BLUE" };
  return { text: "ok" };
}

