// common/live-scores.ts
//
// Live scores from host evidence, shared by the harness and the Settings UI.
// Only harness outcomes (verification, task state, rejections, stalls) grade a
// turn; the probe tier moves by at most one step once enough outcomes exist.

import type {
  ModelCapabilityProfile,
  ModelCapabilityTier,
  ModelLiveScore,
  ModelPerformanceEntry,
  ModelTaskKind,
  ProviderKind,
} from "./types";

function endpointKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return baseUrl.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

/** Same identity as a capability profile: provider kind, endpoint, model. */
export function modelKey(kind: ProviderKind | string, baseUrl: string, model: string): string {
  return `${kind}|${endpointKey(baseUrl)}|${model}`;
}

/** Graded outcomes needed before live evidence may move the tier. */
export const MIN_GRADED_FOR_TIER = 10;
const PRACTICE_WEIGHT = 0.5;
const Z = 1.96;

const TIERS: readonly ModelCapabilityTier[] = ["unreliable", "limited", "capable", "strong"];

const CODING_TOOLS = /^(?:write_file|edit_file|move_file|run_command|git_status|git_diff)$/;
const RESEARCH_TOOLS = /^(?:web_search|fetch_url|browser_)/;
const AUTOMATION_TOOLS = /^desktop_/;

export function taskKindFor(toolNames: Iterable<string>, mission: boolean): ModelTaskKind {
  if (mission) return "mission";
  const names = [...toolNames];
  if (names.some((name) => CODING_TOOLS.test(name))) return "coding";
  if (names.some((name) => AUTOMATION_TOOLS.test(name))) return "automation";
  if (names.some((name) => RESEARCH_TOOLS.test(name))) return "research";
  return "chat";
}

export interface TurnEvidence {
  terminal: "turn-complete" | "turn-aborted" | "turn-error";
  terminalMessage?: string;
  taskState?: string;
  lastVerificationOk?: boolean;
  supervisorStopped: boolean;
}

/** Graded outcome of a turn from host evidence alone, or undefined when the
 *  turn says nothing about the model (aborted, provider outage, plain chat). */
export function gradeTurn(evidence: TurnEvidence): "s" | "f" | undefined {
  if (evidence.terminal === "turn-aborted") return undefined;
  if (evidence.taskState === "completed") return "s";
  if (evidence.taskState === "blocked" || evidence.taskState === "failed") return "f";
  if (evidence.supervisorStopped) return "f";
  if (evidence.lastVerificationOk === false) return "f";
  if (evidence.terminal === "turn-error") {
    // Round caps and empty completions are the model's; outages are not.
    return /^Stopped after \d+ tool rounds|empty response/i.test(evidence.terminalMessage ?? "") ? "f" : undefined;
  }
  return evidence.lastVerificationOk === true ? "s" : undefined;
}

export function wilson(successes: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const denominator = 1 + (Z * Z) / n;
  const center = p + (Z * Z) / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { lower: Math.max(0, (center - margin) / denominator), upper: Math.min(1, (center + margin) / denominator) };
}

/** Combine entries (one kind, or all kinds) into a live score. */
export function liveScore(entries: readonly ModelPerformanceEntry[], kind: ModelTaskKind | "all", probeTier?: ModelCapabilityTier): ModelLiveScore {
  const selected = kind === "all" ? entries : entries.filter((entry) => entry.kind === kind);
  const count = (list: Array<"s" | "f">, value: "s" | "f"): number => list.filter((item) => item === value).length;
  const successes = selected.reduce((sum, entry) => sum + count(entry.recent, "s") + PRACTICE_WEIGHT * count(entry.practice, "s"), 0);
  const graded = selected.reduce((sum, entry) => sum + entry.recent.length + PRACTICE_WEIGHT * entry.practice.length, 0);
  const runs = selected.reduce((sum, entry) => sum + entry.runs, 0);
  if (graded === 0) return { kind, runs, graded: 0, ...(probeTier ? { effectiveTier: probeTier } : {}) };
  const bounds = wilson(successes, graded);
  return {
    kind,
    runs,
    graded,
    successRate: successes / graded,
    lowerBound: bounds.lower,
    upperBound: bounds.upper,
    ...(probeTier ? { effectiveTier: adjustTier(probeTier, graded, bounds) } : {}),
  };
}

/** Move the probe tier one step when the evidence is clear: up when even the
 *  pessimistic success rate is high, down when even the optimistic one is low. */
export function adjustTier(tier: ModelCapabilityTier, graded: number, bounds: { lower: number; upper: number }): ModelCapabilityTier {
  if (graded < MIN_GRADED_FOR_TIER) return tier;
  const index = TIERS.indexOf(tier);
  if (bounds.lower >= 0.75 && index < TIERS.length - 1) return TIERS[index + 1];
  if (bounds.upper <= 0.45 && index > 0) return TIERS[index - 1];
  return tier;
}

const SCAFFOLDING_FOR: Record<ModelCapabilityTier, ModelCapabilityProfile["recommendation"]["scaffolding"]> = {
  strong: "light",
  capable: "moderate",
  limited: "heavy",
  unreliable: "heavy",
};

/** The profile as the harness should treat it, given live evidence for this kind of task. */
export function effectiveProfile(profile: ModelCapabilityProfile, entries: readonly ModelPerformanceEntry[], kind: ModelTaskKind | "all"): { profile: ModelCapabilityProfile; score: ModelLiveScore } {
  const own = entries.filter((entry) => modelKey(entry.providerKind, entry.endpoint, entry.model) === modelKey(profile.providerKind, profile.endpoint, profile.model));
  const specific = liveScore(own, kind, profile.tier);
  // Too few runs of this kind: fall back to all of this model's work.
  const score = specific.graded >= MIN_GRADED_FOR_TIER || kind === "all" ? specific : liveScore(own, "all", profile.tier);
  const tier = score.effectiveTier ?? profile.tier;
  if (tier === profile.tier) return { profile, score };
  return {
    profile: { ...profile, tier, recommendation: { ...profile.recommendation, scaffolding: SCAFFOLDING_FOR[tier] } },
    score,
  };
}

