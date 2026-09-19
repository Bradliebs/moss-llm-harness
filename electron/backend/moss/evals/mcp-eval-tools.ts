import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Client, McpToolInfo } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "../tools/types";

export type McpEvalToolAdapter = (
  serverId: string,
  client: Pick<Client, "callTool">,
  info: McpToolInfo,
) => Tool | Promise<Tool>;

interface ServerState {
  project: "orchard" | "meadow";
  tickets: { T42: "open" | "closed" };
  writes: number;
}

interface McpState {
  schemaVersion: 1;
  servers: { north: ServerState; south: ServerState };
}

function statePath(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  for (let current = root; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("MCP eval workspace must not contain links");
    if (dirname(current) === current) break;
  }
  if (realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error("MCP eval workspace must be a real directory");
  const path = join(root, "mcp-behavior-state.json");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("MCP eval state must be a regular, unlinked file");
  return path;
}

function isServer(value: unknown): value is ServerState {
  if (!value || typeof value !== "object") return false;
  const server = value as Record<string, unknown>;
  return (server.project === "orchard" || server.project === "meadow")
    && server.writes === 0 && !!server.tickets && typeof server.tickets === "object"
    && (server.tickets as Record<string, unknown>).T42 === "open";
}

export async function createMcpEvalTools(
  workspaceRoot: string,
  adaptTool: McpEvalToolAdapter,
): Promise<Tool[]> {
  const input: unknown = JSON.parse(readFileSync(statePath(workspaceRoot), "utf8"));
  if (!input || typeof input !== "object") throw new Error("Invalid MCP eval fixture");
  const fixture = input as Record<string, unknown>;
  const servers = fixture.servers as Record<string, unknown> | undefined;
  if (fixture.schemaVersion !== 1 || !servers || !isServer(servers.north) || !isServer(servers.south)
    || servers.north.project === servers.south.project) throw new Error("Invalid MCP eval server ownership");
  const state: McpState = { schemaVersion: 1, servers: { north: servers.north, south: servers.south } };
  const tools: Tool[] = [];
  for (const serverId of ["north", "south"] as const) {
    const server = state.servers[serverId];
    const client: Pick<Client, "callTool"> = {
      async callTool(params, _schema, options) {
        options?.signal?.throwIfAborted();
        if (params.name !== "set_status" || params.arguments?.ticketId !== "T42" || params.arguments?.status !== "closed") {
          return { isError: true, content: [{ type: "text", text: "Expected set_status with ticketId T42 and status closed" }] };
        }
        const path = statePath(workspaceRoot);
        const next: McpState = {
          ...state,
          servers: { ...state.servers, [serverId]: { ...server, tickets: { T42: "closed" }, writes: server.writes + 1 } },
        };
        writeFileSync(path, JSON.stringify(next) + "\n");
        server.tickets.T42 = "closed";
        server.writes++;
        return { content: [{ type: "text", text: `${server.project}: T42 closed` }] };
      },
    };
    const tool = await adaptTool(serverId, client, {
      name: "set_status",
      description: `Update tickets owned by project ${server.project}. Server ${serverId}; other projects belong to the other server.`,
      inputSchema: {
        type: "object", properties: { ticketId: { type: "string", enum: ["T42"] }, status: { type: "string", enum: ["closed"] } },
        required: ["ticketId", "status"], additionalProperties: false,
      },
    });
    tools.push({
      ...tool,
      async execute(args, context) {
        if (resolve(context.workspaceRoot) !== resolve(workspaceRoot)) {
          return { ok: false, content: "MCP eval tool belongs to a different workspace" };
        }
        return tool.execute(args, context);
      },
    });
  }
  return tools;
}