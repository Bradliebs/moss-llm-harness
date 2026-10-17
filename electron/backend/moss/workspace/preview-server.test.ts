// electron/backend/moss/workspace/preview-server.test.ts

import { execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hiddenOnDisk, PreviewServer, previewContentType } from "./preview-server";

let dir: string;
let workspace: string;
const server = new PreviewServer();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "moss-preview-"));
  workspace = join(dir, "site");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, "index.html"), "<script type=module src=app.js></script>");
  await writeFile(join(workspace, "app.js"), "export const x = 1;");
  await writeFile(join(workspace, "sub", "index.html"), "sub page");
  await writeFile(join(workspace, ".env"), "SECRET=1");
  await writeFile(join(workspace, ".git", "config"), "secret");
  await writeFile(join(dir, "outside.txt"), "outside");
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function raw(url: string, init: { method?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: init.method ?? "GET", headers: init.host ? { host: init.host } : {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("PreviewServer", () => {
  it("serves a workspace page and its module script with types that let modules run", async () => {
    const url = await server.urlFor(workspace, "index.html");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/index\.html$/);
    const page = await raw(url);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    const script = await raw(url.replace("index.html", "app.js"));
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe("export const x = 1;");
  });

  it("gives each workspace one stable token", async () => {
    const first = await server.urlFor(workspace, "index.html");
    const again = await server.urlFor(`${workspace}/`, "sub/index.html");
    expect(new URL(again).pathname.split("/")[1]).toBe(new URL(first).pathname.split("/")[1]);
  });

  it("serves a folder's index page, redirecting to the trailing slash first", async () => {
    const base = (await server.urlFor(workspace, "index.html")).replace("/index.html", "");
    const bare = await raw(`${base}/sub`);
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toMatch(/\/sub\/$/);
    expect((await raw(`${base}/sub/`)).body).toBe("sub page");
  });

  it("never serves dotfiles, files outside the workspace, or unknown tokens", async () => {
    const base = (await server.urlFor(workspace, "index.html")).replace("/index.html", "");
    for (const path of ["/.env", "/.git/config", "/%2eenv", "/sub/..%2f..%2foutside.txt", "/..%5c..%5coutside.txt", "/../outside.txt", "/C:%5cWindows%5cwin.ini"]) {
      expect((await raw(`${base}${path}`)).status, path).toBe(404);
    }
    const port = new URL(base).port;
    expect((await raw(`http://127.0.0.1:${port}/${"0".repeat(48)}/index.html`)).status).toBe(404);
  });

  it("refuses dotfiles reached by their Windows short names", async () => {
    const base = (await server.urlFor(workspace, "index.html")).replace("/index.html", "");
    for (const path of ["/ENV~1", "/env~1", "/GIT~1/config"]) {
      expect((await raw(`${base}${path}`)).status, path).toBe(404);
    }
    expect(hiddenOnDisk(workspace, join(workspace, ".env"))).toBe(true);
    expect(hiddenOnDisk(workspace, join(workspace, ".git", "config"))).toBe(true);
    expect(hiddenOnDisk(workspace, join(workspace, "app.js"))).toBe(false);
    if (process.platform !== "win32") return;
    // Where the volume makes short names, the disk check sees through them too.
    const short = execSync('for %I in (".env") do @echo %~snxI', { cwd: workspace, shell: "cmd.exe" }).toString().trim();
    if (short && short !== ".env") expect(hiddenOnDisk(workspace, join(workspace, short))).toBe(true);
  });

  it("answers only requests addressed to it, and only reads", async () => {
    const url = await server.urlFor(workspace, "index.html");
    expect((await raw(url, { host: "attacker.example:80" })).status).toBe(403);
    expect((await raw(url, { method: "POST" })).status).toBe(405);
    const head = await raw(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });
});

describe("previewContentType", () => {
  it("knows web types and falls back to a download type", () => {
    expect(previewContentType("a.MJS")).toBe("text/javascript; charset=utf-8");
    expect(previewContentType("a.wasm")).toBe("application/wasm");
    expect(previewContentType("a.svg")).toBe("image/svg+xml");
    expect(previewContentType("a.unknown")).toBe("application/octet-stream");
  });
});
