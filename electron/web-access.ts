// electron/web-access.ts
//
// Moss in a web browser on this PC, when the user turns it on. A loopback
// server sends the built interface plus a bridge script that stands in for the
// preload: window.moss calls go over HTTP to the same IPC handlers the window
// reaches, and events the main process pushes come back as server-sent events.
//
// The link carries a random token in its #fragment, which never reaches the
// server or a log. The bridge keeps it in this origin's own storage and sends
// it as a header, so another site, or a previewed page on another port, has no
// ambient credential to borrow: a cookie would be sent to every port on
// 127.0.0.1. Requests addressed to any other host name are refused (DNS rebinding).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { previewContentType } from "./backend/moss/workspace/preview-server";
import { ipcHandlers, trustWebEvent } from "./window-guard";

/** Same port every run when it is free, so a bookmark keeps working. */
export const PREFERRED_WEB_PORT = 47821;
/** A dropped event stream may reconnect this long before its turns are stopped. */
const RECONNECT_GRACE_MS = 15_000;
/** Chat requests carry attached images and documents. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 2_000;
/** Channels that act on the desktop window itself. */
const WINDOW_ONLY_CHANNELS = new Set(["moss:window:focus"]);

export interface WebAccessStatus {
  enabled: boolean;
  /** the link to open, with its token */
  url?: string;
  error?: string;
}

interface StoredState {
  enabled?: boolean;
  token?: string;
  port?: number;
  /** the desktop window's saved settings, given to a browser that has none */
  settings?: string;
}

const NO_TOKEN = "Open Moss in this browser with the link from Moss: Settings > Browser access. The link carries the key that lets this page use Moss.";
const REFUSED = "This link is no longer valid, or browser access is off. Copy the current link from Moss: Settings > Browser access.";

/** Runs in the page before the app. Defines contextBridge and ipcRenderer for
 *  the preload source that follows it. */
const BRIDGE = String.raw`"use strict";
const TOKEN_KEY = "moss.webToken";
const linked = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
if (linked) {
  localStorage.setItem(TOKEN_KEY, linked[1]);
  history.replaceState(null, "", location.pathname + location.search);
}
const token = localStorage.getItem(TOKEN_KEY) || "";
const clientId = crypto.randomUUID();
const listeners = new Map();
const refuse = (message) => {
  const show = () => {
    document.body.textContent = "";
    const note = document.createElement("p");
    note.style.cssText = "font:16px system-ui,sans-serif;margin:40px;max-width:40rem;line-height:1.5";
    note.textContent = message;
    document.body.append(note);
  };
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
};
let ready;
if (!token) {
  ready = Promise.reject(new Error("No browser-access key"));
  refuse(NO_TOKEN_MESSAGE);
} else {
  ready = new Promise((resolve, reject) => {
    const events = new EventSource("/__moss/events?client=" + encodeURIComponent(clientId) + "&token=" + encodeURIComponent(token));
    events.addEventListener("ready", () => resolve());
    events.addEventListener("ipc", (event) => {
      const message = JSON.parse(event.data);
      for (const listener of listeners.get(message.channel) || []) listener({}, message.payload);
    });
    events.onerror = () => {
      if (events.readyState !== EventSource.CLOSED) return;
      reject(new Error("Browser access refused"));
      refuse(REFUSED_MESSAGE);
    };
  });
  // First visit from this browser: start from the desktop window's settings.
  if (localStorage.getItem("moss.settings") === null) {
    fetch("/__moss/seed", { headers: { authorization: "Bearer " + token } })
      .then((response) => (response.ok ? response.json() : null))
      .then((seed) => {
        if (seed && typeof seed.settings === "string") {
          localStorage.setItem("moss.settings", seed.settings);
          location.reload();
        }
      })
      .catch(() => undefined);
  }
}
ready.catch(() => undefined);
async function call(kind, channel, args) {
  await ready;
  const response = await fetch("/__moss/" + kind, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token, "x-moss-client": clientId },
    body: JSON.stringify({ channel, args }),
  });
  const body = await response.json().catch(() => ({ error: "HTTP " + response.status }));
  if (!response.ok || "error" in body) throw new Error(body.error || "HTTP " + response.status);
  return body.value;
}
const ipcRenderer = {
  invoke: (channel, ...args) => call("invoke", channel, args),
  send: (channel, ...args) => {
    call("send", channel, args).catch((error) => console.error("Moss: " + channel + " failed", error));
  },
  on: (channel, listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
  },
  removeListener: (channel, listener) => {
    const set = listeners.get(channel);
    if (set) set.delete(listener);
  },
};
const contextBridge = { exposeInMainWorld: (key, api) => { window[key] = api; } };
window.__MOSS_WEB__ = true;
`;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type WebSender = EventEmitter & { isDestroyed(): boolean; send(channel: string, payload: unknown): void };

/** One open page. Its sender stands in for the window's webContents. */
class WebClient {
  readonly sender: WebSender;
  readonly event: object;
  private stream: ServerResponse | undefined;
  private queue: string[] = [];
  private destroyed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly graceMs: number) {
    const sender = new EventEmitter() as WebSender;
    sender.isDestroyed = () => this.destroyed;
    sender.send = (channel, payload) => this.push(channel, payload);
    this.sender = sender;
    this.event = trustWebEvent({ sender, senderFrame: null, frameId: 0, processId: 0 });
  }

  attach(stream: ServerResponse): void {
    clearTimeout(this.timer);
    this.stream = stream;
    for (const message of this.queue) stream.write(message);
    this.queue = [];
  }

  /** The stream closed: give the page time to reconnect before its turns stop. */
  detach(stream: ServerResponse, onGone: () => void): void {
    if (this.stream !== stream) return;
    this.stream = undefined;
    this.timer = setTimeout(() => this.destroy(onGone), this.graceMs);
  }

  destroy(onGone?: () => void): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    this.stream?.end();
    this.stream = undefined;
    this.sender.emit("destroyed");
    onGone?.();
  }

  private push(channel: string, payload: unknown): void {
    if (this.destroyed) return;
    const message = `event: ipc\ndata: ${JSON.stringify({ channel, payload })}\n\n`;
    if (this.stream) this.stream.write(message);
    else if (this.queue.length < MAX_QUEUED_EVENTS) this.queue.push(message);
  }
}

export interface WebAccessPaths {
  /** the built interface (dist/) */
  distDir: string;
  /** electron/preload.cjs, whose window.moss the bridge reproduces */
  preloadPath: string;
  /** where the setting, token, and port are kept */
  statePath: string;
  /** how long a dropped page may take to reconnect; tests shorten it */
  reconnectGraceMs?: number;
}

export class WebAccess {
  private server: Server | undefined;
  private port = 0;
  private token = "";
  private settings: string | undefined;
  private readonly clients = new Map<string, WebClient>();

  constructor(private readonly paths: WebAccessPaths) {}

  status(): WebAccessStatus {
    return this.server ? { enabled: true, url: `http://127.0.0.1:${this.port}/#token=${this.token}` } : { enabled: false };
  }

  /** Start again at launch if it was on when Moss closed. */
  async restore(): Promise<WebAccessStatus> {
    const state = await this.load();
    return state.enabled ? this.enable() : this.status();
  }

  /** Turn browser access on, keeping the link it had; `settings` is the desktop
   *  window's saved settings, given to browsers opening Moss for the first time. */
  async enable(settings?: string): Promise<WebAccessStatus> {
    const state = await this.load();
    if (settings !== undefined) this.settings = settings;
    else this.settings ??= state.settings;
    this.token ||= state.token ?? randomBytes(24).toString("base64url");
    if (!this.server) await this.listen(state.port ?? PREFERRED_WEB_PORT);
    await this.save({ enabled: true, token: this.token, port: this.port, ...(this.settings !== undefined ? { settings: this.settings } : {}) });
    return this.status();
  }

  /** Turn it off. Open pages stop, and the next link gets a new token. */
  async disable(): Promise<WebAccessStatus> {
    const port = this.port;
    this.close();
    this.token = "";
    await this.save({ enabled: false, port });
    return this.status();
  }

  /** Stop serving (app quit) without changing the saved setting. */
  close(): void {
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
  }

  private async load(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.statePath, "utf8")) as StoredState;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async save(state: StoredState): Promise<void> {
    await mkdir(dirname(this.paths.statePath), { recursive: true });
    await writeFile(this.paths.statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  }

  private listen(port: number): Promise<void> {
    const attempt = (target: number): Promise<Server> => new Promise((resolveServer, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error: unknown) => {
          if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          else res.destroy();
        });
      });
      server.once("error", reject);
      server.listen(target, "127.0.0.1", () => resolveServer(server));
    });
    return attempt(port)
      .catch((error: NodeJS.ErrnoException) => {
        // Taken by something else: any free port, kept for next time.
        if (error.code === "EADDRINUSE" && port !== 0) return attempt(0);
        throw error;
      })
      .then((server) => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
      });
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const given = Buffer.from(header ?? (url.pathname === "/__moss/events" ? url.searchParams.get("token") ?? "" : ""));
    const expected = Buffer.from(this.token);
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return plain(res, 403, "Forbidden");
    const url = new URL(req.url ?? "/", "http://moss");
    if (!url.pathname.startsWith("/__moss/")) return this.serveFile(req, res, url.pathname);

    if (url.pathname === "/__moss/bridge.js" && req.method === "GET") {
      const preload = await readFile(this.paths.preloadPath, "utf8");
      const script = `(() => {\nconst NO_TOKEN_MESSAGE = ${JSON.stringify(NO_TOKEN)};\nconst REFUSED_MESSAGE = ${JSON.stringify(REFUSED)};\n${BRIDGE}\n((require) => {\n${preload}\n})(() => ({ contextBridge, ipcRenderer }));\n})();\n`;
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(script);
      return;
    }
    if (!this.authorized(req, url)) return json(res, 401, { error: REFUSED });

    if (url.pathname === "/__moss/events" && req.method === "GET") return this.openEvents(req, res, url);
    if (url.pathname === "/__moss/seed" && req.method === "GET") return json(res, 200, this.settings !== undefined ? { settings: this.settings } : {});
    if ((url.pathname === "/__moss/invoke" || url.pathname === "/__moss/send") && req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "Expected JSON" });
      const client = this.clients.get(String(req.headers["x-moss-client"] ?? ""));
      if (!client) return json(res, 409, { error: "Not connected" });
      let message: { channel?: unknown; args?: unknown };
      try {
        message = JSON.parse(await readBody(req)) as typeof message;
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
      }
      const channel = message.channel;
      const args = Array.isArray(message.args) ? message.args : [];
      if (typeof channel !== "string") return json(res, 400, { error: "Missing channel" });
      if (url.pathname === "/__moss/send") {
        const listener = ipcHandlers.send.get(channel);
        if (!listener) return json(res, 404, { error: `Unknown channel ${channel}` });
        listener(client.event as Electron.IpcMainEvent, ...args);
        return json(res, 200, {});
      }
      if (WINDOW_ONLY_CHANNELS.has(channel)) return json(res, 200, {});
      const handler = ipcHandlers.invoke.get(channel);
      if (!handler) return json(res, 404, { error: `Unknown channel ${channel}` });
      try {
        const value = await handler(client.event as Electron.IpcMainInvokeEvent, ...args);
        return json(res, 200, value === undefined ? {} : { value });
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return json(res, 404, { error: "Not found" });
  }

  private openEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = url.searchParams.get("client") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: "Bad client id" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
    let client = this.clients.get(id);
    if (!client) {
      client = new WebClient(this.paths.reconnectGraceMs ?? RECONNECT_GRACE_MS);
      this.clients.set(id, client);
    }
    res.write("event: ready\ndata: {}\n\n");
    client.attach(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    const current = client;
    req.on("close", () => {
      clearInterval(heartbeat);
      current.detach(res, () => {
        if (this.clients.get(id) === current) this.clients.delete(id);
      });
    });
  }

  private async serveFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "Method not allowed");
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return plain(res, 400, "Bad request");
    }
    if (relative === "/") relative = "/index.html";
    if (relative.includes("\0") || relative.split(/[\\/]/).some((segment) => segment.startsWith("."))) return plain(res, 404, "Not found");
    const root = resolve(this.paths.distDir);
    const absolute = resolve(join(root, normalize(relative)));
    if (!absolute.startsWith(root + sep)) return plain(res, 404, "Not found");
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return plain(res, 404, "Not found");
    }
    if (!info.isFile()) return plain(res, 404, "Not found");
    const headers = {
      "content-type": previewContentType(absolute),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    };
    if (absolute.endsWith(`${sep}index.html`) && absolute === join(root, "index.html")) {
      // The bridge runs first: a classic script ahead of the app's own scripts.
      const html = await readFile(absolute, "utf8");
      const bridgeTag = `<script src="/__moss/bridge.js"></script>\n    `;
      const firstScript = html.search(/<script\b/i);
      const page = firstScript >= 0 ? html.slice(0, firstScript) + bridgeTag + html.slice(firstScript) : html.replace("</head>", `${bridgeTag}</head>`);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : page);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(info.size) });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(absolute).on("error", () => res.destroy()).pipe(res);
  }
}

let instance: WebAccess | undefined;

/** Create the app's browser-access server; main calls this once at startup. */
export function configureWebAccess(paths: WebAccessPaths): WebAccess {
  instance = new WebAccess(paths);
  return instance;
}

/** The configured server, if main has set one up (absent in tests and headless use). */
export function webAccess(): WebAccess | undefined {
  return instance;
}
