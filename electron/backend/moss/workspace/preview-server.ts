// electron/backend/moss/workspace/preview-server.ts
//
// Serves workspace files over http://127.0.0.1 so a page the agent wrote can be
// previewed with what a file: page does not get: ES modules, fetch of its own
// files, and root-relative assets. Loopback only, read-only, one unguessable
// path prefix per workspace, and dotfiles (.env, .git) are never served.

import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, relative as relativeTo, resolve } from "node:path";

import { resolveInWorkspace } from "../tools/path-guard";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".pdf": "application/pdf",
};

export function previewContentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function rootKey(root: string): string {
  const normalized = resolve(root).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when the file, as named on disk, is a dotfile or inside a dot-folder.
 *  The URL alone is not enough: Windows also answers to short names such as
 *  ENV~1 for .env and GIT~1 for .git. */
export function hiddenOnDisk(root: string, absolute: string): boolean {
  const path = relativeTo(realpathSync.native(root), realpathSync.native(absolute));
  return path.split(/[\\/]/).some((segment) => segment.startsWith("."));
}

function reply(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers });
  res.end(text);
}

export class PreviewServer {
  private server: Server | undefined;
  private starting: Promise<number> | undefined;
  private port = 0;
  /** token -> workspace root, and the reverse */
  private readonly roots = new Map<string, string>();
  private readonly tokens = new Map<string, string>();

  /** The preview URL for a file in a workspace; starts the server on first use. */
  async urlFor(root: string, relativePath: string): Promise<string> {
    const port = await this.start();
    const key = rootKey(root);
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.tokens.set(key, token);
      this.roots.set(token, root);
    }
    const path = relativePath.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${port}/${token}/${path}`;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
    this.port = 0;
  }

  private start(): Promise<number> {
    this.starting ??= new Promise<number>((resolvePort, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) reply(res, 500, "Preview failed");
          else res.destroy();
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolvePort(this.port);
      });
    }).catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Another site that points its own name at 127.0.0.1 (DNS rebinding) sends
    // its own Host; only requests addressed to this server are answered.
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reply(res, 403, "Forbidden");
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Method not allowed", { allow: "GET, HEAD" });

    // The URL parser has already resolved any "." and ".." segments.
    const pathname = new URL(req.url ?? "/", "http://preview").pathname;
    const [, token = "", ...rest] = pathname.split("/");
    const root = this.roots.get(token);
    if (!root) return reply(res, 404, "Not found");
    if (rest.length === 0) return reply(res, 301, "Moved", { location: `/${token}/` });

    let segments: string[];
    try {
      segments = rest.map((segment) => decodeURIComponent(segment));
    } catch {
      return reply(res, 400, "Bad request");
    }
    // No dotfiles or dot-folders, no short names (~), and no separators or
    // drive/stream colons smuggled inside one segment.
    if (segments.some((segment) => segment.startsWith(".") || /[\\/:\0~]/.test(segment))) return reply(res, 404, "Not found");

    const relative = segments.filter(Boolean).join("/");
    let absolute: string;
    let info;
    try {
      absolute = resolveInWorkspace(root, relative || ".");
      info = await stat(absolute);
      if (info.isDirectory()) {
        // A folder's relative links resolve against its trailing slash.
        if (!pathname.endsWith("/")) return reply(res, 301, "Moved", { location: `${pathname}/` });
        absolute = resolveInWorkspace(root, relative ? `${relative}/index.html` : "index.html");
        info = await stat(absolute);
      }
      if (hiddenOnDisk(root, absolute)) return reply(res, 404, "Not found");
    } catch {
      return reply(res, 404, "Not found");
    }
    if (!info.isFile()) return reply(res, 404, "Not found");

    res.writeHead(200, {
      "content-type": previewContentType(absolute),
      "content-length": String(info.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(absolute);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}

/** The app's one preview server. */
export const previewServer = new PreviewServer();
