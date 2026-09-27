// Minimal stdio MCP server used only by mcp-manager.test.ts. Plain CommonJS so it
// loads the SDK's CJS build directly under a bare `node` process.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "echo-test", version: "0.0.1" });

server.registerTool(
  "echo",
  {
    description: "Echoes back the provided message",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

void server.connect(new StdioServerTransport());
