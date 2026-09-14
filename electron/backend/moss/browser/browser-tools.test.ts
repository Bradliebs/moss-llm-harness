import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Tool, ToolContext } from "../tools/types";
import { BrowserSessionManager, createBrowserTools, type BrowserDriver } from "./browser-tools";

function context(workspaceRoot = resolve("browser-test-workspace")): ToolContext {
  return { workspaceRoot, signal: new AbortController().signal };
}

function fakeDriver(): BrowserDriver {
  return {
    navigate: vi.fn(async () => undefined),
    inspect: vi.fn(async () => "button Save\n".repeat(3_000)),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => undefined),
    currentUrl: vi.fn(async () => "https://example.com/done"),
    pageText: vi.fn(async () => "Order complete"),
    close: vi.fn(async () => undefined),
  };
}

function find(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function openedTools(driver: BrowserDriver): Promise<Tool[]> {
  const tools = createBrowserTools({ driverFactory: async () => driver, allowedDomains: ["example.com"] });
  await find(tools, "browser_open_session").execute({ taskId: "task-1", sessionId: "session-1" }, context());
  return tools;
}

describe("browser tools", () => {
  it("advertises only supported click targets while retaining CSS typing", () => {
    const tools = createBrowserTools({ driverFactory: async () => fakeDriver(), allowedDomains: ["example.com"] });
    const click = find(tools, "browser_click").parameters;
    expect(click.required).toEqual(["taskId", "sessionId", "role", "name"]);
    expect(click.properties).not.toHaveProperty("selector");
    expect(click.additionalProperties).toBe(false);
    expect(find(tools, "browser_type").parameters.properties).toHaveProperty("selector");
  });

  it("enforces active sessions and URL/domain security before driver access", async () => {
    const driver = fakeDriver();
    const tools = createBrowserTools({ driverFactory: async () => driver, allowedDomains: ["example.com"] });
    const navigate = find(tools, "browser_navigate");
    expect((await navigate.execute({ taskId: "t", sessionId: "s", url: "https://example.com" }, context())).ok).toBe(false);

    await find(tools, "browser_open_session").execute({ taskId: "t", sessionId: "s" }, context());
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,no", "https://evil.test/"]) {
      expect((await navigate.execute({ taskId: "t", sessionId: "s", url }, context())).ok).toBe(false);
    }
    expect(driver.navigate).not.toHaveBeenCalled();
    expect((await navigate.execute({ taskId: "t", sessionId: "s", url: "https://sub.example.com/page" }, context())).ok).toBe(true);
  });

  it("rejects redirects and operations after navigation leaves the allowlist", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.currentUrl).mockResolvedValue("https://evil.test/redirected");
    const tools = await openedTools(driver);
    expect((await find(tools, "browser_navigate").execute({ taskId: "task-1", sessionId: "session-1", url: "https://example.com/start" }, context())).ok).toBe(false);
    expect((await find(tools, "browser_inspect").execute({ taskId: "task-1", sessionId: "session-1", mode: "text" }, context())).ok).toBe(false);
    expect(driver.inspect).not.toHaveBeenCalled();
  });

  it("uses semantic actions and blocks final submit-like buttons", async () => {
    const driver = fakeDriver();
    const tools = await openedTools(driver);
    const click = find(tools, "browser_click");
    expect((await click.execute({ taskId: "task-1", sessionId: "session-1", role: "button", name: "Save draft" }, context())).ok).toBe(true);
    expect(driver.click).toHaveBeenCalledWith({ role: "button", name: "Save draft", selector: undefined });

    expect((await click.execute({ taskId: "task-1", sessionId: "session-1", selector: "#confirm-purchase" }, context())).ok).toBe(false);

    const blocked = await click.execute({ taskId: "task-1", sessionId: "session-1", role: "button", name: "Confirm purchase" }, context());
    expect(blocked).toEqual({ ok: false, content: expect.stringContaining("irreversible approval") });
    expect(driver.click).toHaveBeenCalledTimes(1);
    expect((await click.execute({ taskId: "task-1", sessionId: "session-1", role: "button", name: "Confirm purchase" }, { ...context(), approvalGranted: true })).ok).toBe(true);
  });

  it("guards screenshot paths and bounds inspected output", async () => {
    const driver = fakeDriver();
    const tools = await openedTools(driver);
    const screenshot = find(tools, "browser_screenshot");
    expect((await screenshot.execute({ taskId: "task-1", sessionId: "session-1", path: "../escape.png" }, context())).ok).toBe(false);
    expect(driver.screenshot).not.toHaveBeenCalled();
    expect((await screenshot.execute({ taskId: "task-1", sessionId: "session-1", path: "evidence/page.png" }, context())).ok).toBe(true);

    const inspected = await find(tools, "browser_inspect").execute({ taskId: "task-1", sessionId: "session-1", mode: "accessibility" }, context());
    expect(inspected.content.length).toBeLessThanOrEqual(20_020);
    expect(inspected.content).toContain("truncated");
  });

  it("asserts URL/text and closes all sessions", async () => {
    const first = fakeDriver();
    const second = fakeDriver();
    const manager = new BrowserSessionManager(async ({ sessionId }) => sessionId === "one" ? first : second);
    await manager.open("task", "one");
    await manager.open("task", "two");
    await manager.closeAll();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(() => manager.get("task", "one")).toThrow("No active browser session");

    const tools = await openedTools(fakeDriver());
    expect((await find(tools, "browser_assert_url").execute({ taskId: "task-1", sessionId: "session-1", expected: "https://example.com/done" }, context())).ok).toBe(true);
    expect((await find(tools, "browser_assert_text").execute({ taskId: "task-1", sessionId: "session-1", expected: "complete" }, context())).ok).toBe(true);
  });
});