// electron/backend/moss/setup/pc-setup.ts
//
// Detects what this PC can run: a local Ollama server and its models, the GPU,
// and cloud providers that already have a saved API key (with a suggested
// strong model for escalation). The renderer turns this into a reviewable
// setup proposal; nothing here changes settings.

import type { ProviderKind, SetupDetection, SetupDetectionRequest } from "../../../../common/types";
import { readNvidiaGpu, ollamaRoot, type Fetcher, type GpuReader } from "../models/ollama-context";

const DETECT_TIMEOUT_MS = 2_500;
const LIST_TIMEOUT_MS = 8_000;

/** Preferred escalation models per provider, strongest-first patterns. */
const ESCALATION_PREFERENCES: Record<string, RegExp[]> = {
  anthropic: [/^claude-sonnet-4/, /^claude-opus-4/, /^claude-3-7-sonnet/, /sonnet/],
  openai: [/^gpt-5(?:\.\d+)?$/, /^gpt-4\.1$/, /^o3$/, /^gpt-4o$/],
  openrouter: [/^anthropic\/claude-sonnet-4/, /^openai\/gpt-5/, /^anthropic\/claude/],
  mistral: [/^mistral-large-latest$/, /^mistral-large/, /^codestral-latest$/],
  xai: [/^grok-4/, /^grok-3$/],
};

export function pickEscalationModel(presetId: string, models: readonly string[]): string | undefined {
  const sorted = [...models].sort((a, b) => b.localeCompare(a));
  for (const pattern of ESCALATION_PREFERENCES[presetId] ?? []) {
    const match = sorted.find((model) => pattern.test(model));
    if (match) return match;
  }
  return undefined;
}

export interface DetectDeps {
  fetcher?: Fetcher;
  gpu?: GpuReader;
  credential: (presetId: string) => string;
  listModels: (config: { kind: ProviderKind; baseUrl: string; apiKey: string }) => Promise<string[]>;
}

async function detectOllama(baseUrl: string, fetcher: Fetcher): Promise<SetupDetection["ollama"]> {
  const root = ollamaRoot(baseUrl);
  if (!root) return undefined;
  try {
    const versionResponse = await fetcher(`${root}/api/version`, { signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
    if (!versionResponse.ok) return undefined;
    const version = await versionResponse.json() as { version?: string };
    const tags = await fetcher(`${root}/api/tags`, { signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) })
      .then((response) => response.json() as Promise<{ models?: Array<{ name?: string; size?: number; details?: { parameter_size?: string; family?: string } }> }>);
    return {
      baseUrl,
      ...(version.version ? { version: version.version } : {}),
      models: (tags.models ?? []).filter((model) => typeof model.name === "string").map((model) => ({
        name: model.name!,
        sizeBytes: model.size ?? 0,
        ...(model.details?.parameter_size ? { parameterSize: model.details.parameter_size } : {}),
        ...(model.details?.family ? { family: model.details.family } : {}),
      })),
    };
  } catch {
    return undefined;
  }
}

export async function detectSetup(request: SetupDetectionRequest, deps: DetectDeps): Promise<SetupDetection> {
  const ollama = await detectOllama(request.ollamaBaseUrl, deps.fetcher ?? fetch);
  const gpu = await (deps.gpu ?? readNvidiaGpu)();
  const cloud = await Promise.all(request.cloud.map(async (preset) => {
    const apiKey = deps.credential(preset.presetId);
    if (!apiKey || !preset.baseUrl) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const models = await Promise.race([
      deps.listModels({ kind: preset.kind, baseUrl: preset.baseUrl, apiKey }).catch(() => [] as string[]),
      new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), LIST_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const model = pickEscalationModel(preset.presetId, models);
    return { presetId: preset.presetId, kind: preset.kind, baseUrl: preset.baseUrl, ...(model ? { model } : {}) };
  }));
  return {
    ...(ollama ? { ollama } : {}),
    ...(gpu ? { gpu: { ...(gpu.name ? { name: gpu.name } : {}), totalMiB: gpu.totalMiB, freeMiB: Math.max(0, gpu.totalMiB - gpu.usedMiB) } } : {}),
    cloud: cloud.filter((item): item is NonNullable<typeof item> => item !== undefined),
  };
}

/** Pull a model from the Ollama library, waiting for completion. */
export async function pullOllamaModel(baseUrl: string, model: string, fetcher: Fetcher = fetch): Promise<void> {
  const root = ollamaRoot(baseUrl);
  if (!root || !/^[\w./:-]+$/.test(model)) throw new Error("Invalid model name.");
  const response = await fetcher(`${root}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const body = await response.json().catch(() => ({})) as { status?: string; error?: string };
  if (!response.ok || body.error) throw new Error(body.error ?? `Pull failed: HTTP ${response.status}`);
}
