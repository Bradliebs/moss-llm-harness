import { describe, expect, it, vi } from "vitest";
import type { ChatProvider, ChatRequest } from "../providers/types";
import { MissionBudgetProvider, missionDeadline } from "./mission-budget";

const request: ChatRequest = { model: "fixture", messages: [{ role: "user", content: "hi" }], maxTokens: 100 };

describe("mission budgets", () => {
  it("rejects requests that cannot fit the prompt, before provider access", async () => {
    const stream = vi.fn();
    const provider: ChatProvider = { kind: "fixture", streamChat: stream, listModels: async () => [] };
    const budget = new MissionBudgetProvider(provider, { maxTokens: 10 });
    await expect(async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; }).rejects.toThrow("budget");
    expect(stream).not.toHaveBeenCalled();
  });

  it("charges cumulative usage and cannot admit another round after exhaustion", async () => {
    const provider: ChatProvider = { kind: "fixture", listModels: async () => [], async *streamChat() {
      yield { type: "usage", usage: { inputTokens: 400, outputTokens: 100 } };
    } };
    const budget = new MissionBudgetProvider(provider, { maxTokens: 500, maxCostUsd: 1 }, { fixture: { inputPer1M: 1, outputPer1M: 2 } });
    for await (const event of budget.streamChat(request, new AbortController().signal)) void event;
    expect(budget.usage).toEqual({ inputTokens: 400, outputTokens: 100 });
    expect(budget.estimatedCostUsd).toBeCloseTo(0.0006);
    await expect(async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; }).rejects.toThrow("budget");
  });

  it("fails closed on unknown model prices for cost-limited work", async () => {
    const provider: ChatProvider = { kind: "fixture", listModels: async () => [], async *streamChat() { yield { type: "text-delta", text: "no" }; } };
    const budget = new MissionBudgetProvider(provider, { maxCostUsd: 1 });
    await expect(async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; }).rejects.toThrow("model rate");
  });

  it("reserves allowance before concurrent provider requests can spend it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const called = vi.fn();
    const provider: ChatProvider = { kind: "fixture", listModels: async () => [], async *streamChat() {
      called();
      await gate;
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } };
    } };
    const budget = new MissionBudgetProvider(provider, { maxTokens: 500 });
    const first = (async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; })();
    try {
      await expect(async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; }).rejects.toThrow("budget");
      expect(called).toHaveBeenCalledOnce();
    } finally {
      release();
      await first;
    }
  });

  it("records provider overruns even when the stream is rejected", async () => {
    const provider: ChatProvider = { kind: "fixture", listModels: async () => [], async *streamChat() {
      yield { type: "usage", usage: { inputTokens: 600, outputTokens: 10 } };
    } };
    const budget = new MissionBudgetProvider(provider, { maxTokens: 500 });
    await expect(async () => { for await (const event of budget.streamChat(request, new AbortController().signal)) void event; }).rejects.toThrow("exceeded");
    expect(budget.usage).toEqual({ inputTokens: 600, outputTokens: 10 });
  });

  it("aborts active work when its duration allowance expires", async () => {
    vi.useFakeTimers();
    try {
      const deadline = missionDeadline(new AbortController().signal, 20);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(deadline.signal.aborted).toBe(true);
      deadline.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});