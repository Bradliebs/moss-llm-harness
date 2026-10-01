// electron/backend/moss/mcp/mcp-manager.ts
//
// Connects to configured MCP servers and exposes their tools through Moss's
// native `Tool` interface, so MCP tools flow through the exact same agent-runner
// dispatch and permission gate as the built-in tools. Unknown tool names are
// classified "ask" by permission.ts, so every MCP tool is approval-gated by
// default.
//
// The SDK is ESM-authored but ships a dual (CJS) build; these imports resolve to
// its CommonJS output at runtime via the package `"require"` export condition.
// Types come from the local ambient declarations in mcp-sdk.d.ts.

import { Client, type McpCallToolResult, type McpToolInfo } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createLogger } from "../../../../common/logger";
import type { McpServerStatus } from "../../../../common/types";
import { loadMcpServers, type McpServerConfig } from "./mcp-config";
import { userDataDir } from "../runtime/user-data";
import type { Tool, ToolContext, ToolResult } from "../tools/types";

const log = createLogger("MCP");

const CLIENT_INFO = { name: "moss", version: "0.1.0" };

interface Connection {
  id: string;
  client: Client;
  transport: { close(): Promise<void> };
}

/** Build a provider-safe tool name. OpenAI/Anthropic accept ^[a-zA-Z0-9_-]{1,64}$. */
function adaptToolName(serverId: string, toolName: string): string {
  const raw = `mcp__${serverId}__${toolName}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function serializeResult(result: McpCallToolResult): ToolResult {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[image ${block.mimeType ?? "unknown"}, ${block.data?.length ?? 0} base64 chars]`);
    } else {
      parts.push(`[${block.type} content]`);
    }
  }
  const content = parts.length > 0 ? parts.join("\n") : "(no content)";
  return { ok: result.isError !== true, content };
}

/** Where a stdio server runs when its config names no folder. Servers write
 *  snapshots and screenshots into their working folder, so it is a folder of
 *  their own under Moss's data rather than wherever Moss was started. */
export function serverWorkingDir(config: McpServerConfig): string | undefined {
  if (config.type !== "stdio") return undefined;
  if (config.cwd) return config.cwd;
  try {
    const safe = config.id.replace(/[^a-z0-9._-]/gi, "_");
    // Ids that differ only in punctuation must not share a folder.
    const name = safe === config.id ? safe : `${safe}-${createHash("sha256").update(config.id).digest("hex").slice(0, 8)}`;
    const dir = join(userDataDir(), "mcp-servers", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

function createTransport(config: McpServerConfig): { close(): Promise<void> } {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: serverWorkingDir(config),
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

/** Tools that run code or move files from the machine; they keep prompting
 *  even when the user ignores the server's destructive flags, and the approval
 *  card says why in Moss's words rather than the server's. */
const ALWAYS_ASK_MCP: ReadonlyArray<[pattern: RegExp, reason: string]> = [
  [/(?:^|_)(?:evaluate|run_code)$/, "It runs code inside the page, with your signed-in session, so it could click, submit, or send data as you. Moss always asks, even when the code looks read-only."],
  [/(?:^|_)file_upload$/, "It sends files from this computer to the page. Moss always asks."],
  [/(?:^|_)install$/, "It installs software on this computer. Moss always asks."],
];

function alwaysAskReason(name: string | undefined): string | undefined {
  return ALWAYS_ASK_MCP.find(([pattern]) => pattern.test(name ?? ""))?.[1];
}

/** Steers models away from code tools when a read tool would do. */
const CODE_TOOL_HINT = " Moss asks for approval every time this runs. To read page text or structure, prefer the server's snapshot or text tool, which runs no code in the page.";

/** Annotations are claims made by the server. A read-only claim relaxes the
 *  permission policy, so it counts only for servers the user trusts; a
 *  destructive claim only tightens it, so it counts for every server unless
 *  the user ignores it for a server that flags every non-read tool. */
export function mcpToolRisk(
  info: Pick<McpToolInfo, "annotations"> & { name?: string },
  trustAnnotations: boolean,
  ignoreDestructiveHints = false,
): { readOnly?: true; destructive?: true; destructiveReason?: string; checkIrreversible?: true } {
  const hints = info.annotations;
  if (!hints || typeof hints !== "object") return {};
  if (hints.destructiveHint === true && hints.readOnlyHint !== true) {
    const reason = alwaysAskReason(info.name);
    if (reason) return { destructive: true, destructiveReason: reason };
    if (!ignoreDestructiveHints) return { destructive: true };
    return { checkIrreversible: true };
  }
  if (trustAnnotations && hints.readOnlyHint === true && hints.destructiveHint !== true) return { readOnly: true };
  return {};
}

/** Defaults for servers Moss recognizes, so they work well without tuning.
 *  Playwright MCP flags every non-read tool destructive, which would ask
 *  before every navigation, and its snapshot tool reads pages without running
 *  code, so its code tools are hidden. Explicit config values win. */
export function serverDefaults(config: McpServerConfig): { trustAnnotations?: boolean; ignoreDestructiveHints?: boolean; hiddenTools?: string[]; networkReadTools?: string[] } {
  const launch = config.type === "stdio" ? [config.command, ...(config.args ?? [])].join(" ") : config.url;
  if (/@playwright\/mcp\b/.test(launch)) {
    return {
      // Its read-only flags (snapshot, screenshot, console) are accurate.
      trustAnnotations: true,
      ignoreDestructiveHints: true,
      hiddenTools: ["browser_evaluate", "browser_run_code"],
      // Opening a page is a read, like the built-in browser_navigate: after
      // untrusted content it asks only when the URL derives from that content.
      networkReadTools: ["browser_navigate", "browser_navigate_back"],
    };
  }
  return {};
}

/** The options a server actually runs with: explicit config, then recognized defaults. */
export function effectiveServerOptions(config: McpServerConfig): { trustAnnotations: boolean; ignoreDestructiveHints: boolean; hiddenTools: string[]; networkReadTools: string[] } {
  const defaults = serverDefaults(config);
  return {
    trustAnnotations: config.trustAnnotations ?? defaults.trustAnnotations ?? false,
    ignoreDestructiveHints: config.ignoreDestructiveHints ?? defaults.ignoreDestructiveHints ?? false,
    // Only a recognized server's defaults can mark tools as network reads.
    networkReadTools: config.ignoreDestructiveHints === false ? [] : defaults.networkReadTools ?? [],
    hiddenTools: (config.hiddenTools ?? defaults.hiddenTools ?? []).filter((name): name is string => typeof name === "string"),
  };
}

export function adaptMcpTool(
  serverId: string,
  client: Pick<Client, "callTool">,
  info: Pick<McpToolInfo, "name" | "description" | "inputSchema" | "annotations">,
  options: { trustAnnotations?: boolean; ignoreDestructiveHints?: boolean; networkRead?: boolean } = {},
): Tool {
  const name = adaptToolName(serverId, info.name);
  const parameters = info.inputSchema && typeof info.inputSchema === "object"
    ? info.inputSchema : { type: "object", properties: {} };
  const risk = mcpToolRisk(info, options.trustAnnotations === true, options.ignoreDestructiveHints === true);
  const description = info.description ?? `MCP tool "${info.name}" from server "${serverId}"`;
  const runsCode = risk.destructive === true && /(?:^|_)(?:evaluate|run_code)$/.test(info.name);
  return {
    name,
    description: runsCode ? `${description}${CODE_TOOL_HINT}` : description,
    parameters,
    timeoutMs: 180_000,
    ...risk,
    ...(options.networkRead && !risk.destructive ? { networkRead: true } : {}),
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      try {
        const result = await client.callTool({ name: info.name, arguments: args }, undefined, { signal: ctx.signal });
        return serializeResult(result);
      } catch (err) {
        return { ok: false, content: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

class McpManager {
  private connections: Connection[] = [];
  private tools: Tool[] = [];
  private status: McpServerStatus[] = [];
  // Lifecycle ops (init/reconnect) run one at a time. Concurrent IPC calls
  // would otherwise interleave teardown and connect on the shared arrays and
  // could leave an orphaned child process behind.
  private lifecycle: Promise<unknown> = Promise.resolve();

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(op, op);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Connect every enabled server. Failures are isolated per server. Idempotent:
   *  calling again tears down existing connections and reconnects. */
  init(configs: McpServerConfig[] = loadMcpServers()): Promise<void> {
    return this.serialize(() => this.runInit(configs));
  }

  private async runInit(configs: McpServerConfig[]): Promise<void> {
    await this.close();
    const enabled = configs.filter((c) => c.enabled !== false);
    // Surface disabled servers in status so the settings UI can list and
    // re-enable them; they are never connected.
    for (const config of configs) {
      if (config.enabled === false) {
        this.status.push({ id: config.id, enabled: false, connected: false, toolCount: 0 });
      }
    }
    if (enabled.length === 0) {
      log.info("no enabled MCP servers");
      return;
    }

    await Promise.all(enabled.map((config) => this.connectServer(config)));
    log.info(`connected ${this.connections.length}/${enabled.length} server(s), ${this.tools.length} tool(s) total`);
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
    const client = new Client(CLIENT_INFO);
    let transport: { close(): Promise<void> };
    try {
      transport = createTransport(config);
      await client.connect(transport);
      const { tools: listed } = await client.listTools();
      const effective = effectiveServerOptions(config);
      const hidden = new Set(effective.hiddenTools);
      const tools = listed.filter((t) => !hidden.has(t.name));
      const adapted = tools.map((t) => adaptMcpTool(config.id, client, t, {
        trustAnnotations: effective.trustAnnotations,
        ignoreDestructiveHints: effective.ignoreDestructiveHints,
        networkRead: effective.networkReadTools.includes(t.name),
      }));
      for (const tool of adapted) {
        if (this.tools.some((existing) => existing.name === tool.name)) {
          log.warn(`duplicate tool name ${tool.name} from server ${config.id} skipped`);
          continue;
        }
        this.tools.push(tool);
      }
      this.connections.push({ id: config.id, client, transport });
      this.status.push({
        id: config.id,
        enabled: true,
        connected: true,
        toolCount: adapted.length,
        tools: tools.map((t) => t.name),
        ...(effective.trustAnnotations ? { trustAnnotations: true } : {}),
        ...(effective.ignoreDestructiveHints ? { ignoreDestructiveHints: true } : {}),
        ...(hidden.size > 0 ? { hiddenTools: listed.filter((t) => hidden.has(t.name)).map((t) => t.name) } : {}),
        destructiveTools: tools.filter((t) => t.annotations?.destructiveHint === true && t.annotations.readOnlyHint !== true).map((t) => t.name),
        readOnlyTools: tools.filter((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true).map((t) => t.name),
      });
      log.info(`server ${config.id}: ${adapted.length} tool(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.push({ id: config.id, enabled: true, connected: false, toolCount: 0, error: message });
      log.error(`server ${config.id} failed to connect:`, message);
      await client.close().catch(() => undefined);
    }
  }

  /** Tear down and reconnect a single server by id, leaving the others
   *  untouched. Reloads that server's current config from disk: a removed
   *  server is dropped, a disabled one is listed but not connected, and an
   *  enabled one is reconnected. */
  reconnect(id: string): Promise<void> {
    return this.serialize(() => this.runReconnect(id));
  }

  private async runReconnect(id: string): Promise<void> {
    const conn = this.connections.find((c) => c.id === id);
    if (conn) {
      await conn.client.close().catch(() => conn.transport.close().catch(() => undefined));
      this.connections = this.connections.filter((c) => c.id !== id);
    }
    const prefix = `mcp__${id}__`.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.tools = this.tools.filter((t) => !t.name.startsWith(prefix));
    this.status = this.status.filter((s) => s.id !== id);

    const config = loadMcpServers().find((c) => c.id === id);
    if (!config) {
      log.info(`server ${id} no longer configured`);
      return;
    }
    if (config.enabled === false) {
      this.status.push({ id: config.id, enabled: false, connected: false, toolCount: 0 });
      return;
    }
    await this.connectServer(config);
  }

  getTools(): Tool[] {
    return this.tools;
  }

  getStatus(): McpServerStatus[] {
    return this.status;
  }

  async close(): Promise<void> {
    const closing = this.connections.map((conn) =>
      conn.client.close().catch(() => conn.transport.close().catch(() => undefined)),
    );
    await Promise.all(closing);
    this.connections = [];
    this.tools = [];
    this.status = [];
  }
}

/** Process-wide singleton; initialized in main.ts, read by chat-ipc.ts. */
export const mcpManager = new McpManager();
