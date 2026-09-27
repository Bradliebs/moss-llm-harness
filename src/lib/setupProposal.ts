// src/lib/setupProposal.ts
//
// Turns what the PC can run into a reviewable setup: the best local chat model
// that fits the GPU, a fast model, an escalation route, embeddings for ranking
// by meaning, background profiling, and a context-window check. Every item can
// be unticked; approval and authority settings are never part of it.

import { liveScore, modelKey } from "@common/live-scores";
import type { ModelCapabilityProfile, ModelCapabilityTier, ModelPerformanceEntry, ModelRoute, SetupDetection } from "@common/types";

import type { MossSettings } from "./settings";

export type SetupAction =
  | { type: "pull"; model: string }
  | { type: "probe"; model: string }
  | { type: "context"; model: string };

export interface SetupItem {
  id: "chat" | "fast" | "escalation" | "embeddings" | "profile" | "context";
  title: string;
  detail: string;
  /** ticked by default */
  recommended: boolean;
  /** switch to the Ollama preset before applying the patch */
  useOllamaPreset?: boolean;
  patch?: Partial<MossSettings>;
  actions?: SetupAction[];
}

export interface SetupProposal {
  items: SetupItem[];
  /** why nothing could be proposed, when items is empty */
  summary: string;
}

type LocalModel = { name: string; sizeBytes: number; paramsB?: number };

const TIER_RANK: Record<ModelCapabilityTier, number> = { unreliable: 0, limited: 1, capable: 2, strong: 3 };
const EMBEDDING_MODEL = "nomic-embed-text";
const OVERHEAD_MIB = 450;
const CONTEXT_ROOM_MIB = 1_024;
const CLOUD_ORDER = ["anthropic", "openai", "openrouter", "mistral", "xai"];
const OLLAMA_CLOUD_ORDER = [/^glm-/, /^kimi-/, /^qwen3-coder/, /^gpt-oss/, /^deepseek/, /^nemotron/];

export function isCloudModel(name: string): boolean {
  return /[:-]cloud$/i.test(name);
}

export function isEmbeddingModel(name: string, family?: string): boolean {
  return /embed|bge-|minilm/i.test(name) || /bert/i.test(family ?? "");
}

function parameterBillions(value: string | undefined, sizeBytes: number): number | undefined {
  const match = value?.match(/([\d.]+)\s*([BM])/i);
  if (match) return Number(match[1]) / (match[2].toUpperCase() === "M" ? 1000 : 1);
  // Roughly 4.5 bits per weight at common quantizations.
  return sizeBytes > 0 ? sizeBytes / (0.56 * 1e9) : undefined;
}

/** Tier for ranking: measured and live-adjusted when profiled, otherwise a size estimate. */
function estimatedTier(model: LocalModel, profile: ModelCapabilityProfile | undefined, entries: readonly ModelPerformanceEntry[]): { tier: ModelCapabilityTier; measured: boolean } {
  if (profile) return { tier: liveScore(entries, "all", profile.tier).effectiveTier ?? profile.tier, measured: true };
  const params = model.paramsB ?? 0;
  return { tier: params >= 7 ? "capable" : params >= 3 ? "limited" : "unreliable", measured: false };
}

/** Local models chosen for the fast or escalation role live on Ollama. When the
 *  chat model stays on another provider, they must be explicit Ollama routes,
 *  or the router would ask the chat provider for a model it does not have. */
export function patchForProvider(patch: Partial<MossSettings>, chatOnOllama: boolean, ollamaBaseUrl: string): Partial<MossSettings> {
  if (chatOnOllama) return patch;
  const route = (model: string): ModelRoute => ({ presetId: "ollama", kind: "openai-compatible", baseUrl: ollamaBaseUrl, model });
  const next = { ...patch };
  if (typeof patch.fastModel === "string") {
    next.fastRoute = route(patch.fastModel);
    next.fastModel = undefined;
  }
  if (typeof patch.escalationModel === "string") {
    next.escalationRoute = route(patch.escalationModel);
    next.escalationModel = undefined;
  }
  return next;
}

export function buildSetupProposal(input: {
  detection: SetupDetection;
  profiles: readonly ModelCapabilityProfile[];
  performance: readonly ModelPerformanceEntry[];
  settings: MossSettings;
  ollamaBaseUrl: string;
  currentPresetId?: string;
}): SetupProposal {
  const { detection, settings } = input;
  const items: SetupItem[] = [];
  const baseUrl = detection.ollama?.baseUrl ?? input.ollamaBaseUrl;
  const profileOf = (name: string) => input.profiles.find((profile) => modelKey(profile.providerKind, profile.endpoint, profile.model) === modelKey("openai-compatible", baseUrl, name));
  const entriesOf = (name: string) => input.performance.filter((entry) => modelKey(entry.providerKind, entry.endpoint, entry.model) === modelKey("openai-compatible", baseUrl, name));
  const installed = detection.ollama?.models ?? [];
  // Weights must leave free GPU memory for runtime overhead and an 8K-token
  // cache, or the model spills to the CPU.
  const budgetBytes = detection.gpu ? Math.max(0, detection.gpu.freeMiB * 0.92 - OVERHEAD_MIB - CONTEXT_ROOM_MIB) * 1024 * 1024 : Infinity;
  const local: LocalModel[] = installed
    .filter((model) => !isCloudModel(model.name) && !isEmbeddingModel(model.name, model.family) && model.sizeBytes > 50 * 1024 * 1024)
    .map((model) => ({ name: model.name, sizeBytes: model.sizeBytes, paramsB: parameterBillions(model.parameterSize, model.sizeBytes) }));
  const fitting = local.filter((model) => model.sizeBytes <= budgetBytes);
  const ranked = fitting
    .map((model) => ({ model, ...estimatedTier(model, profileOf(model.name), entriesOf(model.name)) }))
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || Number(b.measured) - Number(a.measured) || (b.model.paramsB ?? 0) - (a.model.paramsB ?? 0));

  if (!detection.ollama) {
    return {
      items: [],
      summary: "Ollama is not running on this PC. Install it from ollama.com, pull a model such as qwen2.5:7b, then check again. Cloud providers still work under Provider.",
    };
  }
  const chat = ranked[0];
  const onOllama = input.currentPresetId === "ollama";
  if (chat) {
    const gb = (chat.model.sizeBytes / 1e9).toFixed(1);
    items.push({
      id: "chat",
      title: `Chat model: ${chat.model.name}`,
      detail: `${chat.measured ? `Profiled ${chat.tier}` : `Estimated ${chat.tier} from its size`} · ${gb} GB${detection.gpu ? `, fits your ${detection.gpu.name ?? "GPU"}` : ""}. Runs on this PC.`,
      // Switching away from a provider you already use is your call.
      recommended: onOllama || !settings.model,
      useOllamaPreset: true,
      patch: { model: chat.model.name },
    });
  }
  const chatName = chat?.model.name ?? (onOllama ? settings.model : "");
  // Work on the proposed chat model only makes sense when it is adopted by default.
  const chatAdopted = items.find((item) => item.id === "chat")?.recommended ?? true;
  const fast = [...fitting]
    .filter((model) => model.name !== chatName && (model.paramsB ?? 0) >= 1)
    .sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  if (fast && chat && fast.sizeBytes < chat.model.sizeBytes * 0.6) {
    items.push({
      id: "fast",
      title: `Fast model: ${fast.name}`,
      detail: "Handles context summaries and read-only subagents, so the chat model spends its time on your task.",
      recommended: true,
      patch: { fastModel: fast.name, fastRoute: undefined },
    });
  }

  const cloud = [...detection.cloud].filter((item) => item.model).sort((a, b) => CLOUD_ORDER.indexOf(a.presetId) - CLOUD_ORDER.indexOf(b.presetId))[0];
  const ollamaCloud = installed.map((model) => model.name).filter(isCloudModel)
    .sort((a, b) => OLLAMA_CLOUD_ORDER.findIndex((pattern) => pattern.test(a)) - OLLAMA_CLOUD_ORDER.findIndex((pattern) => pattern.test(b)))
    .find((name) => OLLAMA_CLOUD_ORDER.some((pattern) => pattern.test(name))) ?? installed.map((model) => model.name).find(isCloudModel);
  if (cloud?.model) {
    const route: ModelRoute = { presetId: cloud.presetId, kind: cloud.kind, baseUrl: cloud.baseUrl, model: cloud.model };
    items.push({
      id: "escalation",
      title: `Escalate to ${cloud.model}`,
      detail: `After two rejected attempts, the turn continues on ${cloud.model} using your saved ${cloud.presetId} key. The conversation and workspace context then leave this PC, and Moss says so each time.`,
      recommended: true,
      patch: { escalationRoute: route, escalationModel: undefined },
    });
  } else if (ollamaCloud) {
    items.push({
      id: "escalation",
      title: `Escalate to ${ollamaCloud}`,
      detail: `After two rejected attempts, the turn continues on this Ollama cloud model. The conversation and workspace context then go to Ollama's cloud service, and Moss says so each time.`,
      recommended: true,
      patch: { escalationModel: ollamaCloud, escalationRoute: undefined },
    });
  }

  const hasEmbeddings = installed.some((model) => model.name === EMBEDDING_MODEL || model.name.startsWith(`${EMBEDDING_MODEL}:`));
  items.push({
    id: "embeddings",
    title: hasEmbeddings ? "Rank tools and lessons by meaning" : `Download ${EMBEDDING_MODEL} and rank tools by meaning`,
    detail: `${hasEmbeddings ? "Uses" : "Downloads (about 270 MB) and uses"} ${EMBEDDING_MODEL} on this PC, so weaker models keep the tools a request needs even when it shares no words with them.`,
    recommended: true,
    // Point at Ollama explicitly: an empty value would reuse the chat provider,
    // which may be a cloud service.
    patch: { embedModel: EMBEDDING_MODEL, embedBaseUrl: baseUrl, semanticRanking: true },
    ...(hasEmbeddings ? {} : { actions: [{ type: "pull" as const, model: EMBEDDING_MODEL }] }),
  });

  const toProfile = [chat?.model.name, fast?.name].filter((name): name is string => !!name && !profileOf(name) && items.some((item) => item.patch?.model === name || item.patch?.fastModel === name));
  if (toProfile.length > 0) {
    items.push({
      id: "profile",
      title: `Profile ${toProfile.join(" and ")}`,
      detail: "Runs the capability probe (about 30 short requests with fake tools) so adaptation, constrained output, and voting rest on measurements. Takes a minute or two per model.",
      recommended: chatAdopted,
      actions: toProfile.map((model) => ({ type: "probe" as const, model })),
    });
  }
  if (chatName && !isCloudModel(chatName)) {
    items.push({
      id: "context",
      title: `Check ${chatName}'s context window`,
      detail: "Loads the model and, if Ollama serves a context that truncates prompts or spills to the CPU, creates a correctly sized variant and switches to it. Your existing model is unchanged.",
      recommended: chatAdopted,
      actions: [{ type: "context", model: chatName }],
    });
  }

  const skipped = local.length - fitting.length;
  return {
    items,
    summary: items.length === 0
      ? "Nothing to set up."
      : `Found ${local.length} local model${local.length === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} too large for your GPU)` : ""}${detection.gpu ? ` and ${detection.gpu.name ?? "a GPU"} with ${(detection.gpu.totalMiB / 1024).toFixed(0)} GB` : ""}${detection.cloud.length ? `; saved keys for ${detection.cloud.map((item) => item.presetId).join(", ")}` : ""}.`,
  };
}
