// electron/web-access.test.ts
//
// The browser-access server against real sockets: the bridge, its token, the
// host check, dispatch to registered IPC handlers, pushed events, and the files
// of the built interface.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { get, request } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { WebAccess } from "./web-access";
import { ipcHandlers, requireTrustedSender, setAppLocation } from "./window-guard";

let dir: string;
let distDir: string;
let statePath: string;
const preloadPath = join(__dirname, "preload.cjs");
const servers: WebAccess[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "moss-web-"));
  distDir = join(dir, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<!doctype html><html><head><script type=\"module\" src=\"./assets/app.js\"></script></head><body><div id=\"root\"></div></body></html>");
  await writeFile(join(distDir, "assets", "app.js"), "console.log('app');");
  await writeFile(join(dir, "secret.txt"), "outside");
  // Trust checks are live, as in the app: the web client must pass them by its own mark.
  setAppLocation({ distDir });
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function started(settings?: string, options: { reconnectGraceMs?: number } = {}): Promise<{ server: WebAccess; base: string; token: string }> {
  statePath = join(dir, `state-${servers.length}-${Date.now()}.json`);
  await writeFile(statePath, JSON.stringify({ port: 0 }));
  const server = new WebAccess({ distDir, preloadPath, statePath, ...options });
  servers.push(server);
  const status = await server.enable(settings);
  const url = new URL(status.url!);
  return { server, base: url.origin, token: url.hash.replace("#token=", "") };
}

function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Open the event stream and collect its events until closed. */
function events(base: string, token: string, client: string): Promise<{ events: Array<{ event: string; data: string }>; close: () => void; next: (name: string) => Promise<{ event: string; data: string }> }> {
  return new Promise((resolve, reject) => {
    const seen: Array<{ event: string; data: string }> = [];
    const waiters: Array<{ name: string; done: (value: { event: string; data: string }) => void }> = [];
    const req = get(`${base}/__moss/events?client=${client}&token=${token}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || data === undefined) continue;
          const item = { event, data };
          seen.push(item);
          for (const waiter of waiters.splice(0)) {
            if (waiter.name === event) waiter.done(item);
            else waiters.push(waiter);
          }
        }
      });
      resolve({
        events: seen,
        close: () => req.destroy(),
        next: (name) => new Promise((done) => {
          const found = seen.find((item) => item.event === name && !("taken" in item));
          if (found) {
            Object.assign(found, { taken: true });
            done(found);
          } else waiters.push({ name, done });
        }),
      });
    });
    req.on("error", reject);
  });
}

const CLIENT = "12345678-1234-1234-1234-123456789abc";

function post(base: string, token: string, kind: "invoke" | "send", channel: string, args: unknown[], client = CLIENT) {
  return raw(`${base}/__moss/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-moss-client": client },
    body: JSON.stringify({ channel, args }),
  });
}

describe("WebAccess", () => {
  it("serves the interface with the bridge ahead of the app, and a bridge that parses", async () => {
    const { base } = await started();
    const page = await raw(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script src="/__moss/bridge.js"></script>');
    expect(page.body.indexOf("/__moss/bridge.js")).toBeLessThan(page.body.indexOf("./assets/app.js"));
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect((await raw(`${base}/assets/app.js`)).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const bridge = await raw(`${base}/__moss/bridge.js`);
    expect(bridge.status).toBe(200);
    expect(() => new Script(bridge.body)).not.toThrow();
    expect(bridge.body).toContain(await readFile(preloadPath, "utf8"));
  });

  it("serves nothing outside the built interface", async () => {
    const { base } = await started();
    for (const path of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/.hidden", "/assets"]) {
      expect((await raw(`${base}${path}`)).status, path).toBe(404);
    }
  });

  it("answers only requests addressed to it", async () => {
    const { base } = await started();
    expect((await raw(`${base}/`, { headers: { host: "rebound.example:80" } })).status).toBe(403);
  });

  it("refuses the API without the link's token", async () => {
    const { base, token } = await started("{\"model\":\"m\"}");
    expect((await raw(`${base}/__moss/seed`)).status).toBe(401);
    expect((await raw(`${base}/__moss/seed`, { headers: { authorization: `Bearer ${token.slice(1)}x` } })).status).toBe(401);
    const seed = await raw(`${base}/__moss/seed`, { headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(seed.body)).toEqual({ settings: "{\"model\":\"m\"}" });
    await expect(events(base, "wrong", CLIENT)).rejects.toThrow(/HTTP 401/);
  });

  it("dispatches calls to the registered handlers and pushes their events back", async () => {
    const { base, token } = await started();
    const received: unknown[] = [];
    ipcHandlers.invoke.set("test:echo", (event, value) => {
      requireTrustedSender(event, "test");
      (event.sender as unknown as { send: (channel: string, payload: unknown) => void }).send("test:pushed", { got: value });
      return { echoed: value };
    });
    ipcHandlers.invoke.set("test:fails", () => { throw new Error("handler failed"); });
    ipcHandlers.send.set("test:fire", (_event, value) => { received.push(value); });
    try {
      // Before the page connects there is nobody to answer to.
      expect((await post(base, token, "invoke", "test:echo", [1])).status).toBe(409);
      const stream = await events(base, token, CLIENT);
      await stream.next("ready");
      const reply = await post(base, token, "invoke", "test:echo", [{ n: 2 }]);
      expect(JSON.parse(reply.body)).toEqual({ value: { echoed: { n: 2 } } });
      expect(JSON.parse((await stream.next("ipc")).data)).toEqual({ channel: "test:pushed", payload: { got: { n: 2 } } });
      expect(JSON.parse((await post(base, token, "invoke", "test:fails", [])).body)).toEqual({ error: "handler failed" });
      expect((await post(base, token, "invoke", "test:unknown", [])).status).toBe(404);
      expect((await post(base, token, "send", "test:fire", ["x"])).status).toBe(200);
      expect(received).toEqual(["x"]);
      // A plain form post cannot reach a handler.
      const form = await raw(`${base}/__moss/send`, { method: "POST", headers: { "content-type": "text/plain", authorization: `Bearer ${token}`, "x-moss-client": CLIENT }, body: "{}" });
      expect(form.status).toBe(415);
      stream.close();
    } finally {
      ipcHandlers.invoke.delete("test:echo");
      ipcHandlers.invoke.delete("test:fails");
      ipcHandlers.send.delete("test:fire");
    }
  });

  it("stops a page's work when it goes away and does not come back", async () => {
    const { base, token } = await started(undefined, { reconnectGraceMs: 50 });
    let destroyed = false;
    ipcHandlers.invoke.set("test:watch", (event) => {
      (event.sender as unknown as NodeJS.EventEmitter).once("destroyed", () => { destroyed = true; });
    });
    try {
      const stream = await events(base, token, CLIENT);
      await stream.next("ready");
      await post(base, token, "invoke", "test:watch", []);
      stream.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(destroyed).toBe(true);
    } finally {
      ipcHandlers.invoke.delete("test:watch");
    }
  });

  it("keeps its link across restarts, and makes a new one when turned off and on", async () => {
    const { server, base, token } = await started();
    server.close();
    const again = new WebAccess({ distDir, preloadPath, statePath });
    servers.push(again);
    const restored = await again.restore();
    expect(restored.url).toBe(`${base}/#token=${token}`);
    await again.disable();
    expect(again.status()).toEqual({ enabled: false });
    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("token");
    const renewed = await again.enable();
    expect(renewed.url).not.toContain(token);
  });
});
