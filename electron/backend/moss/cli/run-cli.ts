// electron/backend/moss/cli/run-cli.ts
//
// Headless Moss: runs one agent turn with the same kernel the desktop app
// uses (tool loop, permission policy, provenance gate, stall supervisor,
// verification, constrained output) without Electron. It drives CI jobs and
// other front ends.
//
//   npm run moss -- --model llama3.1:8b --prompt "Why does npm test fail?"
//   npm run moss -- --model qwen2.5:7b --approve safe --verify "npm test" \
//     --prompt "Fix the failing test" --json > run.jsonl

import { createInterface } from "node:readline/promises";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentMessage, ModelCapabilityProfile, MossEvent, ProviderConfig, ProviderKind, ToolApprovalResponse } from "../../../../common/types";
import { runTurn, type CompletionContext, type CompletionDecision } from "../agent-runner";
import { modelProfileStore } from "../models/model-profile-store";
import { applyScaffoldingMessages, planScaffolding } from "../models/scaffolding";
import { StepProtocolProvider } from "../models/step-protocol";
import { findToolTool, semanticIndex } from "../models/tool-index";
import { classifyTool } from "../permission";
import { createProvider } from "../providers";
import type { ChatProvider } from "../providers/types";
import { setUserDataDir } from "../runtime/user-data";
import { buildSystemMessage } from "../system-prompt";
import { TOOL_DEFINITIONS, TOOL_REGISTRY, type Tool } from "../tools";
import { formatVerifyReport, runVerify } from "../verify/verifier";

/** Failed-verification answers sent back before the run gives up and fails. */
const MAX_COMPLETION_REJECTIONS = 3;

const HEADLESS_INSTRUCTIONS = "You are running headless: nobody can answer questions until the run ends. Do not ask for confirmation or offer options; do the work with the tools you have, then report what you did. A call that needs approval may be refused; if so, continue without it and say what still needs a person.";

/** deny: every prompted call is refused. safe: mutating tools run, while
 *  destructive and untrusted-derived calls are refused. ask: prompt on the
 *  terminal. There is deliberately no mode that approves those calls unseen. */
export type ApproveMode = "deny" | "safe" | "ask";
export type ConstrainedMode = "auto" | "always" | "never";

export interface RunCliOptions {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  workspace: string;
  prompt?: string;
  approve: ApproveMode;
  verify: string[];
  maxRounds?: number;
  constrained: ConstrainedMode;
  json: boolean;
  eventsOut?: string;
  dataDir: string;
  instructions?: string;
  tools: boolean;
  profileFile?: string;
}

export interface RunCliDependencies {
  createProvider?: (config: ProviderConfig) => ChatProvider;
  env?: NodeJS.ProcessEnv;
  io?: { stdout: (text: string) => void; stderr: (text: string) => void };
  /** Reads the prompt when --prompt is absent. */
  readStdin?: () => Promise<string>;
  /** Answers an approval question in ask mode. */
  ask?: (question: string) => Promise<string>;
  /** Measured profile lookup for scaffolding and --constrained auto. */
  loadProfile?: (options: RunCliOptions) => Promise<ModelCapabilityProfile | null>;
  runVerify?: typeof runVerify;
  signal?: AbortSignal;
}

export const RUN_USAGE = "Usage: moss --model NAME [--prompt TEXT | --prompt-file FILE | stdin] [--base-url URL] [--kind openai-compatible|anthropic] [--api-key-env VAR] [--workspace DIR] [--approve deny|safe|ask] [--verify CMD ...] [--max-rounds N] [--constrained auto|always|never] [--no-tools] [--profile FILE] [--instructions FILE] [--json] [--events-out FILE] [--data-dir DIR]";

/** The desktop app's data folder, so headless runs share its profiles and lessons. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = env.MOSS_USER_DATA?.trim();
  if (fromEnv) return fromEnv;
  if (platform === "win32") return join(env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "moss");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "moss");
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "moss");
}

export function parseRunArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): RunCliOptions {
  const options: RunCliOptions = {
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    workspace: cwd,
    approve: "deny",
    verify: [],
    constrained: "auto",
    json: false,
    dataDir: defaultDataDir(env),
    tools: true,
  };
  let apiKeyEnv = "MOSS_API_KEY";
  let promptFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      index += 1;
      return value;
    };
    if (flag === "--model") options.model = need().trim();
    else if (flag === "--prompt") options.prompt = need();
    else if (flag === "--prompt-file") promptFile = need();
    else if (flag === "--base-url") options.baseUrl = need();
    else if (flag === "--kind") {
      const kind = need();
      if (kind !== "openai-compatible" && kind !== "anthropic") throw new Error(`Unsupported provider kind: ${kind}`);
      options.kind = kind;
    } else if (flag === "--api-key-env") apiKeyEnv = need();
    else if (flag === "--workspace") options.workspace = resolve(cwd, need());
    else if (flag === "--approve") {
      const mode = need();
      if (mode !== "deny" && mode !== "safe" && mode !== "ask") throw new Error(`--approve must be deny, safe or ask (got ${mode})`);
      options.approve = mode;
    } else if (flag === "--verify") options.verify.push(need());
    else if (flag === "--max-rounds") {
      const rounds = Number(need());
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("--max-rounds must be an integer from 1 to 100");
      options.maxRounds = rounds;
    } else if (flag === "--constrained") {
      const mode = need();
      if (mode !== "auto" && mode !== "always" && mode !== "never") throw new Error(`--constrained must be auto, always or never (got ${mode})`);
      options.constrained = mode;
    } else if (flag === "--no-tools") options.tools = false;
    else if (flag === "--instructions") options.instructions = readFileSync(resolve(cwd, need()), "utf8");
    else if (flag === "--json") options.json = true;
    else if (flag === "--events-out") options.eventsOut = resolve(cwd, need());
    else if (flag === "--data-dir") options.dataDir = resolve(cwd, need());
    else if (flag === "--profile") options.profileFile = resolve(cwd, need());
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.model) throw new Error("--model is required");
  if (options.prompt !== undefined && promptFile) throw new Error("Use either --prompt or --prompt-file, not both");
  if (promptFile) options.prompt = readFileSync(resolve(cwd, promptFile), "utf8");
  if (options.constrained === "always" && options.kind !== "openai-compatible") throw new Error("--constrained always needs an openai-compatible endpoint");
  const apiKey = env[apiKeyEnv]?.trim();
  if (apiKey) options.apiKey = apiKey;
  return options;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** The measured profile from --profile (probe CLI output) or the app's store. */
async function loadProfile(options: RunCliOptions): Promise<ModelCapabilityProfile | null> {
  if (options.profileFile) {
    const value = JSON.parse(readFileSync(options.profileFile, "utf8")) as { profiles?: ModelCapabilityProfile[] } | ModelCapabilityProfile;
    const profiles = "profiles" in value && Array.isArray(value.profiles) ? value.profiles : [value as ModelCapabilityProfile];
    const match = profiles.find((item) => item?.model === options.model);
    if (!match) throw new Error(`${options.profileFile} has no profile for ${options.model}`);
    return match;
  }
  return modelProfileStore.get(options.kind, options.baseUrl, options.model).catch(() => null);
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function runMossCli(args: readonly string[], dependencies: RunCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) };
  const env = dependencies.env ?? process.env;
  let options: RunCliOptions;
  try {
    options = parseRunArgs(args, env);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${RUN_USAGE}\n`);
    return 2;
  }
  setUserDataDir(options.dataDir);

  const promptFromStdin = options.prompt === undefined;
  const prompt = (options.prompt ?? await (dependencies.readStdin ?? readAllStdin)()).trim();
  if (!prompt) {
    io.stderr(`No prompt given.\n${RUN_USAGE}\n`);
    return 2;
  }
  if (options.approve === "ask" && promptFromStdin && !dependencies.ask) {
    io.stderr("--approve ask needs the terminal for answers, so pass the prompt with --prompt or --prompt-file.\n");
    return 2;
  }

  const emit = (event: Record<string, unknown>): void => {
    const line = `${JSON.stringify(event)}\n`;
    if (options.json) io.stdout(line);
    if (options.eventsOut) appendFileSync(options.eventsOut, line, "utf8");
  };
  if (options.eventsOut) {
    mkdirSync(dirname(options.eventsOut), { recursive: true });
    writeFileSync(options.eventsOut, "", "utf8");
  }
  const info = (text: string): void => {
    if (!options.json) io.stderr(`${text}\n`);
  };

  const profile = options.tools ? await (dependencies.loadProfile ?? loadProfile)(options) : null;
  const tier = profile?.tier;
  const constrained = options.tools && options.kind === "openai-compatible"
    && (options.constrained === "always" || (options.constrained === "auto" && (tier === "limited" || tier === "unreliable")));
  const config: ProviderConfig = { kind: options.kind, baseUrl: options.baseUrl, model: options.model, ...(options.apiKey ? { apiKey: options.apiKey } : {}) };
  const base = (dependencies.createProvider ?? createProvider)(config);
  const provider = constrained ? new StepProtocolProvider(base) : base;

  emit({ type: "run-start", model: options.model, endpoint: options.baseUrl, workspace: options.workspace, approve: options.approve, constrained, ...(tier ? { tier } : {}), verify: options.verify });
  info(`moss: ${options.model} at ${options.baseUrl} in ${options.workspace}${tier ? ` (${tier})` : ""}${constrained ? ", constrained output" : ""}, approvals: ${options.approve}`);

  // The same adaptive scaffolding as the desktop app: a measured weak model
  // gets fewer, relevant tools, step guidance and find_tool to recover others.
  let scaffolding = planScaffolding(profile, options.tools ? TOOL_DEFINITIONS : [], prompt);
  const narrowed = scaffolding.tools.length < TOOL_DEFINITIONS.length && options.tools;
  if (narrowed) {
    const ranked = await semanticIndex.rankTools(TOOL_DEFINITIONS, prompt, scaffolding.tools.length);
    scaffolding = { ...scaffolding, tools: [...ranked, { name: findToolTool.name, description: findToolTool.description, parameters: findToolTool.parameters }] };
  }
  if (scaffolding.notice) info(`note: ${scaffolding.notice}`);
  else if (options.tools && !profile) info(`note: no capability profile for ${options.model}, so no scaffolding. Measure it with npm run probe -- --model ${options.model} --output profile.json, then pass --profile profile.json.`);
  emit({ type: "scaffolding", level: scaffolding.level, tools: scaffolding.tools.map((tool) => tool.name) });
  // The registry is what can actually run, so it must never exceed what was offered.
  const toolRegistry = !options.tools ? new Map<string, Tool>() : narrowed ? new Map([...TOOL_REGISTRY, [findToolTool.name, findToolTool]]) : TOOL_REGISTRY;

  const messages: AgentMessage[] = [
    buildSystemMessage({
      includeSkills: false,
      includeMemory: false,
      query: prompt,
      customInstructions: [HEADLESS_INSTRUCTIONS, options.instructions?.trim()].filter(Boolean).join("\n\n"),
    }),
    { role: "user", content: prompt },
  ];
  const pendingApprovals = new Map<string, Extract<MossEvent, { type: "tool-approval-request" }>>();
  let lastVerification: boolean | undefined;
  let changedSinceVerification = false;
  let failure: string | undefined;
  let aborted = false;
  let finalText = "";
  let streamedText = false;

  const onEvent = (event: MossEvent): void => {
    emit(event as unknown as Record<string, unknown>);
    switch (event.type) {
      case "text-delta":
        if (!options.json) io.stdout(event.text);
        streamedText = true;
        break;
      case "round-start":
        if (streamedText && !options.json) io.stdout("\n");
        streamedText = false;
        break;
      case "tool-call":
        info(`→ ${event.name} ${oneLine(event.arguments)}`);
        break;
      case "tool-approval-request":
        pendingApprovals.set(event.callId, event);
        break;
      case "tool-result":
        // Anything but an allow-listed read may change what the checks see.
        if (event.ok && classifyTool(event.name) !== "allow") changedSinceVerification = true;
        info(`${event.ok ? "✓" : "✗"} ${event.name}${event.ok ? "" : `: ${oneLine(event.content)}`}`);
        break;
      case "notice":
        info(`${event.level === "warn" ? "warning" : "note"}: ${event.message}`);
        break;
      case "verification":
        lastVerification = event.ok;
        changedSinceVerification = false;
        info(`verification ${event.ok ? "passed" : "failed"} (${event.checkCount} check${event.checkCount === 1 ? "" : "s"})`);
        break;
      case "supervisor":
        info(`supervisor ${event.action}: ${event.reason}`);
        break;
      case "turn-complete": {
        const last = [...event.messages].reverse().find((message) => message.role === "assistant");
        finalText = typeof last?.content === "string" ? last.content : "";
        break;
      }
      case "turn-aborted":
        aborted = true;
        break;
      case "turn-error":
        failure = event.message;
        info(`error (${event.source}): ${event.message}`);
        break;
      default:
        break;
    }
  };

  const requestApproval = async (callId: string): Promise<ToolApprovalResponse> => {
    const request = pendingApprovals.get(callId);
    pendingApprovals.delete(callId);
    const label = request ? `${request.name} ${oneLine(request.arguments, 240)}` : callId;
    let response: ToolApprovalResponse;
    if (options.approve === "ask") {
      const why = request?.provenance ? " (after untrusted content)" : request?.risk ? ` (${request.risk})` : "";
      const answer = (await (dependencies.ask ?? askOnTerminal)(`Approve ${label}${why}? [y/N] `)).trim().toLowerCase();
      response = answer === "y" || answer === "yes"
        ? { approved: true }
        : { approved: false, comment: "The user declined this call." };
    } else {
      response = { approved: false, comment: `Headless run with --approve ${options.approve}: this call needs a person to approve it, so it was not run. Continue without it or explain what approval is needed.` };
      info(`denied ${label}`);
    }
    emit({ type: "approval-decision", callId, approved: response.approved });
    return response;
  };

  const controller = new AbortController();
  // With --verify, the turn cannot end until the checks pass: a final answer
  // that never ran them, or ran them and failed, is sent back to the model.
  let completionRejections = 0;
  const completionGuard = async (context: CompletionContext): Promise<CompletionDecision> => {
    // The runner stops re-verifying after a few cycles, so its latest result
    // can predate later changes; re-run the checks whenever it might be stale.
    let result = changedSinceVerification ? undefined : context.latestVerification;
    if (!result) {
      result = await (dependencies.runVerify ?? runVerify)(options.verify, options.workspace, controller.signal);
      onEvent({ type: "verification", ok: result.ok, checkCount: result.results.length });
    }
    if (result.ok || completionRejections >= MAX_COMPLETION_REJECTIONS) return { accept: true };
    completionRejections += 1;
    return {
      accept: false,
      feedback: `The run is not done: its verification checks fail.\n${formatVerifyReport(result)}\nFix the cause with the tools you have, then finish.`,
    };
  };
  const onSignal = (): void => controller.abort();
  dependencies.signal?.addEventListener("abort", onSignal, { once: true });
  if (!dependencies.signal) process.once("SIGINT", onSignal);
  try {
    await runTurn({
      provider,
      model: options.model,
      messages: applyScaffoldingMessages(messages, scaffolding),
      tools: scaffolding.tools,
      toolRegistry,
      ...(narrowed ? { toolCatalog: TOOL_DEFINITIONS } : {}),
      ...(scaffolding.maxToolCallsPerRound ? { maxToolCallsPerRound: scaffolding.maxToolCallsPerRound } : {}),
      workspaceRoot: options.workspace,
      signal: controller.signal,
      onEvent,
      requestApproval,
      autoApprove: options.approve === "safe",
      ...(options.verify.length > 0 ? { verify: { enabled: true, commands: options.verify }, completionGuard } : {}),
      ...(dependencies.runVerify ? { verificationRunner: dependencies.runVerify } : {}),
      ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    info(`error: ${failure}`);
  } finally {
    dependencies.signal?.removeEventListener("abort", onSignal);
    if (!dependencies.signal) process.removeListener("SIGINT", onSignal);
  }

  // Done means the verifiers passed, not that the model said so.
  const ok = !failure && !aborted && lastVerification !== false;
  const exitCode = aborted ? 130 : ok ? 0 : 1;
  if (streamedText && !options.json) io.stdout("\n");
  emit({ type: "run-summary", ok, exitCode, ...(lastVerification !== undefined ? { verified: lastVerification } : {}), ...(failure ? { error: failure } : {}), finalText });
  if (!options.json && lastVerification === false) io.stderr("moss: the last verification failed, so this run is not done.\n");
  return exitCode;
}

if (require.main === module) {
  void runMossCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
