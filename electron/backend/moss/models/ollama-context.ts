// electron/backend/moss/models/ollama-context.ts
//
// Context-window fit for Ollama models. A model served with a small context
// silently truncates long prompts; one served with a context larger than VRAM
// spills to the CPU and slows down several times. Moss reads what the server
// actually serves (/api/ps), what the model was trained for (/api/show), and
// what fits the GPU, and proposes a named variant with the right num_ctx. The
// variant is created only when the user confirms.

import { execFile } from "node:child_process";

import type { OllamaContextReport } from "../../../../common/types";

const REQUEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
/** Runtime overhead beyond weights and KV cache (compute buffers, CUDA context). */
const OVERHEAD_MIB = 450;
const STEP = 2048;
export const DEFAULT_TARGET_CONTEXT = 32_768;
/** Below this, long prompts are routinely truncated. */
const SMALL_CONTEXT = 16_384;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type GpuReader = () => Promise<{ totalMiB: number; usedMiB: number; name?: string } | null>;

/** Native API root for an Ollama OpenAI-compatible base URL. */
export function ollamaRoot(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function variantName(model: string, numCtx: number): string {
  const [name, tag = "latest"] = model.split(":");
  const base = tag.replace(/-ctx\d+k$/, "");
  return `${name}:${base}-ctx${Math.round(numCtx / 1024)}k`;
}

export const readNvidiaGpu: GpuReader = () => new Promise((resolve) => {
  execFile("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"], { timeout: 4_000, windowsHide: true }, (error, stdout) => {
    if (error) return resolve(null);
    const [name, total, used] = String(stdout).split(/\r?\n/)[0]?.split(",").map((part) => part.trim()) ?? [];
    const totalMiB = Number(total);
    const usedMiB = Number(used);
    resolve(Number.isFinite(totalMiB) && totalMiB > 0 ? { totalMiB, usedMiB: Number.isFinite(usedMiB) ? usedMiB : 0, name } : null);
  });
});

interface ModelInfo {
  trainedContext?: number;
  configuredContext?: number;
  kvBytesPerToken?: number;
  parameterSize?: string;
  quantization?: string;
}

/** KV-cache bytes per token at f16 from GGUF metadata, when the metadata allows it. */
export function kvBytesPerToken(info: Record<string, unknown>): number | undefined {
  const find = (suffix: string): number | undefined => {
    const entry = Object.entries(info).find(([key]) => key.endsWith(suffix));
    const value = Number(entry?.[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const layers = find(".block_count");
  const heads = find(".attention.head_count");
  const kvHeads = find(".attention.head_count_kv") ?? heads;
  const embedding = find(".embedding_length");
  const keyLength = find(".attention.key_length") ?? (embedding && heads ? embedding / heads : undefined);
  const valueLength = find(".attention.value_length") ?? keyLength;
  if (!layers || !kvHeads || !keyLength || !valueLength) return undefined;
  return layers * kvHeads * (keyLength + valueLength) * 2;
}

export function parseShow(body: { parameters?: unknown; model_info?: unknown; details?: { parameter_size?: unknown; quantization_level?: unknown } }): ModelInfo {
  const info = body.model_info && typeof body.model_info === "object" ? body.model_info as Record<string, unknown> : {};
  const trained = Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1];
  const configured = typeof body.parameters === "string" ? body.parameters.match(/^\s*num_ctx\s+(\d+)/m)?.[1] : undefined;
  return {
    ...(Number(trained) > 0 ? { trainedContext: Number(trained) } : {}),
    ...(configured ? { configuredContext: Number(configured) } : {}),
    ...(kvBytesPerToken(info) ? { kvBytesPerToken: kvBytesPerToken(info) } : {}),
    ...(typeof body.details?.parameter_size === "string" ? { parameterSize: body.details.parameter_size } : {}),
    ...(typeof body.details?.quantization_level === "string" ? { quantization: body.details.quantization_level } : {}),
  };
}

/** Largest context that keeps weights, KV cache, and overhead in free VRAM. */
export function contextThatFits(freeMiB: number, weightsMiB: number, kvBytes: number): number {
  const budgetBytes = (freeMiB * 0.92 - weightsMiB - OVERHEAD_MIB) * MIB;
  if (budgetBytes <= 0) return 0;
  return Math.floor(budgetBytes / kvBytes / STEP) * STEP;
}

async function json<T>(fetcher: Fetcher, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetcher(url, body === undefined
    ? { signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Ollama ${new URL(url).pathname} failed: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
  return await response.json() as T;
}

interface PsModel { name?: string; model?: string; size?: number; size_vram?: number; context_length?: number }

export async function inspectOllamaContext(options: {
  baseUrl: string;
  model: string;
  usableContext?: number;
  target?: number;
  fetcher?: Fetcher;
  gpu?: GpuReader;
  signal?: AbortSignal;
}): Promise<OllamaContextReport> {
  const fetcher = options.fetcher ?? fetch;
  const root = ollamaRoot(options.baseUrl);
  if (!root) throw new Error("The endpoint is not a valid URL.");
  if (/[:-]cloud$/i.test(options.model)) {
    return { model: options.model, status: "not-applicable", reason: "Cloud models run on Ollama's servers, so their context is not set locally." };
  }
  const show = parseShow(await json(fetcher, `${root}/api/show`, { model: options.model }, options.signal));
  const tags = await json<{ models?: Array<{ name?: string; model?: string; size?: number }> }>(fetcher, `${root}/api/tags`, undefined, options.signal).catch(() => ({ models: [] }));
  const weightsBytes = tags.models?.find((item) => item.name === options.model || item.model === options.model)?.size;
  // Load the model (an empty generate request loads without generating) so the
  // server reports the context it actually serves.
  await json(fetcher, `${root}/api/generate`, { model: options.model }, options.signal);
  const ps = await json<{ models?: PsModel[] }>(fetcher, `${root}/api/ps`, undefined, options.signal);
  const loaded = ps.models?.find((item) => item.name === options.model || item.model === options.model);
  const served = loaded?.context_length ?? show.configuredContext;
  const gpu = await (options.gpu ?? readNvidiaGpu)();
  const othersMiB = gpu ? Math.max(0, gpu.usedMiB - (ps.models ?? []).reduce((sum, item) => sum + (item.size_vram ?? 0), 0) / MIB) : undefined;
  const freeMiB = gpu && othersMiB !== undefined ? gpu.totalMiB - othersMiB : undefined;
  const weightsMiB = weightsBytes ? weightsBytes / MIB : undefined;
  // The loaded model's real memory use is the ground truth: GGUF metadata
  // overstates the cache for sliding-window models such as gemma3.
  // Everything beyond the weights and fixed overhead is charged to the cache.
  // Some servers under-report multimodal models; then the measurement is not
  // trusted and the metadata estimate only guides a smaller recommendation.
  const beyondWeights = loaded?.size && weightsBytes ? loaded.size - weightsBytes - OVERHEAD_MIB * MIB : 0;
  const measuredKv = served && beyondWeights > 0 ? beyondWeights / served : undefined;
  const kvBytes = measuredKv ?? show.kvBytesPerToken;
  const estimate = freeMiB !== undefined && weightsMiB !== undefined && kvBytes ? contextThatFits(freeMiB, weightsMiB, kvBytes) : undefined;
  const fits = measuredKv !== undefined ? estimate : undefined;
  const spilled = Boolean(loaded?.size && loaded.size_vram !== undefined && loaded.size_vram < loaded.size * 0.98);
  const ceiling = Math.min(show.trainedContext ?? Infinity, options.target ?? DEFAULT_TARGET_CONTEXT);
  const recommended = Math.floor(Math.min(ceiling, estimate ?? ceiling) / STEP) * STEP;

  const base = {
    model: options.model,
    ...(served ? { servedContext: served } : {}),
    ...(show.trainedContext ? { trainedContext: show.trainedContext } : {}),
    ...(options.usableContext ? { usableContext: options.usableContext } : {}),
    ...(fits !== undefined ? { fitsInVram: fits } : {}),
    ...(gpu ? { gpu: { name: gpu.name, totalMiB: gpu.totalMiB, freeMiB: Math.round(freeMiB ?? 0) } } : {}),
    ...(weightsMiB ? { weightsMiB: Math.round(weightsMiB) } : {}),
    ...(measuredKv ? { kvKiBPerToken: Math.round(measuredKv / 1024) } : {}),
    spilledToCpu: spilled,
  };
  if (!served) return { ...base, status: "unknown", reason: "The server did not report the context it serves for this model." };
  // A model the server holds entirely in GPU memory demonstrably fits, so only
  // an observed spill to the CPU means the context is too large.
  if (recommended < STEP * 2) {
    return spilled
      ? { ...base, status: "too-large", reason: "The model's weights nearly fill free GPU memory, so part of it runs on the CPU at any useful context size. A smaller model or quantization will be much faster." }
      : { ...base, status: "unknown", reason: "Free GPU memory is too small to recommend a context size for this model." };
  }
  if (spilled) {
    return {
      ...base,
      status: "too-large",
      recommendedContext: recommended,
      variant: variantName(options.model, recommended),
      reason: `The served context of ${served.toLocaleString("en-US")} tokens does not fit in free GPU memory${spilled ? ", so part of the model runs on the CPU" : ""}. ${recommended.toLocaleString("en-US")} tokens fits and runs fully on the GPU.`,
    };
  }
  if (served < SMALL_CONTEXT && recommended >= served * 2) {
    return {
      ...base,
      status: "too-small",
      recommendedContext: recommended,
      variant: variantName(options.model, recommended),
      reason: `The server serves ${served.toLocaleString("en-US")} tokens, so longer prompts are cut off. ${recommended.toLocaleString("en-US")} tokens fits your GPU${show.trainedContext ? ` and the model was trained for ${show.trainedContext.toLocaleString("en-US")}` : ""}.`,
    };
  }
  return { ...base, status: "ok", reason: `The served context of ${served.toLocaleString("en-US")} tokens suits this model and fits in GPU memory.` };
}

/** Create a variant of the model with the given num_ctx. Newer servers take
 *  `from` and `parameters`; older ones need a Modelfile. */
export async function createContextVariant(options: { baseUrl: string; model: string; numCtx: number; fetcher?: Fetcher; signal?: AbortSignal }): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const root = ollamaRoot(options.baseUrl);
  if (!root) throw new Error("The endpoint is not a valid URL.");
  if (!Number.isInteger(options.numCtx) || options.numCtx < STEP || options.numCtx > 1_048_576) throw new Error("Choose a context between 2,048 and 1,048,576 tokens.");
  const name = variantName(options.model, options.numCtx);
  try {
    await json(fetcher, `${root}/api/create`, { model: name, from: options.model, parameters: { num_ctx: options.numCtx }, stream: false }, options.signal);
  } catch (error) {
    if (!/HTTP 4\d\d/.test(String(error))) throw error;
    await json(fetcher, `${root}/api/create`, { model: name, modelfile: `FROM ${options.model}\nPARAMETER num_ctx ${options.numCtx}\n`, stream: false }, options.signal);
  }
  return name;
}
