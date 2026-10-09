// electron/backend/moss/models/scaffolding.ts
//
// Adjustable scaffolding. A measured capability profile decides how much
// structure a turn gets: strong models keep every tool and no extra guidance;
// weaker models get a narrower, task-relevant tool list, explicit step-by-step
// instructions, and one tool call per round. Without a profile nothing changes,
// so the default path never rests on a guess about the model.

import type { AgentMessage, ModelCapabilityProfile, ToolDefinition } from "../../../../common/types";

export interface ScaffoldingDecision {
  level: "none" | "light" | "moderate" | "heavy";
  tools: ToolDefinition[];
  /** extra system guidance for this turn */
  systemGuidance?: string;
  /** constraint reminder appended to the model-facing copy of the latest user message */
  userReminder?: string;
  maxToolCallsPerRound?: number;
  /** user-visible explanation of what changed */
  notice?: string;
}

const LIMITS = { moderate: 24, heavy: 8 } as const;
const CORE_TOOLS = new Set(["read_file", "list_dir", "search_files", "glob_files", "edit_file", "write_file", "run_command", "plan"]);
/** Kept in any narrowed list of 8 or more: without them a model cannot read,
 *  change, or test code, whatever words the request happens to use (a request
 *  to "fix the build" otherwise lost edit_file to working_state). */
export const PINNED_TOOLS = ["read_file", "edit_file", "run_command"] as const;
const pinsFor = (limit: number): readonly string[] => (limit >= 8 ? PINNED_TOOLS : []);
/** Housekeeping and specialist tools rank below everything else unless the request names them. */
const LOW_PRIORITY = /^(?:m_|transcribe_audio$|view_image$|delegate$|send_email$|jev_evaluate$)/;
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "what", "please", "can", "you", "use", "all", "any", "are", "then", "file", "files"]);

const MODERATE_GUIDANCE = [
  "Scaffolding for this model:",
  "- Work in small, verified steps. Prefer one tool call at a time and check each result before the next.",
  "- Use only the tools provided, with argument names exactly as their schemas define.",
].join("\n");

const HEAVY_GUIDANCE = [
  "Scaffolding for this model:",
  "- Before using tools, write a numbered plan of at most five steps (use the plan tool when it is available).",
  "- Execute exactly one step per response, with at most one tool call.",
  "- After each tool result, say whether the step succeeded before starting the next one.",
  "- Use only the tools provided, with argument names exactly as their schemas define. Never guess file contents or values; read them.",
  "- If a step fails twice, stop and explain what is blocking you instead of repeating it.",
].join("\n");

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/** Keep the `limit` most relevant tools for the request: core workspace tools
 *  get a small head start, and tools whose name or description share words with
 *  the request rank above the rest. Ties keep the registry order. */
export function selectRelevantTools(tools: readonly ToolDefinition[], query: string, limit: number): ToolDefinition[] {
  return selectByScore(tools, relevanceScores(tools, query), limit, pinsFor(limit));
}

/** Word relevance per tool: core workspace tools get a small head start,
 *  housekeeping tools start below zero, and shared words add to the score. */
export function relevanceScores(tools: readonly ToolDefinition[], query: string): number[] {
  const queryWords = new Set(words(query));
  return tools.map((tool) => {
    const nameWords = tool.name.toLowerCase().split(/[_-]+/);
    const descriptionWords = new Set(words(tool.description));
    let score = CORE_TOOLS.has(tool.name) ? 1 : LOW_PRIORITY.test(tool.name) ? -1 : 0;
    for (const word of queryWords) {
      if (nameWords.some((part) => part.length >= 3 && (part === word || part.startsWith(word) || word.startsWith(part)))) score += 3;
      else if (descriptionWords.has(word)) score += 1;
    }
    if (query.toLowerCase().includes(tool.name.toLowerCase())) score += 5;
    return score;
  });
}

/** Keep the `limit` highest-scoring tools in registry order; ties keep the
 *  registry order. `pinned` tools that are present are kept first. */
export function selectByScore(tools: readonly ToolDefinition[], scores: readonly number[], limit: number, pinned: readonly string[] = []): ToolDefinition[] {
  if (tools.length <= limit) return [...tools];
  const keep = new Set(pinned.filter((name) => tools.some((tool) => tool.name === name)).slice(0, limit));
  for (const item of tools.map((tool, index) => ({ tool, index, score: scores[index] ?? 0 })).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (keep.size >= limit) break;
    keep.add(item.tool.name);
  }
  return tools.filter((tool) => keep.has(tool.name));
}

export function planScaffolding(
  profile: ModelCapabilityProfile | null | undefined,
  tools: readonly ToolDefinition[],
  query: string,
): ScaffoldingDecision {
  // Scaffolding shapes tool use; a tool-less turn has nothing to adapt.
  if (!profile || tools.length === 0) return { level: "none", tools: [...tools] };
  const recommendation = profile.recommendation;
  const ignoresSystem = profile.results.some((result) =>
    result.dimension === "instruction-following" && result.trials.some((item) => item.id === "system-suffix" && !item.passed && !item.errored));
  // OpenAI-compatible models with weak native tool calling are carried by the
  // constrained step protocol instead, so the warning applies elsewhere.
  const toolWarning = recommendation.toolUse === "avoid" && tools.length > 0 && profile.providerKind !== "openai-compatible"
    ? ` Its measured tool calling is unreliable (${profile.tier}); consider Chat only for this model.`
    : "";

  if (recommendation.scaffolding === "light") {
    return {
      level: "light",
      tools: [...tools],
      ...(toolWarning ? { notice: `Using ${profile.model}'s capability profile.${toolWarning}` } : {}),
    };
  }

  const heavy = recommendation.scaffolding === "heavy";
  const limit = heavy ? LIMITS.heavy : LIMITS.moderate;
  const selected = tools.length > 0 ? selectRelevantTools(tools, query, limit) : [];
  const trimmed = tools.length - selected.length;
  const guidance = heavy ? HEAVY_GUIDANCE : MODERATE_GUIDANCE;
  const parts = [
    `Adapted to ${profile.model}'s measured profile (${profile.tier}):`,
    heavy ? "step-by-step guidance, one tool call per round" : "small verified steps",
    ...(trimmed > 0 ? [`${selected.length} of ${tools.length} tools offered`] : []),
  ];
  return {
    level: heavy ? "heavy" : "moderate",
    tools: selected,
    ...(tools.length > 0 ? { systemGuidance: guidance } : {}),
    ...(ignoresSystem && tools.length > 0 ? { userReminder: heavy ? "Reminder: one step and at most one tool call per response; use exact argument names." : "Reminder: use exact tool argument names and check each result." } : {}),
    ...(heavy && tools.length > 0 ? { maxToolCallsPerRound: 1 } : {}),
    notice: `${parts[0]} ${parts.slice(1).join(", ")}.${toolWarning}`,
  };
}

/** Apply the decision to a turn's model-facing messages without touching the
 *  persisted conversation: guidance extends the system message, and the
 *  reminder extends a copy of the latest user message. */
export function applyScaffoldingMessages(messages: readonly AgentMessage[], decision: ScaffoldingDecision): AgentMessage[] {
  if (!decision.systemGuidance && !decision.userReminder) return [...messages];
  const next = [...messages];
  const userIndex = next.map((message) => message.role).lastIndexOf("user");
  if (decision.userReminder && userIndex >= 0) {
    next[userIndex] = { ...next[userIndex], content: `${next[userIndex].content}\n\n(${decision.userReminder})` };
  }
  if (decision.systemGuidance) {
    const systemIndex = next.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      next[systemIndex] = { ...next[systemIndex], content: `${next[systemIndex].content}\n\n${decision.systemGuidance}` };
    } else {
      next.unshift({ role: "system", content: decision.systemGuidance });
    }
  }
  return next;
}
