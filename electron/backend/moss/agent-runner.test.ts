// electron/backend/moss/agent-runner.test.ts
//
// Unit tests for the agentic turn loop. A scripted ChatProvider feeds the runner
// canned stream events and a fake tool registry stands in for real tools, so the
// tests exercise the loop's own behavior: streaming, tool dispatch, permission
// gating, error isolation, abort handling, and the round cap.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage, MossEvent, TaskExecutionGrant, ToolDefinition } from "../../../common/types";
import { runTurn } from "./agent-runner";
import type { CompletionContext, CompletionDecision } from "./agent-runner";
import { ToolOutputStore } from "./context/tool-output-store";
import { ProviderError } from "./providers/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./providers/types";
import type { Tool, ToolResult } from "./tools";

/** Provider that replays one event array per round, clamping to the last entry
 *  so a single-round script can drive the round-cap test. */
function scriptedProvider(rounds: ProviderStreamEvent[][], requests?: ChatRequest[]): ChatProvider {
  let round = 0;
  return {
    kind: "test",
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      requests?.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const events = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const e of events) yield e;
    },
    async listModels() {
      return [];
    },
  };
}

function throwingProvider(message: string): ChatProvider {
  return {
    kind: "test",
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<ProviderStreamEvent> {
      throw new Error(message);
    },
    async listModels() {
      return [];
    },
  };
}

function tool(name: string, result: ToolResult | (() => Promise<ToolResult>), timeoutMs?: number): Tool {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute: typeof result === "function" ? result : async () => result,
  };
}

function call(id: string, name: string, args = "{}"): ProviderStreamEvent {
  return { type: "tool-call", toolCall: { id, name, arguments: args } };
}

interface Harness {
  events: MossEvent[];
  approvals: string[];
}

async function run(
  provider: ChatProvider,
  tools: Tool[],
  opts?: {
    approve?: boolean;
    aborted?: boolean;
    autoApprove?: boolean;
    executionGrant?: TaskExecutionGrant;
    stepCapabilities?: string[];
    toolTimeoutMs?: number;
    messages?: AgentMessage[];
    turnId?: string;
    checkpoint?: { record: (abs: string, rel: string) => Promise<void> };
    workspaceRoot?: string;
    verify?: { enabled: boolean; commands: string[]; maxCycles?: number };
    maxRounds?: number;
    contextLimit?: number;
    completionGuard?: (context: CompletionContext) => CompletionDecision;
    now?: () => Date;
    approvalComment?: string;
    toolOutputStore?: ToolOutputStore;
    toolCallGuard?: (call: { id: string; name: string; arguments: string }) => { allow: boolean; reason?: string };
  },
): Promise<Harness> {
  const events: MossEvent[] = [];
  const approvals: string[] = [];
  const registry = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const controller = new AbortController();
  if (opts?.aborted) controller.abort();

  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const messages: AgentMessage[] = opts?.messages ?? [{ role: "user", content: "hi" }];

  await runTurn({
    provider,
    model: "test-model",
    messages,
    tools: toolDefs,
    toolRegistry: registry,
    workspaceRoot: opts?.workspaceRoot ?? "/work",
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    requestApproval: async (id) => {
      approvals.push(id);
      return {
        approved: opts?.approve ?? true,
        ...(opts?.approvalComment ? { comment: opts.approvalComment } : {}),
      };
    },
    autoApprove: opts?.autoApprove ?? false,
    ...(opts?.executionGrant ? { executionGrant: opts.executionGrant } : {}),
    ...(opts?.stepCapabilities ? { stepCapabilities: opts.stepCapabilities } : {}),
    // Zero backoff keeps the failure tests instant; retry behavior is exercised
    // explicitly below.
    streamRetryBaseMs: 0,
    ...(opts?.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    ...(opts?.turnId !== undefined ? { turnId: opts.turnId } : {}),
    ...(opts?.checkpoint !== undefined ? { checkpoint: opts.checkpoint } : {}),
    ...(opts?.verify !== undefined ? { verify: opts.verify } : {}),
    ...(opts?.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts?.contextLimit !== undefined ? { contextLimit: opts.contextLimit } : {}),
    ...(opts?.completionGuard !== undefined ? { completionGuard: opts.completionGuard } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
    ...(opts?.toolOutputStore !== undefined ? { toolOutputStore: opts.toolOutputStore } : {}),
    ...(opts?.toolCallGuard !== undefined ? { toolCallGuard: opts.toolCallGuard } : {}),
  });

  return { events, approvals };
}

const TRACE_EVENT_TYPES = new Set<MossEvent["type"]>([
  "round-start",
  "round-end",
  "context-compaction",
  "verification",
  "recovery",
]);
const types = (h: Harness) => h.events.filter((event) => !TRACE_EVENT_TYPES.has(event.type)).map((event) => event.type);

describe("runTurn", () => {
  it("adds fresh runtime context and replaces a stale supplied date", async () => {
    const firstRequests: ChatRequest[] = [];
    await run(scriptedProvider([[]], firstRequests), [], { now: () => new Date(2026, 6, 14) });

    const firstSystem = firstRequests[0].messages.find((message) => message.role === "system");
    expect(firstSystem?.content).toContain("The current local date is 2026-07-14");

    const nextRequests: ChatRequest[] = [];
    await run(scriptedProvider([[]], nextRequests), [], {
      messages: firstRequests[0].messages,
      now: () => new Date(2026, 6, 15),
    });

    const nextSystem = nextRequests[0].messages.find((message) => message.role === "system");
    expect(nextSystem?.content).toContain("The current local date is 2026-07-15");
    expect(nextSystem?.content).not.toContain("2026-07-14");
    expect(nextSystem?.content.match(/<runtime_context/g)).toHaveLength(1);
  });

  it("streams text and completes when no tools are called", async () => {
    const provider = scriptedProvider([
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
      ],
    ]);
    const h = await run(provider, []);

    expect(types(h)).toEqual(["text-delta", "text-delta", "turn-complete"]);
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages).toEqual([{ role: "assistant", content: "Hello world" }]);
  });

  it("retries an empty provider response instead of completing silently", async () => {
    const requests: ChatRequest[] = [];
    const provider = scriptedProvider([[], [{ type: "text-delta", text: "Finished" }]], requests);

    const result = await run(provider, []);

    expect(requests).toHaveLength(2);
    expect(result.events.filter((event) => event.type === "turn-complete")).toHaveLength(1);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "round-end", round: 0, finish: "rejected" }));
  });

  it.each([
    { events: [] },
    { events: [{ type: "text-delta" as const, text: "  \n" }] },
  ])("bounds empty-response recovery and reports provider failure", async ({ events }) => {
    const requests: ChatRequest[] = [];
    const result = await run(scriptedProvider([events], requests), []);

    expect(requests).toHaveLength(2);
    expect(result.events.some((event) => event.type === "turn-complete")).toBe(false);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "turn-error", source: "provider-model" }));
  });

  it("does not replay completed tools when recovering from an empty response", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: "saved" }));
    const provider = scriptedProvider([
      [call("save", "write_file")],
      [],
      [{ type: "text-delta", text: "Finished" }],
    ]);

    const result = await run(provider, [tool("write_file", execute)]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.type === "turn-complete")).toBe(true);
  });

  it("does not exceed the round cap to recover an empty response", async () => {
    const requests: ChatRequest[] = [];
    const result = await run(scriptedProvider([[]], requests), [], { maxRounds: 0 });

    expect(requests).toHaveLength(1);
    expect(result.events.some((event) => event.type === "turn-complete")).toBe(false);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "turn-error", source: "provider-model" }));
  });

  it("continues when a task completion guard rejects a premature stop", async () => {
    const provider = scriptedProvider([
      [{ type: "text-delta", text: "done too early" }],
      [call("c1", "read_file")],
      [{ type: "text-delta", text: "done with evidence" }],
    ]);
    const guard = vi.fn((context: CompletionContext): CompletionDecision => ({
      accept: context.successfulToolCalls > 0,
      feedback: "Inspect the workspace before completing.",
    }));

    const h = await run(provider, [tool("read_file", { ok: true, content: "body" })], { completionGuard: guard });

    expect(guard).toHaveBeenCalledTimes(2);
    expect(types(h)).toEqual([
      "text-delta",
      "notice",
      "tool-call",
      "tool-result",
      "text-delta",
      "turn-complete",
    ]);
  });

  it("emits token usage from the provider stream", async () => {
    const provider = scriptedProvider([[{ type: "usage", usage: { inputTokens: 3, outputTokens: 7 } }]]);
    const h = await run(provider, []);

    const usage = h.events.find((e) => e.type === "token-usage") as Extract<MossEvent, { type: "token-usage" }>;
    expect(usage.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
  });

  it("auto-runs an allow-listed tool without requesting approval, then loops to completion", async () => {
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "done" }]]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "FILE BODY" })]);

    expect(types(h)).toEqual(["tool-call", "tool-result", "text-delta", "turn-complete"]);
    expect(h.approvals).toEqual([]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ callId: "c1", name: "read_file", ok: true, content: "FILE BODY" });
    // Allow-listed readonly tools carry no recorded tier; the audit derives one.
    expect(res.risk).toBeUndefined();
  });

  it("requests approval for an ask-gated tool and runs it when approved", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { approve: true });

    expect(types(h)).toContain("tool-approval-request");
    expect(h.approvals).toEqual(["c1"]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: true, content: "WROTE" });
  });

  it("returns a denial result when the user rejects an ask-gated tool", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], {
      approve: false,
      approvalComment: "Use the sandbox workspace instead",
    });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false });
    expect(res.content).toContain("User denied");
    expect(res.content).toContain("Use the sandbox workspace instead");
  });

  it("runs an ask-gated tool without prompting when autoApprove is on", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    expect(types(h)).not.toContain("tool-approval-request");
    expect(h.approvals).toEqual([]);
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ callId: "c1", name: "write_file", ok: true, content: "WROTE" });
  });

  it("records the resolved risk tier on the tool result event and the persisted message", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.risk).toBe("mutating");
    const done = h.events.find((e) => e.type === "turn-complete") as Extract<MossEvent, { type: "turn-complete" }>;
    const toolMsg = done.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(toolMsg?.risk).toBe("mutating");
  });

  it("records an execution duration on the tool result event and the persisted message", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(typeof res.durationMs).toBe("number");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    const done = h.events.find((e) => e.type === "turn-complete") as Extract<MossEvent, { type: "turn-complete" }>;
    const toolMsg = done.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(typeof toolMsg?.durationMs).toBe("number");
  });

  it("reports an unknown tool without throwing", async () => {
    const provider = scriptedProvider([[call("c1", "no_such_tool")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, []);

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false });
    expect(res.content).toContain("Unknown tool");
  });

  it("reports invalid JSON arguments without calling the tool", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: "" }));
    const provider = scriptedProvider([
      [call("c1", "read_file", "{ not json")],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const h = await run(provider, [tool("read_file", execute)]);

    expect(execute).not.toHaveBeenCalled();
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.content).toContain("Invalid JSON arguments");
  });

  it("does not execute a tool denied by the host admission guard", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: "should not run" }));
    const provider = scriptedProvider([
      [call("c1", "read_file")],
      [{ type: "text-delta", text: "stopped" }],
    ]);
    const h = await run(provider, [tool("read_file", execute)], {
      toolCallGuard: () => ({ allow: false, reason: "Step action budget exhausted" }),
    });

    expect(execute).not.toHaveBeenCalled();
    const res = h.events.find((event) => event.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false, content: "Step action budget exhausted" });
  });

  it("isolates a throwing tool into a failed result", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file")],
      [{ type: "text-delta", text: "ok" }],
    ]);
    const h = await run(provider, [
      tool("read_file", async () => {
        throw new Error("disk exploded");
      }),
    ]);

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: false, content: "disk exploded" });
  });

  it("retries a transient failure for a statically read-only tool", async () => {
    let attempts = 0;
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "done" }]]);
    const read = tool("read_file", async () => {
      attempts++;
      return attempts === 1
        ? { ok: false, content: "Service temporarily unavailable" }
        : { ok: true, content: "recovered" };
    });

    const h = await run(provider, [read]);

    expect(attempts).toBe(2);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "tool-result", ok: true, content: "recovered" }));
  });

  it("forces replanning after an identical failed action signature repeats", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file", '{"path":"missing"}')],
      [call("c2", "read_file", '{"path":"missing"}')],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("read_file", { ok: false, content: "Path is unavailable" })]);
    const results = h.events.filter((event) => event.type === "tool-result");

    expect(results[1]).toMatchObject({ ok: false });
    expect((results[1] as Extract<MossEvent, { type: "tool-result" }>).content).toContain("Required action: replan");
    expect((results[1] as Extract<MossEvent, { type: "tool-result" }>).content).toContain("repeated-action loop");
  });

  it("emits turn-aborted when the signal is already aborted", async () => {
    const provider = scriptedProvider([[{ type: "text-delta", text: "Hello" }]]);
    const h = await run(provider, [], { aborted: true });

    expect(types(h)).toEqual(["turn-aborted"]);
  });

  it("emits turn-error when the provider throws", async () => {
    const h = await run(throwingProvider("provider down"), []);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("provider down");
    expect(err.source).toBe("provider-model");
  });

  it("allows a final response after the maximum tool rounds", async () => {
    const requests: ChatRequest[] = [];
    const provider = scriptedProvider([
      [call("c1", "read_file")],
      [call("c2", "read_file")],
      [{ type: "text-delta", text: "Final reply" }],
    ], requests);
    const h = await run(provider, [tool("read_file", { ok: true, content: "again" })], { maxRounds: 2 });

    expect(h.events.filter((e) => e.type === "tool-result")).toHaveLength(2);
    expect(h.events.at(-1)?.type).toBe("turn-complete");
    expect(requests[2].tools).toEqual([]);
  });

  it("stops with an error when a provider calls a tool during finalization", async () => {
    // This provider ignores the empty tool definition list in the final round.
    const provider = scriptedProvider([[call("c1", "read_file")]]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "again" })]);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toContain("tool rounds");
    expect(err.source).toBe("harness-orchestration");
    // The finalization call cannot execute a ninth tool.
    expect(h.events.filter((e) => e.type === "tool-result")).toHaveLength(8);
  });

  it("aborts mid-stream and drops events emitted after the signal trips", async () => {
    const controller = new AbortController();
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text-delta", text: "one" };
        controller.abort();
        yield { type: "text-delta", text: "two" };
      },
      async listModels() {
        return [];
      },
    };
    const events: MossEvent[] = [];
    await runTurn({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      toolRegistry: new Map(),
      workspaceRoot: "/work",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      requestApproval: async () => ({ approved: true }),
    });

    expect(events.filter((event) => !TRACE_EVENT_TYPES.has(event.type)).map((event) => event.type)).toEqual(["text-delta", "turn-aborted"]);
    const delta = events.find((event): event is Extract<MossEvent, { type: "text-delta" }> => event.type === "text-delta")!;
    expect(delta.text).toBe("one");
  });

  it("executes every tool call in a multi-call round, in order", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file"), call("c2", "read_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "X" })]);

    const results = h.events.filter((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>[];
    expect(results.map((r) => r.callId)).toEqual(["c1", "c2"]);
  });

  it("emits turn-error when the provider throws on a later round, after a prior tool ran", async () => {
    let round = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        round += 1;
        if (round === 1) {
          yield { type: "tool-call", toolCall: { id: "c1", name: "read_file", arguments: "{}" } };
          return;
        }
        throw new Error("mid-turn failure");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, [tool("read_file", { ok: true, content: "X" })]);

    expect(h.events.some((e) => e.type === "tool-result")).toBe(true);
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("mid-turn failure");
    // the completed round's assistant + tool messages ride along so the renderer
    // commits them verbatim instead of reconstructing from delta events
    expect(err.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(err.messages[0].toolCalls?.[0]?.id).toBe("c1");
  });

  it("carries partial assistant text on turn-error when the provider throws mid-stream", async () => {
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text-delta", text: "half a thought" };
        throw new Error("stream died");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("stream died");
    expect(err.messages).toEqual([{ role: "assistant", content: "half a thought" }]);
  });

  it("attaches per-round token usage to the assistant message", async () => {
    const provider = scriptedProvider([
      [
        { type: "text-delta", text: "hi" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
      ],
    ]);
    const h = await run(provider, []);

    const complete = h.events.find((e) => e.type === "turn-complete") as Extract<
      MossEvent,
      { type: "turn-complete" }
    >;
    expect(complete.messages[0].usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("marks an auto-approved ask-gated tool on the result and persists it on the tool message", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], { autoApprove: true });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.autoApproved).toBe(true);
    const complete = h.events.find((e) => e.type === "turn-complete") as Extract<MossEvent, { type: "turn-complete" }>;
    const toolMsg = complete.messages.find((m) => m.role === "tool");
    expect(toolMsg?.autoApproved).toBe(true);
  });

  it("uses the active mission grant instead of legacy auto-approve", async () => {
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const executionGrant: TaskExecutionGrant = {
      schemaVersion: 1,
      authority: "policy-scoped",
      allowedCapabilities: ["write_file"],
      maxAutoApprovedRisk: "mutating",
      budget: { maxActions: 2 },
      scopes: {},
    };
    const h = await run(provider, [tool("write_file", { ok: true, content: "WROTE" })], {
      autoApprove: true,
      executionGrant,
      stepCapabilities: [],
      approve: false,
    });

    expect(h.approvals).toEqual([]);
    const result = h.events.find((event) => event.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(result).toMatchObject({ ok: false, autoApproved: false });
    expect(result.content).toContain("Denied by policy");
  });

  it("does not mark allow-listed or user-approved tools as auto-approved", async () => {
    const allow = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "ok" }]]);
    const h1 = await run(allow, [tool("read_file", { ok: true, content: "X" })]);
    const r1 = h1.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(r1.autoApproved).toBe(false);

    const ask = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    const h2 = await run(ask, [tool("write_file", { ok: true, content: "W" })], { approve: true });
    const r2 = h2.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(r2.autoApproved).toBe(false);
  });

  it("retries a transient stream failure before any output, then succeeds", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        yield { type: "text-delta", text: "recovered" };
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(2);
    expect(types(h)).toEqual(["notice", "text-delta", "turn-complete"]);
    const notice = h.events.find((e) => e.type === "notice") as Extract<MossEvent, { type: "notice" }>;
    expect(notice.level).toBe("warn");
    expect(notice.message).toContain("retrying");
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages).toEqual([{ role: "assistant", content: "recovered" }]);
  });

  it("compacts and retries once when the provider reports context overflow before output", async () => {
    let attempts = 0;
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        attempts += 1;
        if (attempts === 1) throw new ProviderError("maximum context length exceeded", 400);
        yield { type: "text-delta", text: "recovered" };
      },
      async listModels() {
        return [];
      },
    };
    const oldContent = "x".repeat(4000);
    const h = await run(provider, [], {
      messages: [
        { role: "user", content: oldContent },
        { role: "assistant", content: oldContent },
        { role: "user", content: "latest" },
      ],
    });

    expect(attempts).toBe(3);
    expect(requests[1].maxTokens).toBe(512);
    expect(requests[2].messages.at(-1)?.content).toBe("latest");
    expect(requests[2].messages.some((message) => message.role === "assistant" && message.content === "recovered")).toBe(true);
    expect(requests[2].messages[0].content).toContain("earlier messages were omitted");
    const notice = h.events.find((event) => event.type === "notice") as Extract<MossEvent, { type: "notice" }>;
    expect(notice.level).toBe("info");
    expect(notice.message).toContain("Provider context limit reached");
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages).toEqual([{ role: "assistant", content: "recovered" }]);
  });

  it("surfaces a repeated context overflow after one compacted retry", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        throw new ProviderError("context_length_exceeded", 400);
      },
      async listModels() {
        return [];
      },
    };
    const oldContent = "x".repeat(4000);
    const h = await run(provider, [], {
      messages: [
        { role: "user", content: oldContent },
        { role: "assistant", content: oldContent },
        { role: "user", content: "latest" },
      ],
    });

    expect(attempts).toBe(3);
    expect(types(h).filter((type) => type === "notice")).toHaveLength(1);
    const error = h.events.at(-1) as Extract<MossEvent, { type: "turn-error" }>;
    expect(error.message).toContain("context_length_exceeded");
  });

  it("falls back to omission-only overflow recovery when semantic summarization fails", async () => {
    let attempts = 0;
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        if (attempts === 1) throw new ProviderError("maximum context length exceeded", 400);
        if (attempts === 2) throw new ProviderError("summary unavailable", 429);
        yield { type: "text-delta", text: "recovered without summary" };
      },
      async listModels() {
        return [];
      },
    };
    const oldContent = "x".repeat(4000);

    const h = await run(provider, [], {
      messages: [
        { role: "user", content: oldContent },
        { role: "assistant", content: oldContent },
        { role: "user", content: "latest" },
      ],
    });

    expect(attempts).toBe(3);
    expect(requests[2].messages.map((message) => message.role)).toEqual(["system", "user"]);
    const notice = h.events.find((event) => event.type === "notice") as Extract<MossEvent, { type: "notice" }>;
    expect(notice.message).toContain("trimmed 2 older messages");
    expect(h.events.at(-1)?.type).toBe("turn-complete");
  });

  it("semantically summarizes a proactively compacted prefix and accounts for usage", async () => {
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        if (request.maxTokens === 512) {
          yield { type: "text-delta", text: "Decision ALPHA selected parser.ts." };
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
          return;
        }
        yield { type: "text-delta", text: "continued" };
      },
      async listModels() {
        return [];
      },
    };
    const oldContent = `Decision ALPHA ${"x".repeat(16000)}`;

    const h = await run(provider, [], {
      contextLimit: 4000,
      messages: [
        { role: "user", content: oldContent },
        { role: "assistant", content: "Use parser.ts because it owns tokenization." },
        { role: "user", content: "Continue with the latest task." },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].maxTokens).toBe(512);
    expect(requests[1].messages.some((message) => message.role === "assistant" && message.content.includes("Decision ALPHA"))).toBe(true);
    expect(requests[1].messages.some((message) => message.content === oldContent)).toBe(false);
    expect(h.events).toContainEqual({ type: "token-usage", usage: { inputTokens: 100, outputTokens: 10 } });
    expect(h.events).toContainEqual({ type: "context-compaction", reason: "proactive", droppedCount: 2 });
  });

  it("does not compact or retry a context overflow after text was streamed", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        yield { type: "text-delta", text: "partial" };
        throw new ProviderError("maximum context length exceeded", 400);
      },
      async listModels() {
        return [];
      },
    };
    const oldContent = "x".repeat(4000);
    const h = await run(provider, [], {
      messages: [
        { role: "user", content: oldContent },
        { role: "assistant", content: oldContent },
        { role: "user", content: "latest" },
      ],
    });

    expect(attempts).toBe(1);
    expect(types(h)).toEqual(["text-delta", "turn-error"]);
  });

  it("gives up after the retry cap when the stream keeps failing before output", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        throw new Error("down");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(3); // initial attempt + 2 retries
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("down");
  });

  it("surfaces a permanent provider error immediately without retrying", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        throw new ProviderError("Anthropic request failed: HTTP 401 bad key", 401);
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(1); // 4xx is permanent: no retry
    expect(types(h)).not.toContain("notice");
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toContain("HTTP 401");
  });

  it("retries a server-side provider error before any output, then succeeds", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        if (attempts === 1) throw new ProviderError("HTTP 503 overloaded", 503);
        yield { type: "text-delta", text: "ok" };
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(2); // 5xx is transient: retried once
    expect(types(h)).toContain("notice");
  });

  it("does not retry once text has been streamed, even if the stream then throws", async () => {
    let attempts = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        attempts += 1;
        yield { type: "text-delta", text: "partial" };
        throw new Error("mid");
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, []);

    expect(attempts).toBe(1);
    const err = h.events.find((e) => e.type === "turn-error") as Extract<MossEvent, { type: "turn-error" }>;
    expect(err.message).toBe("mid");
    expect(err.messages).toEqual([{ role: "assistant", content: "partial" }]);
  });

  it("truncates a large tool result in the model-facing history but emits the full content", async () => {
    const big = "x".repeat(20000);
    const seen: AgentMessage[][] = [];
    let round = 0;
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(req): AsyncIterable<ProviderStreamEvent> {
        seen.push(req.messages);
        round += 1;
        if (round === 1) {
          yield { type: "tool-call", toolCall: { id: "c1", name: "read_file", arguments: "{}" } };
          return;
        }
        yield { type: "text-delta", text: "done" };
      },
      async listModels() {
        return [];
      },
    };
    const h = await run(provider, [tool("read_file", { ok: true, content: big })]);

    // the renderer event keeps the full output
    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.content).toBe(big);
    // round 2's prompt carries a truncated copy of the tool message
    const toolMsg = seen[1].find((m) => m.role === "tool");
    expect(toolMsg?.content.length).toBeLessThan(big.length);
    expect(toolMsg?.content).toContain("[truncated");
    // audit-only metadata stays out of the model-facing history
    expect(toolMsg?.durationMs).toBeUndefined();
    expect(toolMsg?.risk).toBeUndefined();
  });

  it("stores a large result and gives the model an opaque retrieval id", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-tool-output-runner-"));
    const store = new ToolOutputStore(root);
    const big = `start\n${"x".repeat(20000)}\nend`;
    const requests: ChatRequest[] = [];
    try {
      const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "done" }]], requests);
      const h = await run(provider, [tool("read_file", { ok: true, content: big })], { toolOutputStore: store, turnId: "turn-1" });

      const modelResult = requests[1].messages.find((message) => message.role === "tool");
      const id = /artifact ([0-9a-f-]{36})/i.exec(modelResult?.content ?? "")?.[1];
      expect(id).toBeDefined();
      expect(Buffer.byteLength(modelResult?.content ?? "")).toBeLessThanOrEqual(8000);
      expect((await store.get(id!))?.content).toBe(big);
      const persisted = (h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>).messages.find((message) => message.role === "tool");
      expect(persisted?.content).toBe(big);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for cooperative cleanup before reporting a tool timeout", async () => {
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "after" }]]);
    const order: string[] = [];
    const cooperative = tool("read_file", () => Promise.reject(new Error("test tool requires a signal-aware execute override")), 1000);
    cooperative.execute = async (_args, ctx) => new Promise<ToolResult>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        order.push("cleanup");
        resolve({ ok: false, content: "cancelled" });
      }, { once: true });
    });
    const h = await run(provider, [cooperative], { toolTimeoutMs: 10 });
    order.push("reported");

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res.ok).toBe(false);
    expect(res.content).toContain("timed out");
    expect(order.at(-1)).toBe("reported");
    expect(order.slice(0, -1)).toEqual(["cleanup", "cleanup", "cleanup"]);
    // the loop recovered and ran the next round
    expect(types(h)).toContain("text-delta");
  });

  it("does not impose a deadline on a tool that does not declare one", async () => {
    const provider = scriptedProvider([[call("c1", "read_file")], [{ type: "text-delta", text: "after" }]]);
    const slow = tool("read_file", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, content: "finished" };
    });
    const h = await run(provider, [slow], { toolTimeoutMs: 5 });

    const res = h.events.find((e) => e.type === "tool-result") as Extract<MossEvent, { type: "tool-result" }>;
    expect(res).toMatchObject({ ok: true, content: "finished" });
  });

  it("advises the model after three identical successful calls without changing persisted results", async () => {
    const requests: ChatRequest[] = [];
    const provider = scriptedProvider([
      [call("c1", "read_file", '{"path":"a"}')],
      [call("c2", "read_file", '{"path":"a"}')],
      [call("c3", "read_file", '{"path":"a"}')],
      [{ type: "text-delta", text: "done" }],
    ], requests);
    const h = await run(provider, [tool("read_file", { ok: true, content: "body" })]);

    const modelResults = requests[3].messages.filter((message) => message.role === "tool");
    expect(modelResults[2].content).toContain("Moss noticed the same tool call three times");
    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages.filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
      "body",
      "body",
      "body",
    ]);
  });

  it("caps a large tool result carried in from a prior turn's history", async () => {
    const big = "y".repeat(20000);
    const seen: AgentMessage[][] = [];
    const provider: ChatProvider = {
      kind: "test",
      async *streamChat(req): AsyncIterable<ProviderStreamEvent> {
        seen.push(req.messages);
        yield { type: "text-delta", text: "ok" };
      },
      async listModels() {
        return [];
      },
    };
    const priorTool: AgentMessage = { role: "tool", content: big, toolCallId: "old" };
    const h = await run(provider, [], { messages: [{ role: "user", content: "hi" }, priorTool] });

    expect(types(h)).toEqual(["text-delta", "turn-complete"]);
    // the model-facing seed carries a truncated copy of the prior tool result
    const toolMsg = seen[0].find((m) => m.role === "tool");
    expect(toolMsg?.content.length).toBeLessThan(big.length);
    expect(toolMsg?.content).toContain("[truncated");
  });

  it("stamps the turnId on assistant messages so the renderer can key checkpoints", async () => {
    const provider = scriptedProvider([[{ type: "text-delta", text: "hi" }]]);
    const h = await run(provider, [], { turnId: "turn-7" });

    const complete = h.events.at(-1) as Extract<MossEvent, { type: "turn-complete" }>;
    expect(complete.messages[0]).toMatchObject({ role: "assistant", turnId: "turn-7" });
  });

  it("threads the checkpoint recorder into the tool context", async () => {
    const recorded: Array<[string, string]> = [];
    const checkpoint = {
      record: async (abs: string, rel: string): Promise<void> => {
        recorded.push([abs, rel]);
      },
    };
    const snapshotting: Tool = {
      name: "write_file",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        await ctx.checkpoint?.record("/work/a.txt", "a.txt");
        return { ok: true, content: "W" };
      },
    };
    const provider = scriptedProvider([[call("c1", "write_file")], [{ type: "text-delta", text: "ok" }]]);
    await run(provider, [snapshotting], { autoApprove: true, checkpoint });

    expect(recorded).toEqual([["/work/a.txt", "a.txt"]]);
  });
});

describe("runTurn verification loop", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "moss-runner-verify-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const notices = (h: Harness): Extract<MossEvent, { type: "notice" }>[] =>
    h.events.filter((e): e is Extract<MossEvent, { type: "notice" }> => e.type === "notice");

  it("runs verification after a mutating edit and emits a passing notice", async () => {
    const provider = scriptedProvider([
      [call("c1", "write_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "W" })], {
      autoApprove: true,
      workspaceRoot: cwd,
      verify: { enabled: true, commands: ["exit 0"] },
    });

    const ns = notices(h);
    expect(ns).toHaveLength(1);
    expect(ns[0].level).toBe("info");
  });

  it("runs verification after a mutating shell command", async () => {
    const provider = scriptedProvider([
      [call("c1", "run_command", '{"command":"npm install"}')],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("run_command", { ok: true, content: "installed" })], {
      autoApprove: true,
      workspaceRoot: cwd,
      verify: { enabled: true, commands: ["exit 0"] },
    });

    expect(notices(h).some((notice) => notice.message === "Verification passed")).toBe(true);
  });

  it("emits a warning notice when verification fails", async () => {
    const provider = scriptedProvider([
      [call("c1", "write_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "W" })], {
      autoApprove: true,
      workspaceRoot: cwd,
      verify: { enabled: true, commands: ["exit 1"] },
    });

    const ns = notices(h);
    expect(ns).toHaveLength(1);
    expect(ns[0].level).toBe("warn");
    expect(ns[0].message).toContain("Verification failed");
  });

  it("does not verify when no mutating tool ran", async () => {
    const provider = scriptedProvider([
      [call("c1", "read_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("read_file", { ok: true, content: "R" })], {
      autoApprove: true,
      workspaceRoot: cwd,
      verify: { enabled: true, commands: ["exit 0"] },
    });

    expect(notices(h)).toHaveLength(0);
  });

  it("stops verifying once the cycle budget is exhausted", async () => {
    const provider = scriptedProvider([
      [call("c1", "write_file")],
      [call("c2", "write_file")],
      [{ type: "text-delta", text: "done" }],
    ]);
    const h = await run(provider, [tool("write_file", { ok: true, content: "W" })], {
      autoApprove: true,
      workspaceRoot: cwd,
      verify: { enabled: true, commands: ["exit 0"], maxCycles: 1 },
    });

    expect(notices(h)).toHaveLength(1);
  });
});
