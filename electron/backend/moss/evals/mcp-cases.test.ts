import { cpSync, linkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, McpToolInfo } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../../common/evals";
import type { MossEvent } from "../../../../common/types";
import { runTurn } from "../agent-runner";
import type { mcpManager } from "../mcp/mcp-manager";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { checkEvalCases } from "./case-health";
import { createMcpCases } from "./mcp-cases";
import { createMcpEvalTools, type McpEvalToolAdapter } from "./mcp-eval-tools";

const { validateMcpBehavior } = createRequire(import.meta.url)("./corpus/validators/mcp-behavior-state.cjs") as {
  validateMcpBehavior: (workspaceRoot: string, member: string) => void;
};

const dependencies = vi.hoisted(() => ({
  servers: new Map<string, { client: Pick<Client, "callTool">; info: McpToolInfo }>(),
}));

vi.mock("../mcp/mcp-config", () => ({ loadMcpServers: () => [] }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class { constructor() { throw new Error("Process transport forbidden"); } },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(readonly url: URL) {}
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    private server?: { client: Pick<Client, "callTool">; info: McpToolInfo };
    async connect(transport: { url: URL }) {
      this.server = dependencies.servers.get(transport.url.hostname);
      if (!this.server) throw new Error("Unknown fake MCP server");
    }
    async listTools() { return { tools: [this.server!.info] }; }
    callTool(...args: Parameters<Client["callTool"]>) { return this.server!.client.callTool(...args); }
    async close() {}
  },
}));

const roots: string[] = [];
const managers: Array<typeof mcpManager> = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  dependencies.servers.clear();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const productionAdapter: McpEvalToolAdapter = async (serverId, client, info) => {
  dependencies.servers.set(`${serverId}.invalid`, { client, info });
  vi.resetModules();
  const { mcpManager: manager } = await import("../mcp/mcp-manager");
  managers.push(manager);
  await manager.init([{ id: serverId, type: "http", url: `https://${serverId}.invalid` }]);
  const tool = manager.getTools()[0];
  if (!tool) throw new Error("Production manager did not construct a tool");
  return tool;
};

function workspace(testCase: EvalCase = createMcpCases()[0]): string {
  const root = mkdtempSync(join(tmpdir(), "moss-mcp-behavior-"));
  roots.push(root);
  cpSync(testCase.fixture!.workspaceTemplate!, root, { recursive: true });
  return root;
}

async function runCase(testCase: EvalCase, options: { wrongServer?: boolean; approve?: boolean; textOnly?: boolean } = {}) {
  const root = workspace(testCase);
  const tools = await createMcpEvalTools(root, productionAdapter);
  const events: MossEvent[] = [];
  const requestApproval = vi.fn(async () => ({ approved: options.approve ?? true }));
  let round = 0;
  const provider: ChatProvider = {
    kind: "deterministic", listModels: async () => [],
    async *streamChat(request): AsyncIterable<ProviderStreamEvent> {
      if (round++ === 0 && !options.textOnly) {
        const selected = request.tools?.find((tool) => tool.description.includes(options.wrongServer ? "project meadow" : "project orchard"));
        if (!selected) throw new Error("Owning MCP tool was not advertised");
        yield { type: "tool-call", toolCall: { id: "close-ticket", name: selected.name, arguments: JSON.stringify({ ticketId: "T42", status: "closed" }) } };
      } else yield { type: "text-delta", text: '{"server":"north","status":"closed","success":true}' };
    },
  };
  await runTurn({
    provider, model: "fixture", messages: [{ role: "user", content: testCase.task.objective }],
    tools, toolRegistry: new Map(tools.map((tool) => [tool.name, tool])), workspaceRoot: root,
    signal: new AbortController().signal, onEvent: (event) => events.push(event), requestApproval,
    autoApprove: false, maxRounds: 3, streamRetryBaseMs: 0,
  });
  return { root, events, requestApproval };
}

describe("MCP behavioral production adapter", () => {
  it("routes the namespaced production tool to only its bound fake server", async () => {
    const root = workspace();
    const tools = await createMcpEvalTools(root, productionAdapter);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__north__set_status", "mcp__south__set_status"]);
    const result = await tools[0].execute({ ticketId: "T42", status: "closed" }, { workspaceRoot: root, signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, content: "orchard: T42 closed" });
    expect(JSON.parse(readFileSync(join(root, "mcp-behavior-state.json"), "utf8")).servers).toEqual({
      north: { project: "orchard", tickets: { T42: "closed" }, writes: 1 },
      south: { project: "meadow", tickets: { T42: "open" }, writes: 0 },
    });
  });

  it.each(createMcpCases())("runs production dispatch and mutates only the owning server for $id", async (testCase) => {
    const { root, events, requestApproval } = await runCase(testCase);
    const member = testCase.familyRole === "positive" ? "canonical" : "perturbed";
    expect(() => validateMcpBehavior(root, member)).not.toThrow();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-call", name: testCase.benchmark!.expectedCapabilities![0] }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", ok: true }));
  });

  it.each(createMcpCases())("rejects wrong-server mutation for $id", async (testCase) => {
    const { root } = await runCase(testCase, { wrongServer: true });
    expect(() => validateMcpBehavior(root, testCase.familyRole === "positive" ? "canonical" : "perturbed")).toThrow();
    const state = JSON.parse(readFileSync(join(root, "mcp-behavior-state.json"), "utf8")) as {
      servers: Record<string, { project: string; writes: number }>;
    };
    expect(Object.values(state.servers).find((server) => server.project === "orchard")?.writes).toBe(0);
    expect(Object.values(state.servers).find((server) => server.project === "meadow")?.writes).toBe(1);
  });

  it("does not mutate either server when production approval denies the call", async () => {
    const testCase = createMcpCases()[0];
    const { root, requestApproval, events } = await runCase(testCase, { approve: false });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, "mcp-behavior-state.json"), "utf8")).toBe(readFileSync(join(testCase.fixture!.workspaceTemplate!, "mcp-behavior-state.json"), "utf8"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", ok: false }));
    expect(() => validateMcpBehavior(root, "canonical")).toThrow();
  });

  it("rejects a model's claimed JSON success without a server mutation", async () => {
    const { root } = await runCase(createMcpCases()[0], { textOnly: true });
    expect(() => validateMcpBehavior(root, "canonical")).toThrow();
  });

  it("validates both hidden reference states with corpus health", async () => {
    const report = await checkEvalCases(createMcpCases(), {
      corpusPolicy: { requireSourceEvidence: true, requirePerturbationPairs: true },
      evaluatorArtifacts: [join(process.cwd(), "electron/backend/moss/evals/corpus/validators/mcp-behavior-state.cjs")],
    });
    expect(report.valid).toBe(true);
    expect(report.cases.every((entry) => entry.passed)).toBe(true);
  });

  it("rejects hard-linked state before construction and after tool construction", async () => {
    const root = workspace();
    const tools = await createMcpEvalTools(root, productionAdapter);
    const state = join(root, "mcp-behavior-state.json");
    const before = readFileSync(state, "utf8");
    const other = workspace();
    linkSync(state, join(other, "canary.json"));
    await expect(createMcpEvalTools(root, productionAdapter)).rejects.toThrow("unlinked");
    const result = await tools[0].execute({ ticketId: "T42", status: "closed" }, { workspaceRoot: root, signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(other, "canary.json"), "utf8")).toBe(before);
  });

  it("passes cancellation and invalid arguments through the production adapter without mutation", async () => {
    const root = workspace();
    const tools = await createMcpEvalTools(root, productionAdapter);
    const before = readFileSync(join(root, "mcp-behavior-state.json"), "utf8");
    const controller = new AbortController();
    controller.abort();
    expect((await tools[0].execute({ ticketId: "T42", status: "closed" }, { workspaceRoot: root, signal: controller.signal })).ok).toBe(false);
    expect((await tools[0].execute({ ticketId: "../../canary", status: "closed" }, { workspaceRoot: root, signal: new AbortController().signal })).ok).toBe(false);
    expect(readFileSync(join(root, "mcp-behavior-state.json"), "utf8")).toBe(before);
  });

  it("rejects cross-workspace tool reuse and keeps independent trials isolated", async () => {
    const first = workspace();
    const second = workspace();
    const firstTools = await createMcpEvalTools(first, productionAdapter);
    const secondTools = await createMcpEvalTools(second, productionAdapter);
    const args = { ticketId: "T42", status: "closed" };
    const signal = new AbortController().signal;
    const before = readFileSync(join(first, "mcp-behavior-state.json"), "utf8");
    expect((await firstTools[0].execute(args, { workspaceRoot: second, signal })).ok).toBe(false);
    expect(readFileSync(join(first, "mcp-behavior-state.json"), "utf8")).toBe(before);
    expect((await secondTools[0].execute(args, { workspaceRoot: second, signal })).ok).toBe(true);
    expect(() => validateMcpBehavior(second, "canonical")).not.toThrow();
    expect(readFileSync(join(first, "mcp-behavior-state.json"), "utf8")).toBe(before);
  });

  it.each(["duplicate-owner", "both-servers"])("rejects %s mutation in the independent validator", async (mutation) => {
    const root = workspace();
    const tools = await createMcpEvalTools(root, productionAdapter);
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const args = { ticketId: "T42", status: "closed" };
    expect((await tools[0].execute(args, context)).ok).toBe(true);
    expect(() => validateMcpBehavior(root, "canonical")).not.toThrow();
    expect((await tools[mutation === "duplicate-owner" ? 0 : 1].execute(args, context)).ok).toBe(true);
    expect(() => validateMcpBehavior(root, "canonical")).toThrow();
  });
});
