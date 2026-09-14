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

import { Client, type McpCallToolResult } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createLogger } from "../../../../common/logger";
import type { McpServerStatus } from "../../../../common/types";
import { loadMcpServers, type McpServerConfig } from "./mcp-config";
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

function createTransport(config: McpServerConfig): { close(): Promise<void> } {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

export function adaptMcpTool(
  serverId: string,
  client: Pick<Client, "callTool">,
  info: { name: string; description?: string; inputSchema: Record<string, unknown> },
): Tool {
  const name = adaptToolName(serverId, info.name);
  const parameters = info.inputSchema && typeof info.inputSchema === "object"
    ? info.inputSchema : { type: "object", properties: {} };
  return {
    name,
    description: info.description ?? `MCP tool "${info.name}" from server "${serverId}"`,
    parameters,
    timeoutMs: 180_000,
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
      const { tools } = await client.listTools();
      const adapted = tools.map((t) => adaptMcpTool(config.id, client, t));
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
