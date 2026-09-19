import { describe, expect, it } from "vitest";

import { HarnessTraceCollector } from "./trace-collector";

describe("HarnessTraceCollector", () => {
  it("correlates calls by id and excludes raw arguments, output, and model text", () => {
    const collector = new HarnessTraceCollector();
    collector.onEvent({
      type: "tool-call",
      callId: "call-1",
      name: "edit_file",
      arguments: JSON.stringify({ path: "result.txt", apiKey: "secret-value" }),
    });
    collector.onEvent({
      type: "tool-approval-request",
      callId: "call-1",
      name: "edit_file",
      arguments: "sensitive approval payload",
      risk: "mutating",
    });
    collector.onEvent({
      type: "tool-result",
      callId: "call-1",
      name: "edit_file",
      ok: false,
      content: "User denied: secret-value",
      autoApproved: false,
      risk: "mutating",
      durationMs: 12,
    });

    const trace = collector.snapshot();

    expect(trace.toolCalls).toEqual([expect.objectContaining({
      callId: "call-1",
      name: "edit_file",
      argumentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvalRequested: true,
      ok: false,
      autoApproved: false,
      risk: "mutating",
      durationMs: 12,
    })]);
    expect(JSON.stringify(trace)).not.toContain("secret-value");
    expect(JSON.stringify(trace)).not.toContain("sensitive approval payload");
  });

  it("marks recovery only for a later successful call with the same action hash", () => {
    const collector = new HarnessTraceCollector();
    const argumentsJson = JSON.stringify({ path: "result.txt" });
    collector.onEvent({ type: "tool-call", callId: "failed", name: "write_file", arguments: argumentsJson });
    collector.onEvent({
      type: "tool-result",
      callId: "failed",
      name: "write_file",
      ok: false,
      content: "temporary failure",
      autoApproved: true,
    });
    collector.onEvent({ type: "tool-call", callId: "other", name: "write_file", arguments: "{}" });
    collector.onEvent({
      type: "tool-result",
      callId: "other",
      name: "write_file",
      ok: true,
      content: "different action",
      autoApproved: true,
    });
    collector.onEvent({ type: "tool-call", callId: "recovered", name: "write_file", arguments: argumentsJson });
    collector.onEvent({
      type: "tool-result",
      callId: "recovered",
      name: "write_file",
      ok: true,
      content: "done",
      autoApproved: true,
    });

    expect(collector.snapshot().toolCalls[1].recoveredFromCallId).toBeUndefined();
    expect(collector.snapshot().toolCalls[2].recoveredFromCallId).toBe("call-1");
  });

  it("totals usage and records the terminal event", () => {
    const collector = new HarnessTraceCollector();
    collector.onEvent({ type: "token-usage", usage: { inputTokens: 10, outputTokens: 2 } });
    collector.onEvent({ type: "token-usage", usage: { inputTokens: 5, outputTokens: 1 } });
    collector.onEvent({ type: "turn-complete", messages: [] });

    expect(collector.snapshot()).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 3 },
      terminalState: "completed",
    });
  });

  it("emits an ordered versioned envelope without retaining sensitive content", () => {
    let tick = 0;
    const collector = new HarnessTraceCollector(() => new Date(`2026-01-01T00:00:0${tick++}.000Z`));
    collector.onEvent({ type: "round-start", round: 0, toolsEnabled: true });
    collector.onEvent({
      type: "tool-call",
      callId: "call-1",
      name: "write_file",
      arguments: JSON.stringify({ token: "raw-secret" }),
    });
    collector.onEvent({
      type: "tool-approval-request",
      callId: "call-secret",
      name: "write_file",
      arguments: "approval-secret",
      risk: "mutating",
    });
    collector.onEvent({
      type: "tool-result",
      callId: "call-secret",
      name: "write_file",
      ok: true,
      content: "model-output-secret",
      autoApproved: false,
      risk: "mutating",
      durationMs: 8,
    });
    collector.onEvent({ type: "verification", ok: false, checkCount: 2, failedCheckHash: "a".repeat(64) });
    collector.onEvent({ type: "context-compaction", reason: "overflow", droppedCount: 3 });
    collector.onEvent({ type: "round-end", round: 0, toolCallCount: 1, finish: "tools" });
    collector.onEvent({ type: "turn-complete", messages: [{ role: "assistant", content: "assistant-secret" }] });

    const trace = collector.snapshot();

    expect(trace.schemaVersion).toBe(1);
    expect(trace.events.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
      { sequence: 1, type: "round-start" },
      { sequence: 2, type: "tool-call" },
      { sequence: 3, type: "approval-requested" },
      { sequence: 4, type: "tool-result" },
      { sequence: 5, type: "verification" },
      { sequence: 6, type: "context-compaction" },
      { sequence: 7, type: "round-end" },
      { sequence: 8, type: "terminal" },
    ]);
    expect(trace.events[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(trace.events[1]).toMatchObject({
      type: "tool-call",
      callId: "call-1",
      argumentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("approval-secret");
    expect(serialized).not.toContain("model-output-secret");
    expect(serialized).not.toContain("assistant-secret");
    expect(serialized).not.toContain("call-secret");
  });
});