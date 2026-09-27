// electron/main.test.ts
//
// Wiring test for the composition root. main.ts registers app lifecycle handlers
// and, once the app is ready, reloads memory, registers chat IPC, installs a
// permission handler, and opens a window. The security-relevant property is that
// the permission handler grants only "media" and denies everything else.
//
// electron and the backend singletons are mocked so importing main.ts does not
// touch a real Electron runtime. This file is excluded from both tsconfigs, so
// the loose mock typing here is never type-checked.

import { beforeAll, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  webContentsHandlers: new Map<string, (...args: any[]) => unknown>(),
  quit: vi.fn(),
  windows: 0,
  menuTemplate: [] as any[],
  menuPopup: vi.fn(),
  replaceMisspelling: vi.fn(),
  permission: null as null | ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void),
  reload: vi.fn(),
  registerIpc: vi.fn(),
  setAppUserModelId: vi.fn(),
  mcpInit: vi.fn(() => Promise.resolve()),
  mcpClose: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    webContents = {
      openDevTools: vi.fn(),
      on: (event: string, handler: (...args: any[]) => unknown) => {
        env.webContentsHandlers.set(event, handler);
      },
      once: (event: string, handler: (...args: any[]) => unknown) => {
        env.webContentsHandlers.set(event, handler);
      },
      replaceMisspelling: env.replaceMisspelling,
    };
    constructor() {
      env.windows += 1;
    }
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    on = vi.fn();
    static getAllWindows = (): unknown[] => [];
  }
  return {
    app: {
      isPackaged: false,
      getAppPath: () => "/app",
      getPath: () => "/tmp",
      whenReady: () => Promise.resolve(),
      setAppUserModelId: env.setAppUserModelId,
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        env.handlers.set(event, handler);
      },
      quit: env.quit,
    },
    BrowserWindow,
    Menu: {
      buildFromTemplate: (template: any[]) => {
        env.menuTemplate = template;
        return { popup: env.menuPopup };
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (
          handler: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void,
        ) => {
          env.permission = handler;
        },
      },
    },
  };
});

vi.mock("./backend/moss/memory/memory-store", () => ({ memoryStore: { reload: env.reload } }));
vi.mock("./ipc/chat-ipc", () => ({ registerChatIpc: env.registerIpc }));
vi.mock("./backend/moss/mcp/mcp-manager", () => ({
  mcpManager: { init: env.mcpInit, close: env.mcpClose },
}));

beforeAll(async () => {
  await import("./main");
  // Flush the app.whenReady().then(...) microtask chain.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("main composition root", () => {
  it("registers the window-all-closed and before-quit lifecycle handlers", () => {
    expect(env.handlers.has("window-all-closed")).toBe(true);
    expect(env.handlers.has("before-quit")).toBe(true);
  });

  it("wires up memory, IPC, a window, and a permission handler once ready", () => {
    expect(env.reload).toHaveBeenCalled();
    expect(env.registerIpc).toHaveBeenCalled();
    expect(env.windows).toBe(1);
    expect(typeof env.permission).toBe("function");
    if (process.platform === "win32") expect(env.setAppUserModelId).toHaveBeenCalledWith("com.moss.app");
  });

  it("grants the media permission and denies all others", () => {
    const grant = vi.fn();
    env.permission?.({}, "media", grant);
    expect(grant).toHaveBeenCalledWith(true);

    const deny = vi.fn();
    env.permission?.({}, "geolocation", deny);
    expect(deny).toHaveBeenCalledWith(false);
  });

  it("shows spelling suggestions and replaces the misspelled word", () => {
    env.webContentsHandlers.get("context-menu")?.({}, {
      isEditable: true,
      misspelledWord: "expecially",
      dictionarySuggestions: ["especially", "specially"],
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    });

    expect(env.menuTemplate.slice(0, 2).map((item) => item.label)).toEqual(["especially", "specially"]);
    env.menuTemplate[0].click();
    expect(env.replaceMisspelling).toHaveBeenCalledWith("especially");
    expect(env.menuPopup).toHaveBeenCalled();
  });

  it("quits on window-all-closed on non-darwin platforms", () => {
    env.handlers.get("window-all-closed")?.();
    expect(env.quit).toHaveBeenCalled();
  });

  it("closes the mcp manager before quit", () => {
    env.handlers.get("before-quit")?.();
    expect(env.mcpClose).toHaveBeenCalled();
  });
});
