import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "../../../../common/types";
import { setUserDataDir } from "../runtime/user-data";
import { CopilotProvider, packagedRuntimePath, renderPrompt, stopCopilotClients, type CopilotClientLike, type CopilotEvent, type CopilotSessionLike } from "./copilot";
import { ProviderError, type ChatRequest, type ProviderStreamEvent } from "./types";

type Script = CopilotEvent[][];

/** A session that plays one script segment per send() or answered tool call. */
function fakeSession(script: Script) {
  let handler: ((event: CopilotEvent) => void) | undefined;
  const segments = [...script];
  const play = (): void => {
    const segment = segments.shift() ?? [];
    setTimeout(() => segment.forEach((event) => handler?.(event)), 0);
  };
  const answered: Array<{ requestId: string; result?: string; error?: string }> = [];
  const session: CopilotSessionLike & { prompts: string[]; answered: typeof answered; aborted: boolean; disconnected: boolean } = {
    prompts: [],
    answered,
    aborted: false,
    disconnected: false,
    on: (fn) => { handler = fn; return () => { handler = undefined; }; },
    send: async ({ prompt }) => { session.prompts.push(prompt); play(); return "m1"; },
    abort: async () => { session.aborted = true; },
    disconnect: async () => { session.disconnected = true; },
    rpc: { tools: { handlePendingToolCall: async (params) => {
      answered.push(params);
      // A refused call produces no new segment; an answered one resumes the model.
      if (params.result !== undefined) play();
      return { success: true };
    } } },
  };
  return session;
}

function fakeClient(sessions: Array<ReturnType<typeof fakeSession>>, auth = true) {
  const configs: Array<Record<string, unknown>> = [];
  const client: CopilotClientLike & { configs: typeof configs; started: number } = {
    configs,
    started: 0,
    start: async () => { client.started += 1; },
    stop: async () => [],
    getAuthStatus: async () => ({ isAuthenticated: auth, login: "brad", ...(auth ? {} : { statusMessage: "no token" }) }),
    listModels: async () => [{ id: "claude-sonnet-5" }, { id: "gpt-6" }, { id: "blocked", policy: { state: "disabled" } }],
    createSession: async (config) => { configs.push(config); return sessions.shift()!; },
  };
  return client;
}

const event = (type: string, data: Record<string, unknown> = {}): CopilotEvent => ({ type, data });

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
let data: string;
let tokenCounter = 0;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "moss-copilot-"));
  setUserDataDir(data);
});

afterEach(async () => {
  await stopCopilotClients();
  setUserDataDir(undefined);
  rmSync(data, { recursive: true, force: true });
});

function provider(client: CopilotClientLike) {
  // A distinct token per test keeps the shared client cache from leaking between tests.
  return new CopilotProvider({ apiKey: `token-${++tokenCounter}`, createClient: () => client, resolveCliToken: async () => undefined });
}

describe("CopilotProvider", () => {
  it("lists enabled models once signed in, and explains a missing sign-in", async () => {
    expect(await provider(fakeClient([])).listModels()).toEqual(["claude-sonnet-5", "gpt-6"]);
    await expect(provider(fakeClient([], false)).listModels()).rejects.toThrow(/Not signed in to GitHub Copilot \(no token\).*gh auth login/);
  });

  it("streams a plain answer and closes the session at the end of the turn", async () => {
    const session = fakeSession([[
      event("assistant.message_delta", { deltaContent: "Hel" }),
      event("assistant.message_delta", { deltaContent: "lo" }),
      event("assistant.usage", { inputTokens: 12, outputTokens: 3 }),
      event("assistant.message", { content: "Hello" }),
      event("session.idle"),
    ]]);
    const client = fakeClient([session]);
    const request: ChatRequest = { model: "claude-sonnet-5", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }] };
    const events = await collect(provider(client).streamChat(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    expect(session.prompts).toEqual(["Say hello"]);
    expect(client.configs[0]).toMatchObject({ model: "claude-sonnet-5", systemMessage: { mode: "replace", content: "Be brief." }, availableTools: [] });
    expect(session.disconnected).toBe(true);
  });

  it("hands tool calls to Moss and answers them on the same session, without a new prompt", async () => {
    const session = fakeSession([
      [
        event("assistant.message", { content: "", toolRequests: [{ toolCallId: "call-1", name: "moss_read_file" }] }),
        event("external_tool.requested", { toolName: "moss_read_file", toolCallId: "call-1", requestId: "req-1", arguments: { path: "notes.txt" } }),
      ],
      [event("assistant.message_delta", { deltaContent: "HERON" }), event("session.idle")],
    ]);
    const client = fakeClient([session]);
    const copilot = provider(client);
    const messages: AgentMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "What is the code word?" }];
    const first = await collect(copilot.streamChat({ model: "claude-sonnet-5", messages, tools }, new AbortController().signal));
    expect(first).toEqual([{ type: "tool-call", toolCall: { id: "call-1", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }]);
    expect(client.configs[0]).toMatchObject({ availableTools: ["moss_read_file"], tools: [{ name: "moss_read_file" }] });

    const next: AgentMessage[] = [
      ...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" }] },
      { role: "tool", toolCallId: "call-1", content: "The code word is HERON." },
    ];
    const second = await collect(copilot.streamChat({ model: "claude-sonnet-5", messages: next, tools }, new AbortController().signal));
    expect(second).toEqual([{ type: "text-delta", text: "HERON" }]);
    expect(session.answered).toEqual([{ requestId: "req-1", result: "The code word is HERON." }]);
    expect(session.prompts).toHaveLength(1);
    expect(client.configs).toHaveLength(1);
  });

  it("refuses a call to a tool Moss did not offer, and keeps waiting for the model", async () => {
    const session = fakeSession([[
      event("assistant.message", { toolRequests: [{ toolCallId: "x" }] }),
      event("external_tool.requested", { toolName: "moss_delete_everything", toolCallId: "x", requestId: "rx" }),
      event("assistant.message_delta", { deltaContent: "Sorry." }),
      event("session.idle"),
    ]]);
    const events = await collect(provider(fakeClient([session])).streamChat({ model: "m", messages: [{ role: "user", content: "go" }], tools }, new AbortController().signal));
    expect(events).toEqual([{ type: "text-delta", text: "Sorry." }]);
    expect(session.answered).toEqual([{ requestId: "rx", error: "Unknown tool moss_delete_everything" }]);
  });

  it("reports Copilot errors as provider errors with their status", async () => {
    const session = fakeSession([[event("session.error", { message: "quota exceeded", statusCode: 429 })]]);
    const stream = provider(fakeClient([session])).streamChat({ model: "m", messages: [{ role: "user", content: "go" }] }, new AbortController().signal);
    const error = await collect(stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, message: expect.stringContaining("quota exceeded") });
    expect(session.disconnected).toBe(true);
  });

  it("stops the Copilot session when the turn is cancelled", async () => {
    const session = fakeSession([[]]);
    const controller = new AbortController();
    const pending = collect(provider(fakeClient([session])).streamChat({ model: "m", messages: [{ role: "user", content: "go" }] }, controller.signal));
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(session.aborted).toBe(true);
  });

  it("asks for JSON in the system message when a schema is required", async () => {
    const session = fakeSession([[event("assistant.message_delta", { deltaContent: "{}" }), event("session.idle")]]);
    const client = fakeClient([session]);
    await collect(provider(client).streamChat({ model: "m", messages: [{ role: "user", content: "rate it" }], responseSchema: { type: "object" } }, new AbortController().signal));
    expect(String((client.configs[0].systemMessage as { content: string }).content)).toContain("single JSON object that matches this JSON schema");
  });

  it("starts the runtime once per sign-in", async () => {
    const client = fakeClient([]);
    const copilot = new CopilotProvider({ apiKey: "shared-token", createClient: () => client, resolveCliToken: async () => undefined });
    await copilot.listModels();
    await new CopilotProvider({ apiKey: "shared-token", createClient: () => client, resolveCliToken: async () => undefined }).listModels();
    expect(client.started).toBe(1);
  });
});

describe("packagedRuntimePath", () => {
  it("is not used outside a packaged app", () => {
    expect(packagedRuntimePath("H:\\Moss\\dist-electron\\electron\\backend\\moss\\providers")).toBeUndefined();
  });

  it("finds the runtime beside the archive, nested under the SDK", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-packaged-"));
    try {
      const platform = `${process.platform}-${process.arch}`;
      const exe = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
      const unpacked = join(root, "app.asar.unpacked", "node_modules", "@github", "copilot-sdk", "node_modules", "@github", `copilot-sdk-${platform}`, "prebuilds", platform);
      mkdirSync(unpacked, { recursive: true });
      writeFileSync(join(unpacked, exe), "");
      const sdkEntry = join(root, "app.asar", "node_modules", "@github", "copilot-sdk", "dist", "cjs", "index.js");
      expect(packagedRuntimePath(join(root, "app.asar", "dist-electron"), () => sdkEntry)).toBe(join(unpacked, exe));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderPrompt", () => {
  it("sends just the request when there is no history", () => {
    expect(renderPrompt([{ role: "system", content: "s" }, { role: "user", content: "hi" }])).toBe("hi");
  });

  it("puts earlier turns, tool calls, and results in a transcript before the request", () => {
    const prompt = renderPrompt([
      { role: "user", content: "read notes" },
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", arguments: "{\"path\":\"n\"}" }] },
      { role: "tool", toolCallId: "c", content: "HERON" },
      { role: "assistant", content: "It says HERON." },
      { role: "user", content: "spell it backwards" },
    ]);
    expect(prompt).toContain("User:\nread notes");
    expect(prompt).toContain("[called read_file with {\"path\":\"n\"}]");
    expect(prompt).toContain("Tool result (read_file):\nHERON");
    expect(prompt.endsWith("---\n\nspell it backwards")).toBe(true);
  });
});
