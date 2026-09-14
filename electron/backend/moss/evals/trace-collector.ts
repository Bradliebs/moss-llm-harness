import { createHash } from "node:crypto";

import type { EvalScenarioDisturbance, HarnessExecutionTrace, HarnessTraceEvent, HarnessTraceToolCall } from "../../../../common/evals";
import type { MossEvent } from "../../../../common/types";

/** Collects process metadata without retaining model text, tool arguments, or tool output. */
export class HarnessTraceCollector {
  private readonly calls = new Map<string, HarnessTraceToolCall>();
  private readonly callOrder: string[] = [];
  private readonly traceCallIds = new Map<string, string>();
  private readonly failedActions = new Map<string, string>();
  private readonly events: HarnessExecutionTrace["events"] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private terminalState: HarnessExecutionTrace["terminalState"];

  constructor(private readonly now: () => Date = () => new Date()) {}

  onEvent(event: MossEvent): void {
    if (event.type === "round-start" || event.type === "round-end") {
      this.record({ ...event });
      return;
    }

    if (event.type === "tool-call") {
      const callId = this.traceCallId(event.callId);
      const call: HarnessTraceToolCall = {
        callId,
        name: event.name,
        argumentHash: hashArguments(event.arguments),
        approvalRequested: false,
      };
      if (!this.calls.has(callId)) this.callOrder.push(callId);
      this.calls.set(callId, call);
      this.record({
        type: "tool-call",
        callId,
        name: event.name,
        argumentHash: call.argumentHash!,
      });
      return;
    }

    if (event.type === "tool-approval-request") {
      const call = this.getOrCreateCall(event.callId, event.name);
      call.approvalRequested = true;
      call.risk = event.risk;
      this.record({ type: "approval-requested", callId: call.callId, name: event.name, risk: event.risk });
      return;
    }

    if (event.type === "tool-result") {
      const call = this.getOrCreateCall(event.callId, event.name);
      call.ok = event.ok;
      call.autoApproved = event.autoApproved;
      call.risk = event.risk ?? call.risk;
      call.durationMs = event.durationMs;
      const actionKey = traceActionKey(call);
      if (event.ok) {
        const failedCallId = this.failedActions.get(actionKey);
        if (failedCallId && failedCallId !== call.callId) call.recoveredFromCallId = failedCallId;
        this.failedActions.delete(actionKey);
      } else {
        this.failedActions.set(actionKey, call.callId);
      }
      this.record({
        type: "tool-result",
        callId: call.callId,
        name: event.name,
        ok: event.ok,
        autoApproved: event.autoApproved,
        risk: event.risk,
        durationMs: event.durationMs,
      });
      return;
    }

    if (event.type === "recovery") {
      this.record({
        ...event,
        ...(event.sourceCallId ? { sourceCallId: this.traceCallId(event.sourceCallId) } : {}),
      });
      return;
    }

    if (event.type === "verification" || event.type === "context-compaction") {
      this.record({ ...event });
      return;
    }

    if (event.type === "token-usage") {
      this.inputTokens += event.usage.inputTokens ?? 0;
      this.outputTokens += event.usage.outputTokens ?? 0;
      return;
    }

    if (event.type === "turn-complete") this.setTerminalState("completed");
    else if (event.type === "turn-aborted") this.setTerminalState("aborted");
    else if (event.type === "turn-error") this.setTerminalState("error");
  }

  snapshot(): HarnessExecutionTrace {
    return {
      schemaVersion: 1,
      events: structuredClone(this.events),
      toolCalls: this.callOrder.map((callId) => structuredClone(this.calls.get(callId)!)),
      usage: {
        ...(this.inputTokens > 0 ? { inputTokens: this.inputTokens } : {}),
        ...(this.outputTokens > 0 ? { outputTokens: this.outputTokens } : {}),
      },
      ...(this.terminalState ? { terminalState: this.terminalState } : {}),
    };
  }

  markBudgetExhausted(): void {
    this.setTerminalState("budget-exhausted");
  }

  markHarnessError(): void {
    this.setTerminalState("error");
  }

  markBlocked(): void {
    this.setTerminalState("blocked");
  }

  recordScenarioDisturbance(
    id: string,
    disturbanceType: EvalScenarioDisturbance["type"],
    status: "planned" | "delivered" | "undelivered",
  ): void {
    this.record({ type: "scenario-disturbance", id, disturbanceType, status });
  }

  recordApprovalDecision(callId: string, approved: boolean, commentProvided: boolean): void {
    this.record({ type: "approval-decision", callId: this.traceCallId(callId), approved, commentProvided });
  }

  recordBudgetBoundary(
    boundary: "actions" | "tokens" | "cost" | "duration",
    limit: number,
    observed: number,
  ): void {
    this.record({ type: "budget-boundary", boundary, limit, observed });
  }

  private getOrCreateCall(callId: string, name: string): HarnessTraceToolCall {
    const traceCallId = this.traceCallId(callId);
    const existing = this.calls.get(traceCallId);
    if (existing) return existing;
    const call: HarnessTraceToolCall = { callId: traceCallId, name, approvalRequested: false };
    this.calls.set(traceCallId, call);
    this.callOrder.push(traceCallId);
    return call;
  }

  private traceCallId(providerCallId: string): string {
    const existing = this.traceCallIds.get(providerCallId);
    if (existing) return existing;
    const traceCallId = `call-${this.traceCallIds.size + 1}`;
    this.traceCallIds.set(providerCallId, traceCallId);
    return traceCallId;
  }

  private record(event: HarnessTraceEvent): void {
    this.events.push({ ...event, sequence: this.events.length + 1, timestamp: this.now().toISOString() });
  }

  private setTerminalState(state: NonNullable<HarnessExecutionTrace["terminalState"]>): void {
    this.terminalState = state;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index];
      if (event.type === "terminal") {
        if (event.state === state) return;
        this.events.splice(index, 1);
        this.events.forEach((item, itemIndex) => { item.sequence = itemIndex + 1; });
        break;
      }
    }
    this.record({ type: "terminal", state });
  }
}

function hashArguments(argumentsJson: string): string {
  return createHash("sha256").update(argumentsJson).digest("hex");
}

function traceActionKey(call: HarnessTraceToolCall): string {
  return `${call.name}:${call.argumentHash ?? "unknown"}`;
}