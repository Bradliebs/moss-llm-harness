// electron/backend/moss/models/capability-probes.ts
//
// Capability probe suite. Each probe sends a small, deterministic task to a
// model and grades the reply locally, so routing and scaffolding decisions can
// rest on measurements instead of assumptions about a model family. Probes never
// execute real tools: tool calls are graded, or answered by in-memory fakes,
// inside the probe itself.

import type {
  AgentMessage,
  CapabilityDimension,
  CapabilityProbeResult,
  CapabilityTrial,
  ModelProbeProgress,
  ToolDefinition,
} from "../../../../common/types";
import type { ChatProvider } from "../providers/types";
import { parseTextToolCalls, repairToolCall } from "./tool-repair";

export const PROBE_SUITE_VERSION = "1";
export const DEFAULT_MAX_CONTEXT_TOKENS = 32_768;
export const CONTEXT_LEVELS = [1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536, 131_072] as const;
export const PLAN_LENGTHS = [2, 4, 6] as const;
export const ALL_DIMENSIONS: readonly CapabilityDimension[] = [
  "tool-calling",
  "tool-selection",
  "tool-restraint",
  "structured-output",
  "instruction-following",
  "usable-context",
  "plan-coherence",
];

export const DEFAULT_TIMEOUT_SECONDS = 90;
const MIN_CONTEXT_TIMEOUT_MS = 240_000;
const MIN_WARMUP_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 1_024;
const INITIAL_CHARS_PER_TOKEN = 4;

export class ProbeCancelledError extends Error {
  constructor() {
    super("Capability probe cancelled");
    this.name = "ProbeCancelledError";
  }
}

export interface ProbeContext {
  provider: ChatProvider;
  model: string;
  signal: AbortSignal;
  now?: () => number;
  /** per-request timeout for short probes; long-context and warm-up calls get more */
  timeoutMs?: number;
}

function shortTimeout(ctx: ProbeContext): number {
  return ctx.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000;
}

export interface ProbeCompletion {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  error?: string;
  /** the server rejected the request because the model cannot use tools */
  toolsUnsupported?: boolean;
}

export const TOOLS_UNSUPPORTED_NOTE = "The server reports that this model does not support tools";
const TOOLS_UNSUPPORTED = /does not support tools|tools? (?:are|is) not supported|(?:function|tool) calling is not supported|tool use is not supported/i;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/** One bounded model call. Provider failures and timeouts are returned as data
 *  so a single bad call lowers a score instead of aborting the suite; only user
 *  cancellation throws. */
export async function complete(
  ctx: ProbeContext,
  messages: AgentMessage[],
  tools?: ToolDefinition[],
  timeoutMs = shortTimeout(ctx),
): Promise<ProbeCompletion> {
  if (ctx.signal.aborted) throw new ProbeCancelledError();
  const now = ctx.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const result: ProbeCompletion = { text: "", toolCalls: [], durationMs: 0 };
  try {
    const stream = ctx.provider.streamChat(
      { model: ctx.model, messages, ...(tools && tools.length > 0 ? { tools } : {}), maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
      controller.signal,
    );
    for await (const event of stream) {
      if (event.type === "text-delta") result.text += event.text;
      else if (event.type === "tool-call") result.toolCalls.push(event.toolCall);
      else if (event.type === "usage") {
        if (event.usage.inputTokens !== undefined) result.inputTokens = event.usage.inputTokens;
        if (event.usage.outputTokens !== undefined) result.outputTokens = event.usage.outputTokens;
      }
    }
  } catch (error) {
    if (ctx.signal.aborted) throw new ProbeCancelledError();
    result.error = controller.signal.aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : errorMessage(error);
    if (tools && tools.length > 0 && TOOLS_UNSUPPORTED.test(result.error)) result.toolsUnsupported = true;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
    result.durationMs = now() - started;
  }
  if (ctx.signal.aborted) throw new ProbeCancelledError();
  return result;
}

// --- Grading helpers ---

/** Strip reasoning blocks that thinking models emit before their answer. */
export function visibleText(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

export function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Parse a JSON object strictly (the whole reply) and leniently (inside code
 *  fences or surrounding prose). */
export function extractJsonObject(text: string): { strict?: Record<string, unknown>; lenient?: Record<string, unknown> } {
  const visible = visibleText(text);
  const asObject = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };
  const strict = asObject(visible);
  if (strict) return { strict, lenient: strict };
  const fenced = visible.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const braces = visible.includes("{") ? visible.slice(visible.indexOf("{"), visible.lastIndexOf("}") + 1) : "";
  const lenient = (fenced ? asObject(fenced.trim()) : undefined) ?? (braces ? asObject(braces) : undefined);
  return lenient ? { lenient } : {};
}

/** True when a reply describes a tool call in text instead of using the
 *  provider's native function-calling channel. */
export function looksLikeTextToolCall(text: string, toolNames: readonly string[]): boolean {
  const visible = visibleText(text);
  if (/<tool_call>|<function[=\s]|\[TOOL_CALLS\]/i.test(visible)) return true;
  return toolNames.some((name) =>
    new RegExp(`"(?:name|function|tool)"\\s*:\\s*"${name}"`).test(visible) || new RegExp(`\\b${name}\\s*\\(`).test(visible));
}

function includesText(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

function trial(id: string, completion: ProbeCompletion, passed: boolean, note?: string, score = passed ? 1 : 0): CapabilityTrial {
  // An explicit "no tool support" rejection is a measured answer, not an outage.
  const errored = !!completion.error && !completion.toolsUnsupported;
  const detail = completion.toolsUnsupported ? TOOLS_UNSUPPORTED_NOTE : completion.error ? `Provider error: ${completion.error}` : note;
  return {
    id,
    passed: completion.error ? false : passed,
    score: completion.error ? 0 : score,
    ...(detail ? { note: detail } : {}),
    ...(errored ? { errored: true } : {}),
    durationMs: completion.durationMs,
    ...(completion.inputTokens !== undefined ? { inputTokens: completion.inputTokens } : {}),
    ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {}),
  };
}

/** Scores cover completed requests only: a timeout says the model was slow or
 *  unavailable, not that it answered wrongly. */
function summarize(dimension: CapabilityDimension, trials: CapabilityTrial[], summary: string, metrics: Record<string, number> = {}): CapabilityProbeResult {
  const completed = trials.filter((item) => !item.errored);
  const errors = trials.length - completed.length;
  const toolsUnsupported = trials.filter((item) => item.note === TOOLS_UNSUPPORTED_NOTE).length;
  const score = completed.length ? completed.reduce((sum, item) => sum + item.score, 0) / completed.length : 0;
  return {
    dimension,
    score: Math.round(score * 1000) / 1000,
    passed: trials.filter((item) => item.passed).length,
    total: trials.length,
    summary: completed.length ? `${summary}${errors ? ` (${errors} request${errors === 1 ? "" : "s"} failed or timed out)` : ""}` : `No completed requests: ${errors} failed or timed out`,
    trials,
    durationMs: trials.reduce((sum, item) => sum + item.durationMs, 0),
    metrics: { ...metrics, completed: completed.length, ...(errors ? { errors } : {}), ...(toolsUnsupported ? { toolsUnsupported } : {}) },
  };
}

function passedOf(trials: CapabilityTrial[]): string {
  const completed = trials.filter((item) => !item.errored);
  return `${completed.filter((item) => item.passed).length}/${completed.length}`;
}

function schemaKeys(tool: ToolDefinition | undefined): string[] {
  const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties ? Object.keys(properties) : [];
}

// --- Probe tools (never executed against the real system) ---

const WEATHER_TOOL: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
    },
    required: ["city"],
  },
};
const CALCULATE_TOOL: ToolDefinition = {
  name: "calculate",
  description: "Evaluate an arithmetic expression exactly.",
  parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
};
const SEARCH_FILES_TOOL: ToolDefinition = {
  name: "search_files",
  description: "Find files in the project whose names match a glob pattern.",
  parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
};
const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a text file from the project.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const SEND_EMAIL_TOOL: ToolDefinition = {
  name: "send_email",
  description: "Send an email.",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
  },
};
const TOOLBOX = [WEATHER_TOOL, CALCULATE_TOOL, SEARCH_FILES_TOOL, READ_FILE_TOOL, SEND_EMAIL_TOOL];
const TOOLBOX_NAMES = TOOLBOX.map((tool) => tool.name);
const TOOL_SYSTEM = "You are a helpful assistant. Use the provided tools when they are needed.";

function conversation(user: string, system = TOOL_SYSTEM): AgentMessage[] {
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

interface ToolCounters {
  textToolCalls: number;
  /** failed native calls that tool-call repair turns into a correct call */
  repairable: number;
}

interface ToolCase {
  id: string;
  prompt: string;
  tool: string;
  check: (args: Record<string, unknown>) => boolean;
}

async function gradeToolCase(
  ctx: ProbeContext,
  testCase: ToolCase,
  tools: ToolDefinition[],
  counters: ToolCounters,
): Promise<CapabilityTrial> {
  const completion = await complete(ctx, conversation(testCase.prompt), tools);
  if (completion.error) return trial(testCase.id, completion, false);
  const first = completion.toolCalls[0];
  // Scores stay native; this records whether Moss's repair would have
  // recovered a correct call, which constrained output and repair rely on.
  const repairable = (): boolean => {
    const candidate = first ?? parseTextToolCalls(completion.text, tools)[0];
    if (!candidate) return false;
    const repaired = repairToolCall(candidate, tools);
    if (repaired.error || repaired.call.name !== testCase.tool) return false;
    const args = parseArguments(repaired.call.arguments);
    const ok = Boolean(args && testCase.check(args));
    if (ok) counters.repairable += 1;
    return ok;
  };
  if (!first) {
    const asText = looksLikeTextToolCall(completion.text, tools.map((tool) => tool.name));
    if (asText) counters.textToolCalls += 1;
    const note = asText ? "Wrote the tool call as text instead of calling it" : "Answered without calling a tool";
    return trial(testCase.id, completion, false, repairable() ? `${note} (Moss can repair it)` : note);
  }
  if (first.name !== testCase.tool) return trial(testCase.id, completion, false, `Called ${first.name} instead of ${testCase.tool}`);
  const args = parseArguments(first.arguments);
  if (!args) return trial(testCase.id, completion, false, "Tool arguments were not valid JSON");
  if (testCase.check(args)) return trial(testCase.id, completion, true);
  const allowed = schemaKeys(tools.find((tool) => tool.name === first.name));
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  const fixable = repairable() ? " (Moss can repair it)" : "";
  if (unknown.length > 0) return trial(testCase.id, completion, false, `Used argument names outside the schema: ${unknown.join(", ")}${fixable}`);
  const echoed = Object.values(args).some((value) => value && typeof value === "object" && ("type" in value || "description" in value));
  if (echoed) return trial(testCase.id, completion, false, `Echoed the parameter schema instead of filling in values${fixable}`);
  return trial(testCase.id, completion, false, `Arguments did not match the request: ${first.arguments.slice(0, 160)}`);
}

async function probeToolCalling(ctx: ProbeContext): Promise<CapabilityProbeResult> {
  const counters: ToolCounters = { textToolCalls: 0, repairable: 0 };
  const cases: ToolCase[] = [
    { id: "weather-paris", prompt: "What is the weather in Paris right now? Use the get_weather tool.", tool: "get_weather", check: (a) => includesText(a.city, /paris/i) },
    { id: "weather-unit", prompt: "Get the current weather in Tokyo, reported in celsius.", tool: "get_weather", check: (a) => includesText(a.city, /tokyo/i) && a.unit === "celsius" },
    { id: "weather-implicit", prompt: "I'm flying to Nairobi tomorrow. Check the weather there for me.", tool: "get_weather", check: (a) => includesText(a.city, /nairobi/i) },
  ];
  const trials: CapabilityTrial[] = [];
  for (const testCase of cases) trials.push(await gradeToolCase(ctx, testCase, [WEATHER_TOOL], counters));
  return summarize("tool-calling", trials, `${passedOf(trials)} native tool calls with correct arguments`, { textToolCalls: counters.textToolCalls, repairable: counters.repairable });
}

async function probeToolSelection(ctx: ProbeContext): Promise<CapabilityProbeResult> {
  const counters: ToolCounters = { textToolCalls: 0, repairable: 0 };
  const cases: ToolCase[] = [
    { id: "select-calculate", prompt: "What is 1847 multiplied by 23? Use a tool to compute it exactly.", tool: "calculate", check: (a) => includesText(a.expression, /1847/) && includesText(a.expression, /23/) },
    { id: "select-search", prompt: "Find every file named config.yaml in the project.", tool: "search_files", check: (a) => includesText(a.pattern, /config\.yaml/i) },
    { id: "select-read", prompt: "Open README.md and show me what it says.", tool: "read_file", check: (a) => includesText(a.path, /readme\.md/i) },
    { id: "select-email", prompt: "Email alex@example.com with the subject \"Standup\" saying I'll be ten minutes late.", tool: "send_email", check: (a) => includesText(a.to, /alex@example\.com/i) && includesText(a.subject, /standup/i) },
  ];
  const trials: CapabilityTrial[] = [];
  for (const testCase of cases) trials.push(await gradeToolCase(ctx, testCase, TOOLBOX, counters));
  return summarize("tool-selection", trials, `${passedOf(trials)} correct tool choices from five options`, { textToolCalls: counters.textToolCalls, repairable: counters.repairable });
}

async function probeToolRestraint(ctx: ProbeContext): Promise<CapabilityProbeResult> {
  const cases = [
    { id: "restraint-echo", prompt: "Reply with only the word: ready", check: (text: string) => /^\W*ready\W*$/i.test(text) },
    { id: "restraint-fact", prompt: "What is the capital of France? Answer in one word without using any tools.", check: (text: string) => /paris/i.test(text) },
  ];
  const trials: CapabilityTrial[] = [];
  for (const testCase of cases) {
    const completion = await complete(ctx, conversation(testCase.prompt), TOOLBOX);
    const text = visibleText(completion.text);
    if (completion.error) trials.push(trial(testCase.id, completion, false));
    else if (completion.toolCalls.length > 0) trials.push(trial(testCase.id, completion, false, `Called ${completion.toolCalls[0].name} when no tool was needed`));
    else if (looksLikeTextToolCall(completion.text, TOOLBOX_NAMES)) trials.push(trial(testCase.id, completion, false, "Wrote a tool call as text when no tool was needed"));
    else if (testCase.check(text)) trials.push(trial(testCase.id, completion, true));
    else trials.push(trial(testCase.id, completion, false, `Answer did not match: ${JSON.stringify(text.slice(0, 120))}`));
  }
  return summarize("tool-restraint", trials, `${passedOf(trials)} direct answers without unnecessary tool calls`);
}

function lowerList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : [];
}

async function probeStructuredOutput(ctx: ProbeContext): Promise<CapabilityProbeResult> {
  const cases: Array<{ id: string; instruction: string; text: string; check: (value: Record<string, unknown>) => boolean }> = [
    {
      id: "json-person",
      instruction: "keys \"name\" (string), \"age\" (integer), \"city\" (string), and \"languages\" (array of strings)",
      text: "Maya Chen is 34 years old and works as a marine biologist in Lisbon. She speaks Portuguese and Mandarin.",
      check: (v) => includesText(v.name, /maya chen/i) && v.age === 34 && includesText(v.city, /lisbon/i)
        && lowerList(v.languages).some((item) => item.includes("portuguese")) && lowerList(v.languages).some((item) => item.includes("mandarin")),
    },
    {
      id: "json-order",
      instruction: "keys \"order_id\" (integer) and \"items\" (array of objects with \"item\" string, \"quantity\" integer, and \"unit_price\" number)",
      text: "Order #5521: 3 notebooks at $4.50 each and 2 pens at $1.25 each.",
      check: (v) => {
        const items = Array.isArray(v.items) ? v.items as Array<Record<string, unknown>> : [];
        return v.order_id === 5521 && items.length === 2
          && items.some((item) => item.quantity === 3 && item.unit_price === 4.5)
          && items.some((item) => item.quantity === 2 && item.unit_price === 1.25);
      },
    },
    {
      id: "json-meeting",
      instruction: "keys \"date\" (YYYY-MM-DD string), \"time\" (HH:MM string), \"room\" (string), and \"attendees\" (array of strings)",
      text: "The design review is on 2026-03-14 at 09:30 in room B12 with Priya and Tom.",
      check: (v) => v.date === "2026-03-14" && v.time === "09:30" && includesText(v.room, /b12/i)
        && lowerList(v.attendees).some((item) => item.includes("priya")) && lowerList(v.attendees).some((item) => item.includes("tom")),
    },
  ];
  const trials: CapabilityTrial[] = [];
  let lenientOnly = 0;
  for (const testCase of cases) {
    const prompt = `Extract the details below into a JSON object with exactly these ${testCase.instruction}. Respond with only the JSON object: no prose and no code fences.\n\nText: ${testCase.text}`;
    const completion = await complete(ctx, conversation(prompt, "You convert text into structured data."));
    if (completion.error) {
      trials.push(trial(testCase.id, completion, false));
      continue;
    }
    const parsed = extractJsonObject(completion.text);
    if (parsed.strict && testCase.check(parsed.strict)) trials.push(trial(testCase.id, completion, true));
    else if (parsed.lenient && testCase.check(parsed.lenient)) {
      lenientOnly += 1;
      trials.push(trial(testCase.id, completion, false, "Correct JSON, but wrapped in prose or code fences", 0.5));
    } else if (parsed.lenient) trials.push(trial(testCase.id, completion, false, "Valid JSON with wrong or missing fields"));
    else trials.push(trial(testCase.id, completion, false, "No parsable JSON object"));
  }
  return summarize("structured-output", trials, `${passedOf(trials)} exact JSON objects${lenientOnly ? `, ${lenientOnly} needed repair` : ""}`, { lenientOnly });
}

async function probeInstructionFollowing(ctx: ProbeContext): Promise<CapabilityProbeResult> {
  const cases: Array<{ id: string; system?: string; prompt: string; check: (text: string) => boolean }> = [
    {
      id: "system-suffix",
      system: "Always end every reply with the exact token <END>.",
      prompt: "Name one planet in our solar system.",
      check: (text) => text.trimEnd().endsWith("<END>"),
    },
    {
      id: "exact-lines",
      prompt: "List three fruits. Use exactly three lines, each starting with \"- \", all lowercase, and no other text.",
      check: (text) => {
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        return lines.length === 3 && lines.every((line) => /^- [a-z][a-z -]*$/.test(line));
      },
    },
    {
      id: "sentence-constraints",
      prompt: "Write one sentence about the ocean that includes the word \"lighthouse\", ends with an exclamation mark, and has fewer than 20 words. Output only the sentence.",
      check: (text) => !text.includes("\n") && /lighthouse/i.test(text) && text.endsWith("!") && text.split(/\s+/).filter(Boolean).length < 20,
    },
    {
      id: "uppercase-word",
      prompt: "What colour is a clear daytime sky? Answer with a single word in uppercase letters only.",
      check: (text) => /^[A-Z]+[.!]?$/.test(text) && text.includes("BLUE"),
    },
  ];
  const trials: CapabilityTrial[] = [];
  for (const testCase of cases) {
    const completion = await complete(ctx, conversation(testCase.prompt, testCase.system ?? "You follow formatting instructions exactly."));
    const text = visibleText(completion.text);
    const passed = !completion.error && testCase.check(text);
    trials.push(trial(testCase.id, completion, passed, passed ? undefined : `Constraint not met: ${JSON.stringify(text.slice(0, 120))}`));
  }
  return summarize("instruction-following", trials, `${passedOf(trials)} verifiable instructions followed`);
}

// --- Usable context (needle in a haystack) ---

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = ["The harbor council", "A cartographer from Velmora", "The northern orchard guild", "An archivist in the salt district", "The river ferry company", "A glassblower near the old mill", "The hill observatory", "A merchant caravan"];
const VERBS = ["recorded", "traded", "repaired", "catalogued", "painted", "measured", "delivered", "restored"];
const OBJECTS = ["forty crates of amber lanterns", "a ledger of tide tables", "the copper weather vanes", "three bolts of indigo cloth", "a map of the eastern marshes", "the cedar bridge railings", "a shipment of winter pears", "the chapel bell ropes"];
const TAILS = ["before the autumn fair.", "during the long winter.", "while the canal was frozen.", "on the first market day.", "after the spring floods.", "under a clear evening sky.", "for the lantern festival.", "as the tide went out."];
const CODE_WORDS = ["KESTREL", "MARLIN", "QUARTZ", "EMBER", "JUNIPER", "SABLE", "ORCHID", "TUNDRA"];

/** Deterministic filler document of roughly `targetTokens` with one passcode
 *  sentence inserted at the given relative depth. */
export function buildHaystack(targetTokens: number, seed: number, depth: number, charsPerToken = INITIAL_CHARS_PER_TOKEN): { prompt: string; code: string } {
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const code = `${Math.floor(100 + random() * 900)}-${pick(CODE_WORDS)}-${Math.floor(10 + random() * 90)}`;
  const targetChars = Math.max(1_000, Math.floor(targetTokens * 0.9 * charsPerToken) - 400);
  const sentences: string[] = [];
  let length = 0;
  while (length < targetChars) {
    const sentence = `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}`;
    sentences.push(sentence);
    length += sentence.length + 1;
  }
  sentences.splice(Math.floor(sentences.length * depth), 0, `Important: the vault passcode is ${code}.`);
  const prompt = [
    "Below is a long document. Somewhere in it is a vault passcode.",
    "",
    "<document>",
    sentences.join(" "),
    "</document>",
    "",
    "What is the vault passcode? Reply with the passcode only.",
  ].join("\n");
  return { prompt, code };
}

async function probeUsableContext(ctx: ProbeContext, maxContextTokens: number, report: (message: string) => void): Promise<CapabilityProbeResult> {
  const levels = CONTEXT_LEVELS.filter((level) => level <= maxContextTokens);
  const depths = [0.5, 0.25, 0.75];
  const timeoutMs = Math.max(MIN_CONTEXT_TIMEOUT_MS, shortTimeout(ctx) * 2);
  const trials: CapabilityTrial[] = [];
  let usableContextTokens = 0;
  let truncatedAt = 0;
  let recallFailedAt = 0;
  // Tokenizers differ; recalibrate from the provider's reported input tokens so
  // each level lands near its nominal size instead of a fixed guess.
  let charsPerToken = INITIAL_CHARS_PER_TOKEN;
  for (const [index, level] of levels.entries()) {
    report(`${Math.round(level / 1024)}K tokens`);
    const { prompt, code } = buildHaystack(level, level + 17, depths[index % depths.length], charsPerToken);
    const expectedTokens = Math.round(prompt.length / charsPerToken);
    const completion = await complete(ctx, [{ role: "user", content: prompt }], undefined, timeoutMs);
    const found = !completion.error && visibleText(completion.text).includes(code);
    const reported = completion.inputTokens;
    const truncated = reported !== undefined && reported < expectedTokens * 0.6;
    if (reported && !truncated) charsPerToken = Math.min(8, Math.max(2, prompt.length / reported));
    let note: string | undefined;
    if (!found && !completion.error && truncated) {
      truncatedAt = level;
      note = `Provider counted only ${reported.toLocaleString("en-US")} input tokens for a ~${expectedTokens.toLocaleString("en-US")}-token prompt; the server likely truncated the context`;
    } else if (!found && !completion.error) {
      recallFailedAt = level;
      note = "Passcode not recalled";
    }
    trials.push(trial(`context-${level}`, completion, found, note));
    if (!found) break;
    usableContextTokens = reported && !truncated ? reported : expectedTokens;
  }
  const passedLevels = trials.filter((item) => item.passed).length;
  const result = summarize(
    "usable-context",
    trials,
    usableContextTokens ? `Recalled a buried fact at up to ~${usableContextTokens.toLocaleString("en-US")} tokens` : "Could not recall a buried fact at the smallest size",
    {
      usableContextTokens,
      maxContextTested: levels.at(-1) ?? 0,
      allPassed: passedLevels === levels.length ? 1 : 0,
      ...(truncatedAt ? { truncatedAt } : {}),
      ...(recallFailedAt ? { recallFailedAt } : {}),
    },
  );
  // Levels never reached count against the score: the measured ceiling is what matters.
  return { ...result, score: levels.length ? Math.round((passedLevels / levels.length) * 1000) / 1000 : 0 };
}

// --- Plan coherence (multi-step tool loop against in-memory registers) ---

const READ_REGISTER_TOOL: ToolDefinition = {
  name: "read_register",
  description: "Read the integer stored in a register such as r1.",
  parameters: { type: "object", properties: { name: { type: "string", description: "Register name, for example r1" } }, required: ["name"] },
};
const SUBMIT_ANSWER_TOOL: ToolDefinition = {
  name: "submit_answer",
  description: "Submit the final numeric answer. Call this exactly once, at the end.",
  parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
};

export function registerValues(count: number): number[] {
  return Array.from({ length: count }, (_, index) => ((index + 1) * 37 + count * 11) % 90 + 10);
}

async function runPlanChain(ctx: ProbeContext, length: number): Promise<CapabilityTrial> {
  const now = ctx.now ?? Date.now;
  const values = registerValues(length);
  const expected = values.reduce((sum, value) => sum + value, 0);
  const messages: AgentMessage[] = conversation(
    `Registers r1 through r${length} each hold an integer. Read every register with read_register, one register per call, then call submit_answer with the sum of all ${length} values. Do not guess any value.`,
    "You complete tasks by calling tools. Gather information with tools and never guess values.",
  );
  const read = new Set<number>();
  const started = now();
  let inputTokens = 0;
  let outputTokens = 0;
  const finish = (passed: boolean, note?: string, errored = false): CapabilityTrial => ({
    id: `plan-${length}`,
    passed,
    score: passed ? 1 : 0,
    ...(note ? { note } : {}),
    ...(errored ? { errored: true } : {}),
    durationMs: now() - started,
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
  });
  for (let round = 0; round < length + 4; round++) {
    const completion = await complete(ctx, messages, [READ_REGISTER_TOOL, SUBMIT_ANSWER_TOOL]);
    inputTokens += completion.inputTokens ?? 0;
    outputTokens += completion.outputTokens ?? 0;
    if (completion.toolsUnsupported) return finish(false, TOOLS_UNSUPPORTED_NOTE);
    if (completion.error) return finish(false, `Provider error: ${completion.error}`, true);
    if (completion.toolCalls.length === 0) {
      const text = visibleText(completion.text);
      if (text.includes(String(expected))) return finish(false, "Answered in text instead of calling submit_answer");
      return finish(false, read.size === length ? "Read every register but never called submit_answer with the correct sum" : `Stopped after reading ${read.size}/${length} registers`);
    }
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const args = parseArguments(call.arguments);
      if (call.name === "read_register") {
        const index = Number(String(args?.name ?? "").match(/^r?(\d+)$/i)?.[1]);
        const value = Number.isInteger(index) && index >= 1 && index <= length ? values[index - 1] : undefined;
        if (value !== undefined) read.add(index);
        messages.push({ role: "tool", toolCallId: call.id, content: value !== undefined ? String(value) : `Unknown register: ${String(args?.name ?? "")}` });
      } else if (call.name === "submit_answer") {
        const submitted = Number(args?.value);
        if (read.size < length) return finish(false, `Submitted after reading only ${read.size}/${length} registers`);
        return submitted === expected ? finish(true) : finish(false, `Submitted ${String(args?.value)} instead of ${expected}`);
      } else {
        messages.push({ role: "tool", toolCallId: call.id, content: `Unknown tool: ${call.name}` });
      }
    }
  }
  return finish(false, `Did not finish within ${length + 4} rounds`);
}

async function probePlanCoherence(ctx: ProbeContext, report: (message: string) => void): Promise<CapabilityProbeResult> {
  const trials: CapabilityTrial[] = [];
  let maxCoherentSteps = 0;
  for (const length of PLAN_LENGTHS) {
    report(`${length + 1}-call tool chain`);
    const result = await runPlanChain(ctx, length);
    trials.push(result);
    if (result.passed) maxCoherentSteps = Math.max(maxCoherentSteps, length + 1);
  }
  const passed = trials.filter((item) => item.passed).length;
  return summarize(
    "plan-coherence",
    trials,
    maxCoherentSteps ? `Completed sequential tool chains of up to ${maxCoherentSteps} calls` : "Could not complete a short sequential tool chain",
    { maxCoherentSteps, passedChains: passed },
  );
}

export const DIMENSION_LABELS: Record<CapabilityDimension, string> = {
  "tool-calling": "Tool calling",
  "tool-selection": "Tool selection",
  "tool-restraint": "Tool restraint",
  "structured-output": "Structured output",
  "instruction-following": "Instruction following",
  "usable-context": "Usable context",
  "plan-coherence": "Plan coherence",
};

export interface ProbeSuiteOptions {
  maxContextTokens?: number;
  dimensions?: readonly CapabilityDimension[];
  onProgress?: (progress: ModelProbeProgress) => void;
}

export class ProbeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeUnavailableError";
  }
}

export interface ProbeSuiteRun {
  results: CapabilityProbeResult[];
  warmupMs: number;
}

/** One generous-timeout request that loads a local model into memory, so the
 *  first measured request is not charged for model loading. */
export async function warmUp(ctx: ProbeContext): Promise<ProbeCompletion> {
  const warmup = await complete(ctx, conversation("Reply with the single word OK.", "You are a helpful assistant."), undefined, Math.max(MIN_WARMUP_TIMEOUT_MS, shortTimeout(ctx) * 2));
  if (warmup.error) throw new ProbeUnavailableError(`${ctx.model} did not respond to a warm-up request: ${warmup.error}`);
  return warmup;
}

/** Runs one untimed warm-up request (which loads a local model into memory),
 *  then each selected probe. A model that cannot answer the warm-up at all is
 *  reported as unavailable rather than scored as incapable. */
export async function runCapabilityProbes(ctx: ProbeContext, options: ProbeSuiteOptions = {}): Promise<ProbeSuiteRun> {
  const dimensions = ALL_DIMENSIONS.filter((dimension) => !options.dimensions || options.dimensions.includes(dimension));
  const maxContextTokens = Math.max(CONTEXT_LEVELS[0], options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS);
  options.onProgress?.({ dimension: dimensions[0] ?? "tool-calling", completedDimensions: 0, totalDimensions: dimensions.length, message: "Loading the model" });
  const warmup = await warmUp(ctx);
  const results: CapabilityProbeResult[] = [];
  for (const [index, dimension] of dimensions.entries()) {
    const report = (detail?: string): void => options.onProgress?.({
      dimension,
      completedDimensions: index,
      totalDimensions: dimensions.length,
      message: `${DIMENSION_LABELS[dimension]}${detail ? `: ${detail}` : ""}`,
    });
    report();
    if (dimension === "tool-calling") results.push(await probeToolCalling(ctx));
    else if (dimension === "tool-selection") results.push(await probeToolSelection(ctx));
    else if (dimension === "tool-restraint") results.push(await probeToolRestraint(ctx));
    else if (dimension === "structured-output") results.push(await probeStructuredOutput(ctx));
    else if (dimension === "instruction-following") results.push(await probeInstructionFollowing(ctx));
    else if (dimension === "usable-context") results.push(await probeUsableContext(ctx, maxContextTokens, report));
    else results.push(await probePlanCoherence(ctx, report));
  }
  return { results, warmupMs: warmup.durationMs };
}
