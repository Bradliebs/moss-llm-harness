// common/model-family.ts
//
// Model families, for keeping a reviewer independent of the models whose work
// it grades: models from one family share training data and blind spots, so a
// critic from the same family tends to repeat the worker's mistakes.

const FAMILIES: ReadonlyArray<[family: string, pattern: RegExp]> = [
  ["anthropic", /^claude/],
  ["openai", /^(?:gpt|o[1-9](?:-|$)|chatgpt|davinci|text-davinci)/],
  ["google", /^(?:gemini|gemma|palm|codegemma)/],
  ["meta", /^(?:llama|codellama|llava)/],
  ["alibaba", /^(?:qwen|qwq|codeqwen)/],
  ["mistral", /^(?:mistral|mixtral|ministral|codestral|devstral|magistral|pixtral|voxtral)/],
  ["deepseek", /^deepseek/],
  ["zhipu", /^(?:glm|chatglm|codegeex)/],
  ["moonshot", /^(?:kimi|moonshot)/],
  ["xai", /^grok/],
  ["microsoft", /^phi(?:\d|-|:|$)/],
  ["nvidia", /^(?:nemotron|llama-?\d.*nemotron)/],
  ["cohere", /^(?:command|aya)/],
  ["ibm", /^granite/],
  ["ai2", /^olmo/],
  ["01ai", /^yi(?:-|:|$)/],
  ["minimax", /^(?:minimax|abab)/],
];

const FINE_TUNE_BRANDS = /^(?:phind|wizard|orca|tulu|dolphin|hermes|nous|openhermes|openchat|vicuna|zephyr|neural-chat|starling|samantha|everythinglm|stable-beluga|solar)/;

/** Family of a model name, or undefined when it cannot be told from the name. */
export function modelFamily(model: string): string | undefined {
  // Strip router prefixes such as "anthropic/", "openai/", "hf.co/org/", and "library/".
  const name = model.trim().toLowerCase().split("/").pop()!.replace(/^(?:models-)?/, "");
  if (!name) return undefined;
  // Nemotron is NVIDIA's even when built on Llama.
  if (/nemotron/.test(name)) return "nvidia";
  // Community fine-tunes carry their base model's blind spots under another
  // brand, and the base is not in the name, so they stay unknown and fail closed.
  if (FINE_TUNE_BRANDS.test(name)) return undefined;
  return FAMILIES.find(([, pattern]) => pattern.test(name))?.[0];
}

/** Every model that can do a turn's work: the chat model and its fast and escalation routes. */
export function workerModels(input: {
  model: string;
  fastModel?: string;
  fastRoute?: { model: string };
  escalationModel?: string;
  escalationRoute?: { model: string };
}): string[] {
  return [input.model, input.escalationRoute?.model ?? input.escalationModel, input.fastRoute?.model ?? input.fastModel]
    .filter((model): model is string => typeof model === "string" && model.trim().length > 0);
}

export interface IndependenceCheck {
  ok: boolean;
  reason?: string;
  criticFamily?: string;
}

/** Whether `critic` is from a family different from every model that did the work. */
export function checkCriticIndependence(critic: string | undefined, workers: readonly string[]): IndependenceCheck {
  if (!critic?.trim()) return { ok: false, reason: "No critic model is configured. Choose one under Settings > Models > Routing and adaptation." };
  const criticFamily = modelFamily(critic);
  if (!criticFamily) return { ok: false, reason: `Moss cannot tell which model family ${critic} belongs to, so it cannot confirm the critic is independent. Choose a critic with a recognizable name, such as a Claude, GPT, Gemini, Llama, Qwen, or Mistral model.` };
  for (const worker of workers.filter((item) => item.trim())) {
    const workerFamily = modelFamily(worker);
    if (!workerFamily) return { ok: false, criticFamily, reason: `Moss cannot tell which model family ${worker} belongs to, so it cannot confirm ${critic} is independent of it.` };
    if (workerFamily === criticFamily) return { ok: false, criticFamily, reason: `The critic ${critic} is from the same model family as ${worker} (${criticFamily}). Choose a critic from a different family so it does not share the worker's blind spots.` };
  }
  return { ok: true, criticFamily };
}
