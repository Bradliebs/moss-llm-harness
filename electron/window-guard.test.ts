import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { guardedIpc, guardWindow, isAppUrl, isTrustedSender, requireTrustedSender, setAppLocation } from "./window-guard";

afterEach(() => setAppLocation({}));

function fakeContents() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  return {
    contents: {
      setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
      on: (name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); },
    },
    open: (url: string) => openHandler!({ url }),
    navigate: (url: string) => {
      const event = { preventDefault: vi.fn() };
      handlers.get("will-navigate")!(event, url);
      return event.preventDefault.mock.calls.length > 0;
    },
  };
}

describe("window guard", () => {
  it("recognizes only the app's own pages", () => {
    const dist = join(process.cwd(), "dist");
    setAppLocation({ distDir: dist });
    expect(isAppUrl(pathToFileURL(join(dist, "index.html")).href)).toBe(true);
    expect(isAppUrl(pathToFileURL(join(process.cwd(), "other.html")).href)).toBe(false);
    expect(isAppUrl("https://evil.example/")).toBe(false);
    setAppLocation({ devServerUrl: "http://localhost:5173/" });
    expect(isAppUrl("http://localhost:5173/#/chat")).toBe(true);
    expect(isAppUrl("http://localhost:5174/")).toBe(false);
  });

  it("refuses new windows and foreign navigation, sending web links to the browser", () => {
    setAppLocation({ devServerUrl: "http://localhost:5173" });
    const opened: string[] = [];
    const window = fakeContents();
    guardWindow(window.contents as never, (url) => opened.push(url));
    expect(window.open("https://example.com/page")).toEqual({ action: "deny" });
    expect(window.open("file:///C:/secrets.txt")).toEqual({ action: "deny" });
    expect(window.navigate("https://example.com/other")).toBe(true);
    expect(window.navigate("file:///C:/dropped.html")).toBe(true);
    expect(window.navigate("http://localhost:5173/")).toBe(false);
    expect(opened).toEqual(["https://example.com/page", "https://example.com/other"]);
  });

  it("answers privileged requests only from the app's own frame", () => {
    setAppLocation({ devServerUrl: "http://localhost:5173" });
    expect(isTrustedSender({ senderFrame: { url: "http://localhost:5173/" } })).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: "https://evil.example/" } })).toBe(false);
    expect(isTrustedSender({ senderFrame: null })).toBe(false);
    expect(() => requireTrustedSender({ senderFrame: { url: "https://evil.example/" } }, "adding an MCP server")).toThrow(/Refused adding an MCP server/);
  });
  it("guards every handler registered through the wrapped ipcMain", async () => {
    setAppLocation({ devServerUrl: "http://localhost:5173" });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: (channel: string, fn: (...args: unknown[]) => unknown) => listeners.set(channel, fn) };
    const guarded = guardedIpc(ipc as never);
    const handled = vi.fn(() => "ok");
    const heard = vi.fn();
    guarded.handle("moss:skill:create", handled as never);
    guarded.on("moss:chat:start", heard as never);
    const app = { senderFrame: { url: "http://localhost:5173/" } };
    const evil = { senderFrame: { url: "https://evil.example/" } };
    expect(handlers.get("moss:skill:create")!(app, "x")).toBe("ok");
    expect(() => handlers.get("moss:skill:create")!(evil, "x")).toThrow(/Refused moss:skill:create/);
    listeners.get("moss:chat:start")!(evil, {});
    expect(heard).not.toHaveBeenCalled();
    listeners.get("moss:chat:start")!(app, {});
    expect(heard).toHaveBeenCalledOnce();
  });});
