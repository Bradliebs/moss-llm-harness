// electron/main.ts
//
// Composition root for the Moss main process. Creates the window, points the
// renderer at the Vite dev server (dev) or the built bundle (prod), and
// registers IPC handlers.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { app, BrowserWindow, Menu, session } from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { createLogger } from "../common/logger";
import { mcpManager } from "./backend/moss/mcp/mcp-manager";
import { memoryStore } from "./backend/moss/memory/memory-store";
import { taskEngine } from "./backend/moss/task/task-engine";
import { productDiagnostics } from "./backend/moss/product-diagnostics";
import { registerChatIpc } from "./ipc/chat-ipc";

const log = createLogger("Main");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const processStartedAt = Date.now();

let mainWindow: BrowserWindow | null = null;

function fmtError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Path to the persistent main-process log under userData. A packaged Windows
 *  GUI app has no attached console, so without this file a startup failure is
 *  completely invisible. Location: %APPDATA%/Moss/moss-main.log on Windows. */
function logFilePath(): string {
  return join(app.getPath("userData"), "moss-main.log");
}

/** Best-effort append to the persistent log. Only writes for packaged builds
 *  (in dev/test the console logger already captures everything, and we must not
 *  litter the filesystem during tests). Never throws. */
function fileLog(line: string): void {
  if (!app.isPackaged) return;
  try {
    const path = logFilePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // Logging is best-effort; there is nothing useful to do if it fails.
  }
}

// Catch otherwise-silent crashes in the main process. On a fresh machine these
// are the difference between a diagnosable error and "nothing happens".
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  fileLog(`uncaughtException: ${fmtError(err)}`);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
  fileLog(`unhandledRejection: ${fmtError(reason)}`);
});

/** Replace a failed renderer load with a readable error page so the user sees a
 *  reportable message instead of a blank/black window. Guarded against re-entry
 *  so a failure to load the fallback itself cannot loop. */
let showingLoadError = false;
function showLoadError(detail: string): void {
  if (showingLoadError || !mainWindow) return;
  showingLoadError = true;
  const body = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;background:#0b0b0f;color:#e6e6ea;margin:0;padding:32px">
<h2>Moss could not load its interface</h2>
<p>${detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)}</p>
<p style="color:#9a9aa5">A log was written to:<br><code>${logFilePath()}</code></p>
</body>`;
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || !params.isEditable) return;

    const suggestions: MenuItemConstructorOptions[] = params.misspelledWord
      ? params.dictionarySuggestions.slice(0, 8).map((suggestion) => ({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        }))
      : [];

    if (params.misspelledWord && suggestions.length === 0) {
      suggestions.push({ label: "No spelling suggestions", enabled: false });
    }

    const editActions: MenuItemConstructorOptions[] = [
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ];
    const template = suggestions.length > 0
      ? [...suggestions, { type: "separator" as const }, ...editActions]
      : editActions;

    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    // -3 is ERR_ABORTED, which fires on benign in-flight navigations; ignore it.
    if (errorCode === -3) return;
    const detail = `Load failed (${errorCode}) ${errorDescription} ${validatedURL}`;
    log.error(detail);
    fileLog(detail);
    showLoadError(detail);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const detail = `Renderer process gone: ${details.reason} (exit ${details.exitCode})`;
    log.error(detail);
    fileLog(detail);
    showLoadError(detail);
  });
  mainWindow.webContents.once("did-finish-load", () => {
    void productDiagnostics.record("renderer-startup", { durationMs: Date.now() - processStartedAt });
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = join(app.getAppPath(), "dist", "index.html");
    fileLog(`loading renderer from ${indexPath}`);
    void mainWindow.loadFile(indexPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app
  .whenReady()
  .then(() => {
    fileLog(`app ready (packaged=${app.isPackaged}, appPath=${app.getAppPath()})`);
    // Windows attributes toast notifications to this id; it must match appId.
    if (process.platform === "win32") {
      try {
        app.setAppUserModelId("com.moss.app");
      } catch (err) {
        fileLog(`setAppUserModelId failed: ${fmtError(err)}`);
      }
    }
    // Each startup step is isolated: a failure in one must not prevent the
    // window from appearing, otherwise the app fails silently with no UI.
    try {
      memoryStore.reload();
    } catch (err) {
      fileLog(`memoryStore.reload failed: ${fmtError(err)}`);
    }
    try {
      registerChatIpc();
    } catch (err) {
      fileLog(`registerChatIpc failed: ${fmtError(err)}`);
    }
    // Active work is never replayed blindly after a crash. Persist it as an
    // explicit resumable pause so the renderer can inspect and resume safely.
    void taskEngine.recoverInterruptedTasks().catch((err) => {
      log.error("Task recovery failed", err);
      fileLog(`task recovery failed: ${fmtError(err)}`);
    });
    try {
      // The renderer captures microphone audio for speech-to-text. This is a
      // local, trusted app, so grant only the media permission it needs.
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === "media");
      });
    } catch (err) {
      fileLog(`setPermissionRequestHandler failed: ${fmtError(err)}`);
    }
    createWindow();
    // Connect MCP servers in the background; tool availability updates the
    // registry the next time a turn starts, so this need not block the window.
    void mcpManager.init().catch((err) => log.error("MCP init failed", err));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => {
    log.error("startup failed", err);
    fileLog(`startup failed: ${fmtError(err)}`);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void mcpManager.close();
});
