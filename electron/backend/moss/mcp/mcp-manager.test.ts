// Integration test for the MCP manager. Spawns a real stdio MCP server (the echo
// fixture) and exercises the full connect -> listTools -> callTool -> serialize
// path, plus per-tool dispatch through the adapted `Tool` interface. This is the
// riskiest new code in Phase 4 (ESM-authored SDK loaded from the CommonJS build),
// so it is verified against a live server rather than mocks.

import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { loadMcpServers } from "./mcp-config";
import { adaptMcpTool, mcpManager, mcpToolRisk } from "./mcp-manager";

// reconnect() reloads a server's current config from disk; mock only the config
// loader so reconnect is deterministic while the SDK stays real.
vi.mock("./mcp-config", () => ({ loadMcpServers: vi.fn(() => []) }));

const fixture = fileURLToPath(new URL("./__fixtures__/echo-server.cjs", import.meta.url));

describe("mcpManager stdio integration", () => {
  afterAll(async () => {
    await mcpManager.close();
  });

  it("connects to a stdio server, lists its tools, and dispatches a call", async () => {
    await mcpManager.init([
      { type: "stdio", id: "echo", command: process.execPath, args: [fixture] },
    ]);

    const status = mcpManager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ id: "echo", connected: true, toolCount: 1 });

    const tools = mcpManager.getTools();
    const echo = tools.find((t) => t.name === "mcp__echo__echo");
    expect(echo).toBeDefined();
    expect(echo?.description).toContain("Echoes");

    const result = await echo!.execute(
      { message: "hello" },
      { workspaceRoot: "", signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("echo: hello");
  }, 20_000);

  it("reads annotations from a live server but honors read-only only when trusted", async () => {
    await mcpManager.init([{ type: "stdio", id: "echo", command: process.execPath, args: [fixture] }]);
    expect(mcpManager.getStatus()[0]).toMatchObject({ readOnlyTools: ["echo"] });
    expect(mcpManager.getStatus()[0].trustAnnotations).toBeUndefined();
    expect(mcpManager.getTools()[0].readOnly).toBeUndefined();

    await mcpManager.init([{ type: "stdio", id: "echo", command: process.execPath, args: [fixture], trustAnnotations: true }]);
    expect(mcpManager.getStatus()[0]).toMatchObject({ trustAnnotations: true, readOnlyTools: ["echo"] });
    expect(mcpManager.getTools()[0].readOnly).toBe(true);
  }, 20_000);

  it("isolates a failed server without throwing", async () => {
    await mcpManager.init([
      { type: "stdio", id: "broken", command: "definitely-not-a-real-command-xyz" },
    ]);

    const status = mcpManager.getStatus();
    expect(status[0].connected).toBe(false);
    expect(status[0].error).toBeTruthy();
    expect(mcpManager.getTools()).toHaveLength(0);
  }, 20_000);

  it("lists a disabled server in status without connecting it", async () => {
    await mcpManager.init([
      { type: "stdio", id: "off", command: process.execPath, args: [fixture], enabled: false },
    ]);

    const status = mcpManager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ id: "off", enabled: false, connected: false, toolCount: 0 });
    expect(mcpManager.getTools()).toHaveLength(0);
  });

  it("reconnects a single server from its current on-disk config, leaving others untouched", async () => {
    await mcpManager.init([
      { type: "stdio", id: "echo", command: process.execPath, args: [fixture] },
      { type: "stdio", id: "gone", command: process.execPath, args: [fixture], enabled: false },
    ]);

    // Disk now knows only "echo": reconnecting "gone" drops it entirely.
    vi.mocked(loadMcpServers).mockReturnValue([
      { type: "stdio", id: "echo", command: process.execPath, args: [fixture] },
    ]);
    await mcpManager.reconnect("gone");
    expect(mcpManager.getStatus().find((s) => s.id === "gone")).toBeUndefined();

    // "echo" stays connected with exactly its one tool after a targeted retry.
    await mcpManager.reconnect("echo");
    expect(mcpManager.getStatus().find((s) => s.id === "echo")).toMatchObject({
      id: "echo",
      connected: true,
      toolCount: 1,
    });
    expect(mcpManager.getTools().filter((t) => t.name.startsWith("mcp__echo__"))).toHaveLength(1);
  }, 20_000);
});


describe("MCP tool annotations", () => {
  it("trusts read-only claims only when asked, and destructive claims always", () => {
    expect(mcpToolRisk({ annotations: { readOnlyHint: true } }, false)).toEqual({});
    expect(mcpToolRisk({ annotations: { readOnlyHint: true } }, true)).toEqual({ readOnly: true });
    expect(mcpToolRisk({ annotations: { readOnlyHint: true, destructiveHint: true } }, true)).toEqual({});
    expect(mcpToolRisk({ annotations: { destructiveHint: true } }, false)).toEqual({ destructive: true });
    expect(mcpToolRisk({}, true)).toEqual({});
    const client = { callTool: vi.fn() };
    const tool = adaptMcpTool("db", client as never, { name: "drop", inputSchema: {}, annotations: { destructiveHint: true } });
    expect(tool).toMatchObject({ name: "mcp__db__drop", destructive: true });
  });

  it("can ignore a server's blanket destructive flags, except for code, uploads, and installs", () => {
    const flagged = { annotations: { destructiveHint: true } };
    expect(mcpToolRisk({ ...flagged, name: "browser_navigate" }, false, true)).toEqual({ checkIrreversible: true });
    expect(mcpToolRisk({ ...flagged, name: "browser_click" }, false, true)).toEqual({ checkIrreversible: true });
    for (const name of ["browser_evaluate", "browser_run_code", "browser_file_upload", "browser_install"]) {
      expect(mcpToolRisk({ ...flagged, name }, false, true)).toEqual({ destructive: true });
    }
    const tool = adaptMcpTool("playwright", { callTool: vi.fn() } as never, { name: "browser_navigate", inputSchema: {}, ...flagged }, { ignoreDestructiveHints: true });
    expect(tool.destructive).toBeUndefined();
    expect(tool.checkIrreversible).toBe(true);
  });
});