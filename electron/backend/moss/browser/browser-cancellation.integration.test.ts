import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createBrowserTools, type BrowserDriver } from "./browser-tools";
import { createPlaywrightDriverFactory } from "./playwright-driver";

it("Stop closes real Chromium and releases a missing-target click", async () => {
  const server = createServer((_request, response) => response.end("<html><body>Ready</body></html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const factory = createPlaywrightDriverFactory({ headless: true, allowedDomains: ["127.0.0.1"] });
  let driver!: BrowserDriver;
  const tools = createBrowserTools({ allowedDomains: ["127.0.0.1"], driverFactory: async (scope) => {
    driver = await factory(scope);
    vi.spyOn(driver, "click");
    vi.spyOn(driver, "close");
    return driver;
  } });
  const controller = new AbortController();
  const context = { workspaceRoot: "", signal: controller.signal };
  const args = { taskId: "test", sessionId: "browser" };
  const execute = (name: string, input = {}) => tools.find((tool) => tool.name === name)!.execute({ ...args, ...input }, context);
  try {
    expect((await execute("browser_open_session")).ok).toBe(true);
    expect((await execute("browser_navigate", { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })).ok).toBe(true);
    const pending = execute("browser_click", { role: "button", name: "Missing target" });
    await vi.waitFor(() => expect(driver.click).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(driver.close).toHaveBeenCalledOnce();
    await expect(driver.inspect("text")).rejects.toThrow();
  } finally {
    controller.abort();
    await tools[0].dispose?.();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 15_000);