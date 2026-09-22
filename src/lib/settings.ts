// src/lib/settings.ts
//
// Durable user settings: the active provider connection, the model, the tools
// master switch, the UI theme, and the tool workspace root. Persisted to
// localStorage so the app reopens with the same provider/model selected.

import type { EmbedConfig, InjectionMode, ProviderConfig, ProviderKind } from "@common/types";import { DEFAULT_PERSONALITY_ID } from "@common/personalities";

import type { ModelRate } from "./pricing";
import { createPersistentStore } from "./persistentStore";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "ollama", label: "Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
  { id: "openai", label: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "openrouter", label: "OpenRouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "mistral", label: "Mistral", kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1" },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compatible", baseUrl: "https://api.x.ai/v1" },
  { id: "custom", label: "Custom", kind: "openai-compatible", baseUrl: "" },
];

export interface MossSettings {
  /** index into PROVIDER_PRESETS; the matching preset seeds kind + baseUrl */
  presetIndex: number;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** provider-specific connection metadata; API keys are stored separately by Electron safeStorage */
  providerProfiles?: Record<string, { baseUrl: string; model: string }>;
  /** compact data URL for the user-selected in-app avatar; null uses the built-in portrait */
  avatarDataUrl: string | null;
  enableTools: boolean;
  /** maximum tool-execution rounds in one turn */
  maxToolRounds: number;
  /** when true, tools that mutate files or run commands run without prompting */
  autoApproveTools: boolean;
  browserEnabled: boolean;
  browserAllowedDomains: string;
  browserHeadless: boolean;
  desktopEnabled: boolean;
  desktopAllowedProcesses: string;
  desktopAllowedWindows: string;
  /** user-authored persona/instructions appended to the system prompt; the
   *  built-in safety section is always kept regardless of this value */
  customInstructions: string;
  /** id of the active personality preset (the global default) */
  personalityId: string;
  /** when true, the assistant adapts its tone to remembered preferences */
  adaptiveTone: boolean;
  workspaceRoot: string | null;
  /** speech-to-text endpoint base URL (empty = reuse the provider baseUrl) */
  sttBaseUrl: string;
  /** transcription model name for the /audio/transcriptions endpoint */
  sttModel: string;
  /** Resend API key for the send_email tool (empty = tool disabled) */
  emailApiKey: string;
  /** verified sender address for the send_email tool */
  emailFrom: string;
  jevEnabled: boolean;
  /** embeddings endpoint base URL for the codebase index (empty = reuse provider baseUrl) */
  embedBaseUrl: string;
  /** embeddings model name for the /embeddings endpoint */
  embedModel: string;
  /** when true, run the verification commands after the agent edits files */
  verifyEnabled: boolean;
  /** newline-separated shell commands run in the workspace to verify edits */
  verifyCommands: string;
  /** optional context-window size for proactive compaction and the usage meter;
   *  0 disables both, while provider-reported overflow remains recoverable. */
  contextLimit: number;
  /** soft daily USD spend cap enforced by the backend; 0 disables it. */
  dailyBudgetUsd: number;
  /** when true, the assistant's m_remember writes are queued for human review
   *  instead of saved immediately. */
  gatedMemory: boolean;
  /** when true, show a shadow confidence chip after each turn. */
  showConfidence: boolean;
  /** how external tool output (web/fetch/MCP) is scanned for prompt injection. */
  injectionMode: InjectionMode;
  /** user-supplied USD-per-million-token rates, keyed by lowercased model id.
   *  Overrides the built-in pricing estimates so cost readouts can be exact. */
  modelRates?: Record<string, ModelRate>;
  /** UI color theme; "dark" preserves the original look and stays the default,
   *  "auto" follows the OS prefers-color-scheme. */
  theme: "dark" | "light" | "auto";
}

const DEFAULT_SETTINGS: MossSettings = {
  presetIndex: 0,
  kind: PROVIDER_PRESETS[0].kind,
  baseUrl: PROVIDER_PRESETS[0].baseUrl,
  apiKey: "",
  model: "",
  avatarDataUrl: null,
  enableTools: true,
  maxToolRounds: 8,
  autoApproveTools: false,
  browserEnabled: false,
  browserAllowedDomains: "",
  browserHeadless: true,
  desktopEnabled: false,
  desktopAllowedProcesses: "",
  desktopAllowedWindows: "",
  customInstructions: "",
  personalityId: DEFAULT_PERSONALITY_ID,
  adaptiveTone: false,
  workspaceRoot: null,
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  jevEnabled: false,
  embedBaseUrl: "",
  embedModel: "nomic-embed-text",
  verifyEnabled: false,
  verifyCommands: "",
  contextLimit: 0,
  dailyBudgetUsd: 0,
  gatedMemory: false,
  showConfidence: false,
  injectionMode: "flag",
  modelRates: {},
  theme: "dark",
};

export const settingsStore = createPersistentStore<MossSettings>(
  "moss.settings",
  DEFAULT_SETTINGS,
  (settings) => ({ ...settings, apiKey: "" }),
);

/** Last-fetched model ids, kept so the header model dropdown is populated on
 *  reload without re-querying the provider. */
export const modelsStore = createPersistentStore<string[]>("moss.models", []);

/** Last add-server form type (stdio/http), so the MCP form reopens on the kind
 *  the user added most recently instead of always defaulting to stdio. */
export const mcpAddFormTypeStore = createPersistentStore<"stdio" | "http">(
  "moss.mcpAddFormType",
  "stdio",
);

export function useSettings(): MossSettings {
  return settingsStore.use();
}

export function updateSettings(patch: Partial<MossSettings>): void {
  settingsStore.update((prev) => {
    const next = { ...prev, ...patch };
    const providerId = PROVIDER_PRESETS[prev.presetIndex]?.id;
    if (!providerId || (patch.baseUrl === undefined && patch.model === undefined)) return next;
    return {
      ...next,
      providerProfiles: {
        ...prev.providerProfiles,
        [providerId]: { baseUrl: next.baseUrl, model: next.model },
      },
    };
  });
}

export async function initializeProviderCredential(): Promise<void> {
  const settings = settingsStore.get();
  const providerId = PROVIDER_PRESETS[settings.presetIndex]?.id;
  if (!providerId || typeof window === "undefined" || !window.moss?.provider) return;
  if (settings.apiKey) await window.moss.provider.setCredential(providerId, settings.apiKey);
  updateSettings({ apiKey: await window.moss.provider.getCredential(providerId) });
}

export async function saveProviderCredential(apiKey: string): Promise<void> {
  const providerId = PROVIDER_PRESETS[settingsStore.get().presetIndex]?.id;
  if (!providerId) throw new Error("No provider preset is selected");
  await window.moss.provider.setCredential(providerId, apiKey);
  updateSettings({ apiKey: apiKey.trim() });
}

/** Set or clear the user's pricing override for a model. Passing null (or a rate
 *  of all zeros) removes the override so the built-in estimate applies again.
 *  Keys are normalized to a lowercased, trimmed model id. */
export function setModelRate(model: string, rate: ModelRate | null): void {
  const id = model.trim().toLowerCase();
  if (!id) return;
  settingsStore.update((prev) => {
    const next = { ...(prev.modelRates ?? {}) };
    if (!rate || (rate.inputPer1M <= 0 && rate.outputPer1M <= 0)) delete next[id];
    else next[id] = { inputPer1M: rate.inputPer1M, outputPer1M: rate.outputPer1M };
    return { ...prev, modelRates: next };
  });
}

/** Apply a preset, resetting the cached model list since models are provider-specific. */
export async function applyPreset(index: number): Promise<void> {
  const preset = PROVIDER_PRESETS[index];
  if (!preset) return;
  const current = settingsStore.get();
  const currentPreset = PROVIDER_PRESETS[current.presetIndex];
  const providerProfiles = {
    ...current.providerProfiles,
    ...(currentPreset ? { [currentPreset.id]: { baseUrl: current.baseUrl, model: current.model } } : {}),
  };
  const profile = providerProfiles[preset.id];
  const apiKey = typeof window !== "undefined" && window.moss?.provider
    ? await window.moss.provider.getCredential(preset.id)
    : "";
  settingsStore.set({
    ...current,
    presetIndex: index,
    kind: preset.kind,
    baseUrl: profile?.baseUrl ?? preset.baseUrl,
    model: profile?.model ?? "",
    apiKey,
    providerProfiles,
  });
  modelsStore.set([]);
}

export function toProviderConfig(s: MossSettings): ProviderConfig {
  return { kind: s.kind, baseUrl: s.baseUrl, apiKey: s.apiKey || undefined, model: s.model };
}

/** Embeddings config for the codebase index. Falls back to the provider baseUrl
 *  and reuses the provider API key, so an Ollama user needs no extra setup. */
export function toEmbedConfig(s: MossSettings): EmbedConfig {
  return {
    baseUrl: (s.embedBaseUrl || s.baseUrl || "").trim(),
    apiKey: s.apiKey || undefined,
    model: s.embedModel || "nomic-embed-text",
  };
}
