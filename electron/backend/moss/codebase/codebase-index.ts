// electron/backend/moss/codebase/codebase-index.ts
//
// A local semantic index over a workspace's text files. Each file is split into
// fixed line windows, every window is embedded via an OpenAI-style /embeddings
// endpoint, and the vectors are persisted as flat JSON at
// <userData>/index/<wsHash>.json. search_codebase embeds a query and ranks
// windows by brute-force cosine similarity — no native deps, because the corpus
// a local embedding model can usefully index fits comfortably in memory for a
// linear scan.
//
// Reindex is mtime-incremental: a file whose mtime is unchanged since the last
// index keeps its existing chunks. Changing the embedding model forces a full
// rebuild, since vectors from different models are not comparable.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import type { CodebaseReindexResult, CodebaseStatus, EmbedConfig } from "../../../../common/types";
import { embedTexts } from "../providers/embeddings";

const log = createLogger("Codebase");

/** Directories never worth indexing; mirrors the search_files skip set. Anything
 *  beyond this (project-specific build/cache dirs) is excluded via .gitignore. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-electron", "release"]);
/** Lines per embedded window. Small enough that a hit points at a focused span. */
const CHUNK_LINES = 50;
/** Skip files larger than this; they are usually generated or binary blobs. */
const MAX_FILE_BYTES = 256 * 1024;
/** Chunks embedded per /embeddings request, to bound payload size. */
const EMBED_BATCH = 64;
const DEFAULT_TOP_K = 8;

interface IndexChunk {
  /** workspace-relative, '/'-separated path */
  path: string;
  /** 1-based inclusive line range the chunk covers */
  startLine: number;
  endLine: number;
  text: string;
  vector: number[];
}

interface PersistedIndex {
  version: 1;
  workspaceRoot: string;
  model: string;
  updatedAt: string;
  /** relPath -> mtimeMs at index time, for incremental reindex */
  files: Record<string, number>;
  chunks: IndexChunk[];
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

/** Split a glob fragment into a RegExp body (segment-scoped `*`, cross-segment
 *  `**`, single-char `?`); used for the minimal .gitignore matcher below. */
function globToRe(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/** Parse a .gitignore into match predicates over a POSIX relative path. Covers
 *  the common subset (comments, blanks, trailing-slash dirs, leading-slash
 *  anchors, `*`/`?`/`**` globs, basename-at-any-depth). Negation (`!`) is not
 *  supported and such lines are ignored. */
function parseGitignore(content: string): Array<(rel: string) => boolean> {
  const rules: Array<(rel: string) => boolean> = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    const body = globToRe(line);
    const re = line.includes("/") ? new RegExp(`^${body}(/|$)`) : new RegExp(`(^|/)${body}(/|$)`);
    rules.push((rel) => re.test(rel));
  }
  return rules;
}

function chunkText(path: string, text: string): Array<Omit<IndexChunk, "vector">> {
  const lines = text.split(/\r?\n/);
  const out: Array<Omit<IndexChunk, "vector">> = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.join("").trim() === "") continue; // skip all-whitespace windows
    out.push({ path, startLine: i + 1, endLine: Math.min(i + CHUNK_LINES, lines.length), text: slice.join("\n") });
  }
  return out;
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosine(q: number[], qNorm: number, v: number[]): number {
  const n = Math.min(q.length, v.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += q[i] * v[i];
  const vn = norm(v);
  if (vn === 0 || qNorm === 0) return 0;
  return dot / (qNorm * vn);
}

export class CodebaseIndex {
  private cache = new Map<string, PersistedIndex>();

  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private dir(): string {
    return join(this.baseDir ?? userDataDir(), "index");
  }

  private file(workspaceRoot: string): string {
    const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
    return join(this.dir(), `${hash}.json`);
  }

  private async load(workspaceRoot: string): Promise<PersistedIndex | null> {
    const cached = this.cache.get(workspaceRoot);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await readFile(this.file(workspaceRoot), "utf8")) as PersistedIndex;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.chunks)) {
        this.cache.set(workspaceRoot, parsed);
        return parsed;
      }
    } catch {
      // no index yet, or unreadable — treat as absent
    }
    return null;
  }

  private async save(index: PersistedIndex): Promise<void> {
    const path = this.file(index.workspaceRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(index), "utf8");
    this.cache.set(index.workspaceRoot, index);
  }

  async status(workspaceRoot: string): Promise<CodebaseStatus> {
    const idx = workspaceRoot ? await this.load(workspaceRoot) : null;
    if (!idx) return { indexed: false, files: 0, chunks: 0, model: "" };
    return {
      indexed: idx.chunks.length > 0,
      files: Object.keys(idx.files).length,
      chunks: idx.chunks.length,
      model: idx.model,
      updatedAt: idx.updatedAt,
    };
  }

  /** Walk the workspace, embed new/changed file windows, and persist the index.
   *  Best-effort per-file: an unreadable file is skipped, not fatal. */
  async reindex(workspaceRoot: string, config: EmbedConfig, signal?: AbortSignal): Promise<CodebaseReindexResult> {
    if (!workspaceRoot) return { ok: false, files: 0, chunks: 0, skipped: 0, error: "No workspace selected" };
    if (!config.model) return { ok: false, files: 0, chunks: 0, skipped: 0, error: "No embedding model configured" };
    const aborted = (): CodebaseReindexResult => ({ ok: false, files: 0, chunks: 0, skipped: 0, error: "Aborted" });
    try {
      const prev = await this.load(workspaceRoot);
      // Vectors from a different model are not comparable — drop reuse on change.
      const reuse = prev && prev.model === config.model ? prev : null;
      const ignore = await this.loadIgnore(workspaceRoot);

      const filePaths: string[] = [];
      await this.walk(workspaceRoot, workspaceRoot, ignore, signal, filePaths);

      const nextFiles: Record<string, number> = {};
      const keptChunks: IndexChunk[] = [];
      const pending: Array<Omit<IndexChunk, "vector">> = [];
      let skipped = 0;

      for (const abs of filePaths) {
        if (signal?.aborted) return aborted();
        const rel = relative(workspaceRoot, abs).split(sep).join("/");
        let st;
        try {
          st = await stat(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        nextFiles[rel] = st.mtimeMs;
        const reusable = reuse && reuse.files[rel] === st.mtimeMs ? reuse.chunks.filter((c) => c.path === rel) : null;
        if (reusable && reusable.length > 0) {
          keptChunks.push(...reusable);
          skipped++;
          continue;
        }
        let text: string;
        try {
          text = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) {
          delete nextFiles[rel]; // binary; do not index
          continue;
        }
        pending.push(...chunkText(rel, text));
      }

      const embedded: IndexChunk[] = [];
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        if (signal?.aborted) return aborted();
        const batch = pending.slice(i, i + EMBED_BATCH);
        const vectors = await embedTexts(config, batch.map((b) => b.text), signal);
        for (let j = 0; j < batch.length; j++) embedded.push({ ...batch[j], vector: vectors[j] ?? [] });
      }

      const chunks = [...keptChunks, ...embedded];
      await this.save({
        version: 1,
        workspaceRoot,
        model: config.model,
        updatedAt: new Date().toISOString(),
        files: nextFiles,
        chunks,
      });
      return { ok: true, files: Object.keys(nextFiles).length, chunks: chunks.length, skipped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("reindex failed", err);
      return { ok: false, files: 0, chunks: 0, skipped: 0, error: msg };
    }
  }

  /** Embed the query and return the top-k most similar indexed windows. Returns
   *  an empty list when the workspace has no index yet. */
  async search(
    workspaceRoot: string,
    config: EmbedConfig,
    query: string,
    topK = DEFAULT_TOP_K,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const idx = await this.load(workspaceRoot);
    if (!idx || idx.chunks.length === 0) return [];
    const [qv] = await embedTexts(config, [query], signal);
    if (!qv || qv.length === 0) return [];
    const qNorm = norm(qv);
    if (qNorm === 0) return [];
    const scored = idx.chunks.map((c) => ({ c, score: cosine(qv, qNorm, c.vector) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ c, score }) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      score,
      text: c.text,
    }));
  }

  private async loadIgnore(workspaceRoot: string): Promise<(rel: string) => boolean> {
    let rules: Array<(rel: string) => boolean> = [];
    try {
      rules = parseGitignore(await readFile(join(workspaceRoot, ".gitignore"), "utf8"));
    } catch {
      // no .gitignore — only SKIP_DIRS apply
    }
    return (rel) => rules.some((r) => r(rel));
  }

  private async walk(
    root: string,
    dir: string,
    ignore: (rel: string) => boolean,
    signal: AbortSignal | undefined,
    out: string[],
  ): Promise<void> {
    if (signal?.aborted) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (signal?.aborted) return;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ignore(rel)) continue;
        await this.walk(root, abs, ignore, signal, out);
      } else if (entry.isFile()) {
        if (ignore(rel)) continue;
        out.push(abs);
      }
    }
  }
}

/** Production singleton; tests construct their own with a baseDir override. */
export const codebaseIndex = new CodebaseIndex();
