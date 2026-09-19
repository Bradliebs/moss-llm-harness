import { estimateCost, modelRate, type ModelRate } from "../../../../common/pricing";
import type { TaskBudget, TokenUsage } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";

export class MissionBudgetError extends Error {}

export class MissionBudgetProvider implements ChatProvider {
  readonly usage = { inputTokens: 0, outputTokens: 0 };
  estimatedCostUsd = 0;
  private reservedTokens = 0;
  private reservedCost = 0;
  get kind(): string { return this.provider.kind; }

  constructor(
    private readonly provider: ChatProvider,
    private readonly budget: TaskBudget,
    private readonly rates?: Record<string, ModelRate>,
  ) {}

  listModels(): Promise<string[]> { return this.provider.listModels(); }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    signal.throwIfAborted();
    const rate = modelRate(request.model, this.rates);
    if (this.budget.maxCostUsd !== undefined && (!rate || !Number.isFinite(rate.inputPer1M) || !Number.isFinite(rate.outputPer1M) || rate.inputPer1M < 0 || rate.outputPer1M < 0)) {
      throw new MissionBudgetError("Mission cost budget requires a known or configured model rate");
    }
    const promptAllowance = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), "utf8") + 256;
    const remainingTokens = (this.budget.maxTokens ?? Infinity) - this.usage.inputTokens - this.usage.outputTokens - this.reservedTokens;
    const remainingCost = (this.budget.maxCostUsd ?? Infinity) - this.estimatedCostUsd - this.reservedCost;
    const promptCost = rate ? promptAllowance * rate.inputPer1M / 1_000_000 : 0;
    const affordableOutput = rate && rate.outputPer1M > 0
      ? Math.floor((remainingCost - promptCost) * 1_000_000 / rate.outputPer1M)
      : Infinity;
    const outputAllowance = Math.floor(Math.min(request.maxTokens ?? 4096, remainingTokens - promptAllowance, affordableOutput));
    if (outputAllowance < 1 || promptCost > remainingCost) throw new MissionBudgetError("Mission token or cost budget cannot admit another model request");
    const reservation = promptAllowance + outputAllowance;
    const costReservation = promptCost + (rate ? outputAllowance * rate.outputPer1M / 1_000_000 : 0);
    this.reservedTokens += reservation;
    this.reservedCost += costReservation;
    const reported: TokenUsage = {};
    try {
      for await (const event of this.provider.streamChat({ ...request, maxTokens: outputAllowance }, signal)) {
        signal.throwIfAborted();
        if (event.type === "usage") {
          if (event.usage.inputTokens !== undefined) reported.inputTokens = (reported.inputTokens ?? 0) + event.usage.inputTokens;
          if (event.usage.outputTokens !== undefined) reported.outputTokens = (reported.outputTokens ?? 0) + event.usage.outputTokens;
        }
        yield event;
        const current = { inputTokens: reported.inputTokens ?? promptAllowance, outputTokens: reported.outputTokens ?? 0 };
        if (this.usage.inputTokens + this.usage.outputTokens + current.inputTokens + current.outputTokens > (this.budget.maxTokens ?? Infinity)
          || this.estimatedCostUsd + (estimateCost(current, request.model, this.rates) ?? 0) > (this.budget.maxCostUsd ?? Infinity)) {
          throw new MissionBudgetError("Mission model usage exceeded the admitted budget; further execution stopped");
        }
      }
    } finally {
      this.reservedTokens -= reservation;
      this.reservedCost -= costReservation;
      const charged = { inputTokens: reported.inputTokens ?? promptAllowance, outputTokens: reported.outputTokens ?? outputAllowance };
      this.usage.inputTokens += charged.inputTokens;
      this.usage.outputTokens += charged.outputTokens;
      this.estimatedCostUsd += estimateCost(charged, request.model, this.rates) ?? 0;
    }
  }
}

export function missionDeadline(parent: AbortSignal, durationMs?: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = durationMs !== undefined && Number.isFinite(durationMs)
    ? setTimeout(() => controller.abort(new Error("Mission duration budget exhausted")), Math.max(0, durationMs))
    : undefined;
  if (durationMs !== undefined && durationMs <= 0) controller.abort(new Error("Mission duration budget exhausted"));
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}