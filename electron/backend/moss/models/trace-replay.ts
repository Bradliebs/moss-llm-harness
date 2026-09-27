// electron/backend/moss/models/trace-replay.ts
//
// Counterfactual replay. Each recorded model call is sent, with exactly the
// context the original model saw, to a candidate model, and the two decisions
// are compared: which tool was chosen, whether the arguments fit the schema,
// and whether the model answered or kept working. No tool is executed, so a
// replay can never change the workspace; it measures decisions, not outcomes.

import type { ReplayAgreement, ReplayCallResult, ReplayReport, TurnTrace } from "../../../../common/types";
import type { ChatProvider } from "../providers/types";
import { complete, parseArguments, visibleText, warmUp } from "./capability-probes";

export interface ReplayOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  onProgress?: (completed: number, total: number) => void;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function agreementOf(baselineTools: string[], candidateTools: string[], error?: string): ReplayAgreement {
  if (error) return "error";
  if (baselineTools.length === 0) return candidateTools.length === 0 ? "same-action" : "called-tool-instead";
  if (candidateTools.length === 0) return "answered-instead";
  return baselineTools[0] === candidateTools[0] ? "same-action" : "different-tool";
}

export async function replayTrace(trace: TurnTrace, provider: ChatProvider, candidateModel: string, options: ReplayOptions): Promise<ReplayReport> {
  const toolsByName = new Map(trace.tools.map((tool) => [tool.name, tool]));
  const replayable = trace.calls.filter((call) => !call.error);
  const ctx = { provider, model: candidateModel, signal: options.signal, ...(options.now ? { now: options.now } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
  // Load the candidate before timing it; an unavailable model fails the replay
  // outright instead of producing a row of timeouts.
  options.onProgress?.(0, replayable.length);
  await warmUp(ctx);
  const results: ReplayCallResult[] = [];
  let inputTokens = 0;
  for (const [position, call] of replayable.entries()) {
    options.onProgress?.(position, replayable.length);
    const tools = call.request.toolNames.map((name) => toolsByName.get(name)).filter((tool): tool is NonNullable<typeof tool> => !!tool);
    const completion = await complete(ctx, call.request.messages, tools);
    inputTokens += completion.inputTokens ?? 0;
    const candidateTools = completion.toolCalls.map((toolCall) => toolCall.name);
    const unknownArguments: string[] = [];
    let validArguments = true;
    for (const toolCall of completion.toolCalls) {
      const args = parseArguments(toolCall.arguments);
      const properties = Object.keys((toolsByName.get(toolCall.name)?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
      if (!args || !toolsByName.has(toolCall.name)) validArguments = false;
      else for (const key of Object.keys(args)) if (properties.length && !properties.includes(key)) unknownArguments.push(`${toolCall.name}.${key}`);
    }
    if (unknownArguments.length) validArguments = false;
    const baselineTools = call.response.toolCalls.map((toolCall) => toolCall.name);
    results.push({
      index: call.index,
      baseline: { toolNames: baselineTools, answered: baselineTools.length === 0 },
      candidate: {
        toolNames: candidateTools,
        answered: !completion.error && candidateTools.length === 0,
        validArguments: !completion.error && validArguments,
        unknownArguments,
        text: visibleText(completion.text).slice(0, 400),
        durationMs: completion.durationMs,
        ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {}),
        ...(completion.error ? { error: completion.error } : {}),
      },
      agreement: agreementOf(baselineTools, candidateTools, completion.error),
    });
  }
  options.onProgress?.(replayable.length, replayable.length);
  const completed = results.filter((result) => !result.candidate.error);
  const withTools = completed.filter((result) => result.candidate.toolNames.length > 0);
  const sameAction = results.filter((result) => result.agreement === "same-action").length;
  return {
    schemaVersion: 1,
    traceId: trace.id,
    baselineModel: trace.escalatedTo ? `${trace.primaryModel} → ${trace.escalatedTo}` : trace.primaryModel,
    candidateModel,
    ...(trace.outcome ? { baselineOutcome: trace.outcome } : {}),
    replayedAt: new Date((options.now ?? Date.now)()).toISOString(),
    calls: results,
    summary: {
      calls: results.length,
      sameAction,
      agreementRate: completed.length ? Math.round((sameAction / completed.length) * 1000) / 1000 : 0,
      validArgumentRate: withTools.length ? Math.round((withTools.filter((result) => result.candidate.validArguments).length / withTools.length) * 1000) / 1000 : 1,
      errors: results.length - completed.length,
      ...(median(completed.map((result) => result.candidate.durationMs)) !== undefined ? { medianLatencyMs: median(completed.map((result) => result.candidate.durationMs)) } : {}),
      ...(median(replayable.map((call) => call.durationMs)) !== undefined ? { baselineMedianLatencyMs: median(replayable.map((call) => call.durationMs)) } : {}),
      inputTokens,
      outputTokens: results.reduce((sum, result) => sum + (result.candidate.outputTokens ?? 0), 0),
    },
  };
}
