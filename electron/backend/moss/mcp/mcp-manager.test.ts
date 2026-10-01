// Integration test for the MCP manager. Spawns a real stdio MCP server (the echo
// fixture) and exercises the full connect -> listTools -> callTool -> serialize
// path, plus per-tool dispatch through the adapted `Tool` interface. This is the
// riskiest new code in Phase 4 (ESM-authored SDK loaded from the CommonJS build),
// so it is verified against a live server rather than mocks.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { loadMcpServers } from "./mcp-config";
import { adaptMcpTool, effectiveServerOptions, mcpManager, mcpToolRisk, serverWorkingDir } from "./mcp-manager";
import { resolvePermission } from "../permission";

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

  it("hides configured tools from the model and reports them", async () => {
    await mcpManager.init([{ type: "stdio", id: "echo", command: process.execPath, args: [fixture], hiddenTools: ["echo"] }]);
    expect(mcpManager.getTools()).toHaveLength(0);
    expect(mcpManager.getStatus()[0]).toMatchObject({ connected: true, toolCount: 0, hiddenTools: ["echo"] });
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


describe("recognized server defaults", () => {
  it("runs a stdio server in its own folder under Moss's data unless its config names one", () => {
    const data = mkdtempSync(join(tmpdir(), "moss-mcp-cwd-"));
    vi.stubEnv("MOSS_USER_DATA", data);
    try {
      expect(serverWorkingDir({ type: "stdio", id: "playwright", command: "npx" })).toBe(join(data, "mcp-servers", "playwright"));
      expect(existsSync(join(data, "mcp-servers", "playwright"))).toBe(true);
      expect(serverWorkingDir({ type: "stdio", id: "p", command: "npx", cwd: "C:\\work" })).toBe("C:\\work");
      expect(serverWorkingDir({ type: "http", id: "h", url: "http://localhost:1" })).toBeUndefined();
      const a = serverWorkingDir({ type: "stdio", id: "my server", command: "npx" });
      const b = serverWorkingDir({ type: "stdio", id: "my/server", command: "npx" });
      expect(a).not.toBe(b);
    } finally {
      vi.unstubAllEnvs();
      rmSync(data, { recursive: true, force: true });
    }
  });

  const playwright = { type: "stdio" as const, id: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"] };

  it("quiets Playwright MCP with no configuration", () => {
    expect(effectiveServerOptions(playwright)).toEqual({
      trustAnnotations: true,
      ignoreDestructiveHints: true,
      hiddenTools: ["browser_evaluate", "browser_run_code"],
      networkReadTools: ["browser_navigate", "browser_navigate_back"],
    });
    expect(effectiveServerOptions({ type: "http", id: "pw", url: "http://localhost:8931/@playwright/mcp" }).ignoreDestructiveHints).toBe(true);
  });

  it("lets explicit settings override the defaults, and leaves other servers alone", () => {
    expect(effectiveServerOptions({ ...playwright, trustAnnotations: false, ignoreDestructiveHints: false, hiddenTools: [] }))
      .toEqual({ trustAnnotations: false, ignoreDestructiveHints: false, hiddenTools: [], networkReadTools: [] });
    expect(effectiveServerOptions({ type: "stdio", id: "db", command: "node", args: ["db.js"] }))
      .toEqual({ trustAnnotations: false, ignoreDestructiveHints: false, hiddenTools: [], networkReadTools: [] });
  });

  it("keeps Playwright reads and plain navigation quiet after untrusted content, with the gate on", () => {
    const client = { callTool: vi.fn() } as never;
    const nav = adaptMcpTool("playwright", client, { name: "browser_navigate", inputSchema: {}, annotations: { destructiveHint: true } }, { ignoreDestructiveHints: true, networkRead: true });
    const snap = adaptMcpTool("playwright", client, { name: "browser_snapshot", inputSchema: {}, annotations: { readOnlyHint: true } }, { trustAnnotations: true });
    const click = adaptMcpTool("playwright", client, { name: "browser_click", inputSchema: {}, annotations: { destructiveHint: true } }, { ignoreDestructiveHints: true });
    const policy = (tool: typeof nav, derivation: { kind: "link" } | { kind: "derived"; reason: string }, args: Record<string, unknown> = {}) =>
      resolvePermission({ name: tool.name, autoApprove: true, args, untrusted: true, untrustedDerivation: derivation, readOnly: tool.readOnly, destructive: tool.destructive, checkIrreversible: tool.checkIrreversible, networkRead: tool.networkRead }).action;
    expect(policy(nav, { kind: "link" }, { url: "https://example.com/next" })).toBe("run");
    expect(policy(nav, { kind: "derived", reason: "It opens a URL the page composed." }, { url: "https://evil.example/?q=secret" })).toBe("prompt");
    expect(policy(snap, { kind: "link" })).toBe("run");
    // A change after untrusted content still asks while the gate is on.
    expect(policy(click, { kind: "link" }, { element: "Next page", ref: "e1" })).toBe("prompt");
  });
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
      expect(mcpToolRisk({ ...flagged, name }, false, true)).toMatchObject({ destructive: true, destructiveReason: expect.stringContaining("Moss always asks") });
      // Moss's reason replaces the server's even when its flags are honored.
      expect(mcpToolRisk({ ...flagged, name }, false, false).destructiveReason).toBeDefined();
    }
    const evaluate = adaptMcpTool("playwright", { callTool: vi.fn() } as never, { name: "browser_evaluate", description: "Evaluate JavaScript.", inputSchema: {}, ...flagged }, { ignoreDestructiveHints: true });
    expect(evaluate.description).toContain("prefer the server's snapshot or text tool");
    expect(resolvePermission({ name: evaluate.name, autoApprove: true, destructive: evaluate.destructive, destructiveReason: evaluate.destructiveReason }))
      .toMatchObject({ action: "prompt", rule: expect.stringContaining("runs code inside the page") });
    const tool = adaptMcpTool("playwright", { callTool: vi.fn() } as never, { name: "browser_navigate", inputSchema: {}, ...flagged }, { ignoreDestructiveHints: true });
    expect(tool.destructive).toBeUndefined();
    expect(tool.checkIrreversible).toBe(true);
  });
});