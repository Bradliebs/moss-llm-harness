// electron/backend/moss/models/trace-replay.ts
//
// Counterfactual replay. Each recorded model call is sent, with exactly the
// context the original model saw, to a candidate model, and the two decisions
// are compared: which tool was chosen, whether the arguments fit the schema,
// and whether the model answered or kept working. No tool is executed, so a
// replay can never change the workspace; it measures decisions, not outcomes.
// With a judge, steps where the candidate differs are also rated for whether
// they were reasonable, so a different but valid choice is not counted wrong.

import type { ReplayAgreement, ReplayCallResult, ReplayReport, TurnTrace } from "../../../../common/types";
import type { ChatProvider } from "../providers/types";
import { complete, parseArguments, visibleText, warmUp } from "./capability-probes";
import { judgeIndependence, type ReplayJudge } from "./replay-judge";

export interface ReplayOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  onProgress?: (completed: number, total: number) => void;
  /** rates differing steps; must be independent of the candidate and original models */
  judge?: { model: string; judge: ReplayJudge };
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
  const originals = [trace.primaryModel, ...(trace.escalatedTo ? [trace.escalatedTo] : []), ...trace.calls.map((call) => call.model)];
  const independence = options.judge ? judgeIndependence(options.judge.model, [candidateModel, ...new Set(originals)]) : undefined;
  const judge = independence?.ok ? options.judge!.judge : undefined;
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
    const agreement = agreementOf(baselineTools, candidateTools, completion.error);
    const judgement = judge && agreement !== "same-action" && agreement !== "error"
      ? await judge({
          messages: call.request.messages,
          tools,
          baseline: { toolCalls: call.response.toolCalls, text: call.response.text },
          candidate: { toolCalls: completion.toolCalls, text: visibleText(completion.text) },
        }, options.signal)
      : undefined;
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
      agreement,
      ...(judgement ? { judgement } : {}),
    });
  }
  options.onProgress?.(replayable.length, replayable.length);
  const completed = results.filter((result) => !result.candidate.error);
  const withTools = completed.filter((result) => result.candidate.toolNames.length > 0);
  const sameAction = results.filter((result) => result.agreement === "same-action").length;
  const judged = results.filter((result) => result.judgement);
  const acceptable = sameAction + judged.filter((result) => result.judgement!.candidateReasonable).length;
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
      ...(judge ? {
        judged: judged.length,
        acceptable,
        acceptableRate: completed.length ? Math.round((acceptable / completed.length) * 1000) / 1000 : 0,
        better: judged.filter((result) => result.judgement!.comparison === "better").length,
      } : {}),
    },
    ...(judge ? { judgeModel: options.judge!.model } : {}),
    ...(independence && !independence.ok ? { judgeSkipped: independence.reason } : {}),
  };
}
