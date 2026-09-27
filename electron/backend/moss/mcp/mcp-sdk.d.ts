// electron/backend/moss/mcp/mcp-sdk.d.ts
//
// Minimal ambient typings for the slice of @modelcontextprotocol/sdk that Moss
// uses. The SDK ships an `exports` map that classic `moduleResolution: Node`
// (used by tsconfig.node.json) cannot read, so normal type resolution fails.
// These declarations type the exact subpaths we import. At runtime Node resolves
// each specifier through the SDK's `"require"` export condition to its CommonJS
// build, so the emitted `require(...)` loads cleanly under Electron's Node.
//
// Only the members Moss touches are declared; the SDK surface is much larger.

declare module "@modelcontextprotocol/sdk/client/index.js" {
  export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    /** MCP tool annotations; hints from the server, not guarantees */
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  }

  export interface McpContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }

  export interface McpCallToolResult {
    content: McpContentBlock[];
    isError?: boolean;
    [key: string]: unknown;
  }

  export class Client {
    constructor(clientInfo: { name: string; version: string }, options?: unknown);
    connect(transport: unknown, options?: unknown): Promise<void>;
    listTools(params?: unknown, options?: unknown): Promise<{ tools: McpToolInfo[] }>;
    callTool(
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<McpCallToolResult>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/stdio.js" {
  export interface StdioServerParameters {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: unknown;
  }

  export class StdioClientTransport {
    constructor(server: StdioServerParameters);
    close(): Promise<void>;
  }

  export function getDefaultEnvironment(): Record<string, string>;
}

declare module "@modelcontextprotocol/sdk/client/streamableHttp.js" {
  export interface StreamableHTTPClientTransportOptions {
    requestInit?: { headers?: Record<string, string> };
  }

  export class StreamableHTTPClientTransport {
    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions);
    close(): Promise<void>;
  }
}
