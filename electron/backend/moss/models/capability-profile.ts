// electron/backend/moss/models/capability-profile.ts
//
// Turns probe measurements into a capability profile: a weighted score, a tier,
// and scaffolding recommendations expressed in settings Moss already has. The
// recommendations never touch approval or authority settings.

import type {
  CapabilityDimension,
  CapabilityProbeResult,
  ModelCapabilityProfile,
  ModelCapabilityTier,
  ModelScaffoldingRecommendation,
  ProviderKind,
} from "../../../../common/types";
import { PROBE_SUITE_VERSION, TOOLS_UNSUPPORTED_NOTE } from "./capability-probes";

export const DIMENSION_WEIGHTS: Record<CapabilityDimension, number> = {
  "tool-calling": 0.2,
  "tool-selection": 0.15,
  "tool-restraint": 0.1,
  "structured-output": 0.15,
  "instruction-following": 0.15,
  "usable-context": 0.1,
  "plan-coherence": 0.15,
};

/** Endpoint origin and path with credentials, query, and fragment removed. */
export function endpointLabel(baseUrl: string): string {
  const value = typeof baseUrl === "string" ? baseUrl : "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

export function profileKey(kind: ProviderKind, baseUrl: string, model: string): string {
  return `${kind}|${endpointLabel(baseUrl).toLowerCase()}|${model}`;
}

function byDimension(results: readonly CapabilityProbeResult[]): Partial<Record<CapabilityDimension, CapabilityProbeResult>> {
  return Object.fromEntries(results.map((result) => [result.dimension, result]));
}

/** A dimension whose every request failed or timed out was not measured. */
export function isMeasured(result: CapabilityProbeResult): boolean {
  return result.metrics?.completed === undefined || result.metrics.completed > 0;
}

export function overallScore(results: readonly CapabilityProbeResult[]): number {
  const measured = results.filter(isMeasured);
  const weight = measured.reduce((sum, result) => sum + DIMENSION_WEIGHTS[result.dimension], 0);
  if (!weight) return 0;
  const score = measured.reduce((sum, result) => sum + result.score * DIMENSION_WEIGHTS[result.dimension], 0) / weight;
  return Math.round(score * 1000) / 1000;
}

export function capabilityTier(results: readonly CapabilityProbeResult[]): ModelCapabilityTier {
  const overall = overallScore(results);
  const dims = byDimension(results.filter(isMeasured));
  const plan = dims["plan-coherence"]?.score ?? 1;
  const tools = dims["tool-calling"]?.score ?? 1;
  // A profile with unmeasured dimensions cannot vouch for strong performance.
  const complete = results.every(isMeasured);
  if (complete && overall >= 0.85 && plan >= 0.66 && tools >= 0.66) return "strong";
  if (overall >= 0.65) return "capable";
  if (overall >= 0.4) return "limited";
  return "unreliable";
}

function isLocalOllama(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.port === "11434" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function recommendScaffolding(
  results: readonly CapabilityProbeResult[],
  baseUrl: string,
  maxContextTested: number,
): ModelScaffoldingRecommendation {
  const dims = byDimension(results.filter(isMeasured));
  const tier = capabilityTier(results);
  const notes: string[] = [];
  const failed = results.reduce((sum, result) => sum + (result.metrics?.errors ?? 0), 0);
  const attempted = Math.max(failed, results.reduce((sum, result) => sum + result.total, 0));
  if (failed > 0) {
    const unmeasured = results.filter((result) => !isMeasured(result)).map((result) => result.dimension);
    notes.push(`${failed} of ${attempted} probe requests failed or timed out, so scores cover completed requests only${unmeasured.length ? ` and ${unmeasured.join(", ")} could not be measured` : ""}. If the model is slow, re-run with a longer timeout.`);
  }
  const settings: ModelScaffoldingRecommendation["settings"] = {};

  const toolScores = [dims["tool-calling"], dims["tool-selection"]].filter((item): item is CapabilityProbeResult => !!item);
  const toolScore = toolScores.length ? toolScores.reduce((sum, item) => sum + item.score, 0) / toolScores.length : undefined;
  const restraint = dims["tool-restraint"]?.score;
  const toolUse: ModelScaffoldingRecommendation["toolUse"] = toolScore === undefined
    ? "supervised"
    : toolScore >= 0.85 && (restraint ?? 1) >= 0.5 ? "reliable" : toolScore >= 0.5 ? "supervised" : "avoid";
  const toolsUnsupported = ["tool-calling", "tool-selection", "tool-restraint", "plan-coherence"]
    .reduce((sum, dimension) => sum + (dims[dimension as CapabilityDimension]?.metrics?.toolsUnsupported ?? 0), 0);
  if (toolUse === "avoid") {
    settings.enableTools = false;
    notes.push(toolsUnsupported > 0
      ? "The server reports that this model does not support tools. Use it for chat only, or choose a model build with tool support."
      : "Tool calls failed most probes. Use it for chat only, or pair it with a model that handles tools.");
  }
  const textToolCalls = (dims["tool-calling"]?.metrics?.textToolCalls ?? 0) + (dims["tool-selection"]?.metrics?.textToolCalls ?? 0);
  if (textToolCalls > 0) {
    notes.push("It wrote tool calls as text instead of using native function calling. The server may need a tool-call parser or a model build with a tool template.");
  }
  if (restraint !== undefined && restraint < 1 && !toolsUnsupported) {
    notes.push("It called tools when none were needed. Expect extra rounds and approval prompts.");
  }

  const structured = dims["structured-output"];
  const structuredOutput: ModelScaffoldingRecommendation["structuredOutput"] = structured && structured.score < 0.9 ? "repair" : "direct";
  if (structured && (structured.metrics?.lenientOnly ?? 0) > 0) {
    notes.push("It wrapped JSON in prose or code fences. Parse leniently or use a constrained JSON mode.");
  } else if (structured && structured.score < 0.5) {
    notes.push("Its structured output was often invalid or incomplete. Validate JSON before relying on it.");
  }

  const instruction = dims["instruction-following"];
  if (instruction?.trials.some((item) => item.id === "system-suffix" && !item.passed && !item.errored)) {
    notes.push("It ignored a system-prompt rule. Repeat important constraints in the task itself.");
  }

  const context = dims["usable-context"];
  const usableContextTokens = context?.metrics?.usableContextTokens || undefined;
  if (context) {
    const allPassed = context.metrics?.allPassed === 1;
    const ceilingAt = context.metrics?.truncatedAt ?? context.metrics?.recallFailedAt;
    // Only a measured failure establishes a ceiling; passing every size is a lower bound.
    if (usableContextTokens && ceilingAt) settings.contextLimit = Math.floor(usableContextTokens / 1_024) * 1_024 || usableContextTokens;
    if (context.metrics?.truncatedAt) {
      notes.push(`The provider truncated prompts near ${context.metrics.truncatedAt.toLocaleString("en-US")} tokens.`);
    }
    if (isLocalOllama(baseUrl) && ceilingAt && ceilingAt <= 8_192) {
      notes.push("Ollama uses its default context length unless you raise it, for example with OLLAMA_CONTEXT_LENGTH or num_ctx in a Modelfile.");
    }
    if (allPassed) {
      notes.push(`It passed every tested size up to about ${maxContextTested.toLocaleString("en-US")} tokens; its real window may be larger.`);
    }
  }

  const plan = dims["plan-coherence"];
  const maxCoherentSteps = plan?.metrics?.maxCoherentSteps;
  if (plan) {
    settings.maxToolRounds = tier === "strong" ? 24 : Math.min(16, Math.max(4, (maxCoherentSteps ?? 0) * 2 + 2));
    if (!maxCoherentSteps) {
      if (!toolsUnsupported) notes.push("It could not finish a short multi-step tool chain. Keep tasks to one or two tool calls.");
    }
    else if (tier !== "strong") notes.push(`It stayed coherent for ${maxCoherentSteps} sequential tool calls. Break larger work into smaller missions.`);
  }

  return {
    scaffolding: tier === "strong" ? "light" : tier === "capable" ? "moderate" : "heavy",
    toolUse,
    structuredOutput,
    ...(usableContextTokens ? { usableContextTokens } : {}),
    ...(maxCoherentSteps !== undefined ? { maxCoherentSteps } : {}),
    settings,
    notes,
  };
}

export interface BuildProfileInput {
  providerKind: ProviderKind;
  baseUrl: string;
  model: string;
  results: CapabilityProbeResult[];
  startedAt: number;
  finishedAt: number;
  maxContextTested: number;
  warmupMs?: number;
}

const LATENCY_DIMENSIONS: readonly CapabilityDimension[] = ["tool-calling", "tool-selection", "tool-restraint", "structured-output", "instruction-following"];

export function latencySummary(results: readonly CapabilityProbeResult[]): { medianMs: number; p90Ms: number } | undefined {
  const durations = results
    .filter((result) => LATENCY_DIMENSIONS.includes(result.dimension))
    .flatMap((result) => result.trials.filter((item) => !item.errored && item.note !== TOOLS_UNSUPPORTED_NOTE).map((item) => item.durationMs))
    .sort((a, b) => a - b);
  if (durations.length === 0) return undefined;
  const at = (fraction: number): number => durations[Math.min(durations.length - 1, Math.floor(fraction * durations.length))];
  return { medianMs: at(0.5), p90Ms: at(0.9) };
}

export function buildCapabilityProfile(input: BuildProfileInput): ModelCapabilityProfile {
  const inputTokens = input.results.flatMap((result) => result.trials).reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const outputTokens = input.results.flatMap((result) => result.trials).reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const latency = latencySummary(input.results);
  const recommendation = recommendScaffolding(input.results, input.baseUrl, input.maxContextTested);
  if (latency && latency.medianMs > 20_000) {
    recommendation.notes.push(`Its median response took ${Math.round(latency.medianMs / 1000)}s, which will feel slow for interactive work. Consider a faster model for quick subtasks.`);
  }
  return {
    schemaVersion: 1,
    suiteVersion: PROBE_SUITE_VERSION,
    providerKind: input.providerKind,
    endpoint: endpointLabel(input.baseUrl),
    model: input.model,
    probedAt: new Date(input.finishedAt).toISOString(),
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    maxContextTested: input.maxContextTested,
    results: input.results,
    overall: overallScore(input.results),
    tier: capabilityTier(input.results),
    usage: { inputTokens, outputTokens },
    ...(latency ? { latency } : {}),
    failedRequests: input.results.reduce((sum, result) => sum + (result.metrics?.errors ?? 0), 0),
    ...(input.warmupMs !== undefined ? { warmupMs: input.warmupMs } : {}),
    recommendation,
  };
}
