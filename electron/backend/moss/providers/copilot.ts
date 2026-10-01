// electron/backend/moss/providers/copilot.ts
//
// GitHub Copilot as a model provider, through the official Copilot SDK. Moss
// keeps driving the turn: its tools are declared to Copilot without handlers,
// so when a model calls one the SDK pauses and Moss runs the call through its
// own permission policy, provenance gate, and verification. The next round
// answers the paused call on the same Copilot session, so a multi-round turn
// costs one Copilot prompt rather than one per round.
//
// Copilot's own tools (shell, file edits, web) are never enabled: the client
// runs in "empty" mode with only Moss's declared tools available.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { AgentMessage, ToolDefinition } from "../../../../common/types";
import { userDataDir } from "../runtime/user-data";
import { ProviderError } from "./types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./types";

/** Tool names are prefixed so Copilot's built-in tools of the same name never answer them. */
const TOOL_PREFIX = "moss_";
/** A turn abandoned mid-round releases its paused Copilot session after this long. */
const PENDING_SESSION_TTL_MS = 15 * 60_000;

// --- The part of the SDK Moss uses, so tests can supply a fake. ---

export interface CopilotEvent {
  type: string;
  agentId?: string;
  data: Record<string, unknown>;
}

export interface CopilotSessionLike {
  on(handler: (event: CopilotEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: { tools: { handlePendingToolCall(params: { requestId: string; result?: string; error?: string }): Promise<{ success: boolean }> } };
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  listModels(): Promise<Array<{ id: string; policy?: { state?: string } }>>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
}

export interface CopilotClientOptions {
  gitHubToken?: string;
  baseDirectory: string;
  workingDirectory: string;
  cliPath?: string;
}

export type CopilotClientFactory = (options: CopilotClientOptions) => CopilotClientLike;

/** The real SDK, loaded only when a Copilot route is used. */
const sdkClientFactory: CopilotClientFactory = (options) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@github/copilot-sdk") as typeof import("@github/copilot-sdk");
  return new sdk.CopilotClient({
    mode: "empty",
    baseDirectory: options.baseDirectory,
    workingDirectory: options.workingDirectory,
    clientInfo: { applicationName: "moss" },
    ...(options.gitHubToken ? { gitHubToken: options.gitHubToken, useLoggedInUser: false } : {}),
    ...(options.cliPath ? { connection: sdk.RuntimeConnection.forStdio({ path: options.cliPath }) } : {}),
  }) as unknown as CopilotClientLike;
};

/** Inside a packaged app the runtime executable lives in app.asar.unpacked,
 *  which the SDK's own lookup does not know about. */
export function packagedRuntimePath(entry = __dirname, resolveSdk: () => string = () => require.resolve("@github/copilot-sdk")): string | undefined {
  if (!entry.includes(".asar")) return undefined;
  const platform = `${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
  try {
    // The SDK does not export its package.json, so walk up from its entry point.
    let sdkRoot = dirname(resolveSdk());
    while (basename(sdkRoot) !== "copilot-sdk" && dirname(sdkRoot) !== sdkRoot) sdkRoot = dirname(sdkRoot);
    const packageName = `copilot-sdk-${platform}`;
    // The platform package may be nested under the SDK or sit beside it.
    const candidates = [join(sdkRoot, "node_modules", "@github", packageName), join(sdkRoot, "..", packageName)]
      .map((root) => join(root, "prebuilds", platform, executable).replace(/app\.asar([\\/])/, "app.asar.unpacked$1"));
    return candidates.find((candidate) => existsSync(candidate));
  } catch {
    return undefined;
  }
}
/** Token from the GitHub CLI sign-in, read when needed and never stored. */
export function githubCliToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const token = String(stdout ?? "").trim();
      resolve(error || !token ? undefined : token);
    });
  });
}

// --- Shared clients: one runtime per sign-in. ---

interface Connection {
  client: Promise<CopilotClientLike>;
}

const connections = new Map<string, Connection>();

function connectionKey(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "default";
}

async function clientFor(apiKey: string | undefined, factory: CopilotClientFactory, resolveCliToken: () => Promise<string | undefined>): Promise<CopilotClientLike> {
  const token = apiKey?.trim() || await resolveCliToken();
  const key = connectionKey(token);
  let connection = connections.get(key);
  if (!connection) {
    const client = (async () => {
      const baseDirectory = join(userDataDir(), "copilot");
      const workingDirectory = join(baseDirectory, "work");
      mkdirSync(workingDirectory, { recursive: true });
      const cliPath = packagedRuntimePath();
      const created = factory({ baseDirectory, workingDirectory, ...(token ? { gitHubToken: token } : {}), ...(cliPath ? { cliPath } : {}) });
      await created.start();
      return created;
    })();
    connection = { client };
    connections.set(key, connection);
    client.catch(() => connections.delete(key));
  }
  return connection.client;
}

/** Stop every Copilot runtime; called when the app quits. */
export async function stopCopilotClients(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map(async (connection) => {
    try {
      await (await connection.client).stop();
    } catch {
      // already gone
    }
  }));
}

// --- Turning Moss's stateless rounds into one Copilot session per turn. ---

interface PendingSession {
  session: CopilotSessionLike;
  model: string;
  toolsKey: string;
  /** Moss call id (the Copilot tool call id) to the SDK request that awaits it */
  pending: Map<string, string>;
  queue: EventQueue;
  unsubscribe: () => void;
  expiry: ReturnType<typeof setTimeout>;
}

const pendingSessions = new Set<PendingSession>();

class EventQueue {
  private readonly items: CopilotEvent[] = [];
  private waiter: (() => void) | undefined;

  push(event: CopilotEvent): void {
    this.items.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }

  async next(signal: AbortSignal): Promise<CopilotEvent> {
    while (this.items.length === 0) {
      if (signal.aborted) throw new Error("aborted");
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return this.items.shift()!;
  }
}

function toolsKey(tools: readonly ToolDefinition[] | undefined): string {
  return (tools ?? []).map((tool) => tool.name).sort().join(",");
}

function release(entry: PendingSession): void {
  pendingSessions.delete(entry);
  clearTimeout(entry.expiry);
  entry.unsubscribe();
  void entry.session.disconnect().catch(() => undefined);
}

function messageText(message: AgentMessage): string {
  const calls = (message.toolCalls ?? []).map((call) => `[called ${call.name} with ${call.arguments}]`);
  return [message.content, ...calls].filter((part) => part && part.trim()).join("\n");
}

/** One prompt for a fresh session: earlier messages as a transcript, then the request. */
export function renderPrompt(messages: readonly AgentMessage[]): string {
  const history = messages.filter((message) => message.role !== "system");
  const names = new Map<string, string>();
  for (const message of history) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  const last = history.at(-1);
  const ask = last?.role === "user" ? last : undefined;
  const earlier = ask ? history.slice(0, -1) : history;
  const transcript = earlier.map((message) => {
    if (message.role === "tool") return `Tool result (${names.get(message.toolCallId ?? "") ?? "tool"}):\n${message.content}`;
    return `${message.role === "user" ? "User" : "Assistant"}:\n${messageText(message)}`;
  }).join("\n\n");
  if (!ask) return `${transcript}\n\nContinue from here.`;
  return transcript ? `Earlier in this conversation:\n\n${transcript}\n\n---\n\n${ask.content}` : ask.content;
}

function systemPrompt(request: ChatRequest): string {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const schema = request.responseSchema
    ? `\n\nReply with only a single JSON object that matches this JSON schema:\n${JSON.stringify(request.responseSchema)}`
    : "";
  return `${system}${schema}`.trim() || "You are a helpful assistant.";
}

export interface CopilotProviderOptions {
  apiKey?: string;
  createClient?: CopilotClientFactory;
  resolveCliToken?: () => Promise<string | undefined>;
}

export class CopilotProvider implements ChatProvider {
  readonly kind = "github-copilot";
  private readonly factory: CopilotClientFactory;
  private readonly resolveCliToken: () => Promise<string | undefined>;

  constructor(private readonly options: CopilotProviderOptions = {}) {
    this.factory = options.createClient ?? sdkClientFactory;
    this.resolveCliToken = options.resolveCliToken ?? githubCliToken;
  }

  private client(): Promise<CopilotClientLike> {
    return clientFor(this.options.apiKey, this.factory, this.resolveCliToken).catch((error: unknown) => {
      throw new ProviderError(`GitHub Copilot could not start: ${error instanceof Error ? error.message : String(error)}. Sign in with the GitHub CLI (gh auth login) or enter a GitHub token in Settings.`, 401);
    });
  }

  async listModels(): Promise<string[]> {
    const client = await this.client();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      throw new ProviderError(`Not signed in to GitHub Copilot${auth.statusMessage ? ` (${auth.statusMessage})` : ""}. Sign in with the GitHub CLI (gh auth login) or enter a GitHub token in Settings.`, 401);
    }
    const models = await client.listModels();
    return models.filter((model) => model.policy?.state !== "disabled").map((model) => model.id);
  }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const entry = this.continuation(request) ?? await this.startSession(request);
    const onAbort = (): void => {
      void entry.session.abort().catch(() => undefined);
      release(entry);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield* this.round(entry, request, signal);
    } catch (error) {
      release(entry);
      if (signal.aborted) throw error;
      throw error instanceof ProviderError ? error : new ProviderError(`GitHub Copilot: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** A paused session whose calls this request answers, answered and resumed. */
  private continuation(request: ChatRequest): PendingSession | undefined {
    const trailing: AgentMessage[] = [];
    for (let index = request.messages.length - 1; index >= 0 && request.messages[index].role === "tool"; index--) trailing.unshift(request.messages[index]);
    if (trailing.length === 0) return undefined;
    const answered = new Map(trailing.map((message) => [message.toolCallId, message.content]));
    const entry = [...pendingSessions].find((candidate) => candidate.model === request.model
      && candidate.toolsKey === toolsKey(request.tools)
      && [...candidate.pending.keys()].every((callId) => answered.has(callId)));
    if (!entry) return undefined;
    pendingSessions.delete(entry);
    clearTimeout(entry.expiry);
    for (const [callId, requestId] of entry.pending) {
      void entry.session.rpc.tools.handlePendingToolCall({ requestId, result: answered.get(callId) ?? "" }).catch(() => undefined);
    }
    entry.pending = new Map();
    return entry;
  }

  private async startSession(request: ChatRequest): Promise<PendingSession> {
    const client = await this.client();
    const tools = (request.tools ?? []).map((tool) => ({ name: `${TOOL_PREFIX}${tool.name}`, description: tool.description, parameters: tool.parameters }));
    const session = await client.createSession({
      model: request.model,
      streaming: true,
      systemMessage: { mode: "replace", content: systemPrompt(request) },
      tools,
      availableTools: tools.map((tool) => tool.name),
      // Calls are declarations only; Moss approves and runs them itself.
      onPermissionRequest: async () => ({ kind: "approved" }),
    });
    const queue = new EventQueue();
    const entry: PendingSession = {
      session,
      model: request.model,
      toolsKey: toolsKey(request.tools),
      pending: new Map(),
      queue,
      unsubscribe: session.on((event) => queue.push(event)),
      expiry: setTimeout(() => undefined, 0),
    };
    await session.send({ prompt: renderPrompt(request.messages) });
    return entry;
  }

  /** Stream until the model either finishes the turn or calls Moss's tools. */
  private async *round(entry: PendingSession, request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const known = new Set((request.tools ?? []).map((tool) => tool.name));
    let expected: string[] | undefined;
    const requested = new Map<string, { requestId: string; name: string; arguments: string }>();
    const refused = new Set<string>();
    // Messages already streamed as deltas; a complete message without them is sent whole.
    const streamed = new Set<string>();
    for (;;) {
      const event = await entry.queue.next(signal);
      // Sub-agent activity is Copilot's own; Moss never enables sub-agents.
      if (event.agentId) continue;
      const data = event.data ?? {};
      switch (event.type) {
        case "assistant.message_delta":
          if (typeof data.deltaContent === "string" && data.deltaContent && !data.parentToolCallId) {
            streamed.add(String(data.messageId ?? ""));
            yield { type: "text-delta", text: data.deltaContent };
          }
          break;
        case "assistant.usage":
          yield { type: "usage", usage: { inputTokens: Number(data.inputTokens ?? 0), outputTokens: Number(data.outputTokens ?? 0) } };
          break;
        case "assistant.message": {
          if (typeof data.content === "string" && data.content && !data.parentToolCallId && !streamed.has(String(data.messageId ?? ""))) {
            yield { type: "text-delta", text: data.content };
          }
          const calls = Array.isArray(data.toolRequests) ? data.toolRequests as Array<{ toolCallId?: string }> : [];
          if (calls.length > 0) expected = calls.map((call) => String(call.toolCallId ?? ""));
          break;
        }
        case "external_tool.requested": {
          const name = String(data.toolName ?? "");
          const plain = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
          const requestId = String(data.requestId ?? "");
          if (!known.has(plain)) {
            refused.add(String(data.toolCallId ?? requestId));
            void entry.session.rpc.tools.handlePendingToolCall({ requestId, error: `Unknown tool ${name}` }).catch(() => undefined);
            break;
          }
          requested.set(String(data.toolCallId ?? requestId), { requestId, name: plain, arguments: JSON.stringify(data.arguments ?? {}) });
          break;
        }
        case "session.error":
          throw new ProviderError(`GitHub Copilot: ${String(data.message ?? "request failed")}`, typeof data.statusCode === "number" ? data.statusCode : undefined);
        case "session.idle":
          release(entry);
          return;
        default:
          break;
      }
      // Every call of the model's message has reached Moss: end the round and
      // keep the session paused until the results arrive.
      if (requested.size > 0 && (!expected || expected.every((id) => requested.has(id) || refused.has(id)))) {
        for (const [callId, call] of requested) {
          entry.pending.set(callId, call.requestId);
          yield { type: "tool-call", toolCall: { id: callId, name: call.name, arguments: call.arguments } };
        }
        entry.expiry = setTimeout(() => release(entry), PENDING_SESSION_TTL_MS);
        entry.expiry.unref?.();
        pendingSessions.add(entry);
        return;
      }
    }
  }
}
