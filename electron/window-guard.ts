// electron/window-guard.ts
//
// Keeps the privileged window on Moss's own interface. The preload bridge can
// add MCP servers, which run commands, and read stored API keys, so no other
// page may ever load in a window that has it: links open in the system browser
// instead, new windows are refused, and privileged IPC answers only frames that
// show the app itself.

import { pathToFileURL } from "node:url";

import type { IpcMain, WebContents } from "electron";

let appOrigin: { devServer?: string; distRoot?: string } = {};

/** Record where the interface is served from: the dev server, or the built files. */
export function setAppLocation(location: { devServerUrl?: string; distDir?: string }): void {
  appOrigin = {
    ...(location.devServerUrl ? { devServer: new URL(location.devServerUrl).origin } : {}),
    ...(location.distDir ? { distRoot: pathToFileURL(location.distDir).href.replace(/\/?$/, "/") } : {}),
  };
}

/** True for the app's own pages only. */
export function isAppUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (appOrigin.devServer && url.origin === appOrigin.devServer) return true;
  if (appOrigin.distRoot && url.protocol === "file:") {
    const href = `${url.protocol}//${url.host}${url.pathname}`;
    return href.toLowerCase().startsWith(appOrigin.distRoot.toLowerCase());
  }
  return false;
}

function isWebLink(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/** Refuse new windows and foreign navigation; web links go to the system browser. */
export function guardWindow(contents: WebContents, openExternal: (url: string) => void): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isWebLink(url)) openExternal(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/** For privileged IPC: the request came from a frame showing the app itself. */
export function isTrustedSender(event: { senderFrame?: { url?: string } | null }): boolean {
  // Before the main process records the app location (tests, headless use)
  // there is no window to impersonate.
  if (!appOrigin.devServer && !appOrigin.distRoot) return true;
  return isAppUrl(event.senderFrame?.url);
}

/** Throw for a privileged request from anything but the app's own page. */
export function requireTrustedSender(event: { senderFrame?: { url?: string } | null }, action: string): void {
  if (!isTrustedSender(event)) throw new Error(`Refused ${action}: the request did not come from the Moss interface.`);
}

/** An ipcMain whose handlers answer only the app's own page: invoke calls from
 *  anywhere else are rejected and fire-and-forget messages are dropped. */
export function guardedIpc(ipc: IpcMain): IpcMain {
  const guarded = Object.create(ipc) as IpcMain;
  guarded.handle = (channel, listener) => ipc.handle(channel, (event, ...args) => {
    requireTrustedSender(event, channel);
    return listener(event, ...args);
  });
  guarded.on = (channel, listener) => ipc.on(channel, (event, ...args) => {
    if (isTrustedSender(event)) listener(event, ...args);
  });
  return guarded;
}