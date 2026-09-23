import { describe, expect, it } from "vitest";

import type { HarnessExecutionTrace } from "../../../../common/evals";
import { measureProductMetrics } from "./product-metrics";

function trace(events: HarnessExecutionTrace["events"], terminalState: HarnessExecutionTrace["terminalState"]): HarnessExecutionTrace {
  return { schemaVersion: 1, events, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, terminalState };
}

describe("measureProductMetrics", () => {
  it("measures approval latency, interventions, and successful recovery", () => {
    const metrics = measureProductMetrics(trace([
      { type: "approval-requested", callId: "call", name: "write_file", sequence: 1, timestamp: "2025-01-01T00:00:00.000Z" },
      { type: "approval-decision", callId: "call", approved: false, commentProvided: true, sequence: 2, timestamp: "2025-01-01T00:00:02.500Z" },
      { type: "recovery", action: "replan", attempt: 1, classification: "approval-denied", outcome: "succeeded", sequence: 3, timestamp: "2025-01-01T00:00:03.000Z" },
      { type: "terminal", state: "completed", sequence: 4, timestamp: "2025-01-01T00:00:04.000Z" },
    ], "completed"), undefined);

    expect(metrics).toMatchObject({
      interventionCount: 1,
      approvalLatencyMs: 2_500,
      recoveryAttempts: 1,
      recoverySucceeded: true,
      falseCompletion: false,
    });
  });

  it("flags completion without required successful verification", () => {
    expect(measureProductMetrics(trace([
      { type: "verification", ok: false, checkCount: 1, sequence: 1, timestamp: "2025-01-01T00:00:00.000Z" },
      { type: "terminal", state: "completed", sequence: 2, timestamp: "2025-01-01T00:00:01.000Z" },
    ], "completed"), { requireVerificationBeforeCompletion: true }).falseCompletion).toBe(true);
  });
});
