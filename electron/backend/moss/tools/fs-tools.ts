// electron/backend/moss/tools/fs-tools.ts

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { resolveInWorkspace } from "./path-guard";
import { type LineMatches, RegexLineMatcher } from "./regex-worker";

/** How long a regular-expression search may run before it is stopped. */
const REGEX_BUDGET_MS = 5_000;
import type { Tool, ToolContext, ToolResult } from "./types";

/** What the model sees of one result when the runner does not say (no context limit). */
const DEFAULT_RESULT_CHARS = 8_000;
/** Files larger than this are not searched: they are almost always generated
 *  or data, and reading them whole would stall the search. */
const MAX_SEARCH_FILE_BYTES = 1_000_000;

// Directories never worth walking for a workspace text search: version control,
// dependencies, caches, and build output.
const SEARCH_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "dist-electron", "release",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox",
  "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".gradle",
]);

/** The file's line ending: CRLF when most of its line breaks are CRLF, else LF. */
const eolOf = (text: string): "\r\n" | "\n" => {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
};
const withEol = (text: string, eol: "\r\n" | "\n"): string => text.replace(/\r?\n/g, eol);

/** Where oldText was probably meant to match: lines whose trimmed text equals
 *  oldText's first non-blank line, with the file's actual text there, so a
 *  model can copy it exactly on the next try. */
function nearMiss(text: string, oldText: string): string {
  const first = oldText.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!first) return "";
  const lines = text.split(/\r?\n/);
  const hits = lines.flatMap((line, index) => (line.trim() === first ? [index] : []));
  if (hits.length === 0) return " Its first line does not appear in the file either; read the file again before editing.";
  const span = oldText.split(/\r?\n/).length;
  const shown = lines.slice(hits[0], hits[0] + span).join("\n").slice(0, 1_500);
  const where = hits.slice(0, 5).map((index) => index + 1).join(", ");
  return ` Its first line appears at line ${where}, but the text there differs (indentation, spacing, or the following lines). The file has at line ${hits[0] + 1}:\n${shown}`;
}

/** Count literal (non-regex) occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function clampInt(value: unknown, dflt: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace. A file too long for one result comes back a page of whole lines at a time, with the next startLine to ask for. Pass startLine and endLine (1-based, inclusive) to read part of a file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      startLine: { type: "number", description: "First line to return (1-based, default 1)" },
      endLine: { type: "number", description: "Last line to return (inclusive, default the end)" },
    },
    required: ["path"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, content: `File not found: ${args.path}. Use glob_files or list_dir to find it.` };
      if (code === "EISDIR") return { ok: false, content: `${args.path} is a directory; use list_dir to see its contents.` };
      throw error;
    }
    // A file that fits is returned as is. A longer one is returned a page of
    // whole lines at a time, sized to what the model sees of one result, so it
    // gets exact text to edit rather than a head-and-tail preview.
    // Measured in UTF-8 bytes, as the runner's spill limit is, so a page of
    // non-English text is not spilled to a preview after all.
    const budget = Math.max(1_000, (ctx.maxResultChars ?? DEFAULT_RESULT_CHARS) - 200);
    const ranged = args.startLine !== undefined || args.endLine !== undefined;
    if (!ranged && Buffer.byteLength(text) <= budget) return { ok: true, content: text };
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = clampInt(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
    if (start > total) return { ok: false, content: `${args.path} has ${total} lines; startLine ${start} is past the end.` };
    const end = clampInt(args.endLine, total, start, total);
    const shown: string[] = [];
    let used = 0;
    for (let index = start - 1; index < end; index++) {
      const line = lines[index];
      const size = Buffer.byteLength(line) + 1;
      if (shown.length > 0 && used + size > budget) break;
      shown.push(size > budget ? `${line.slice(0, Math.floor(budget / 4))}…[line cut: it is longer than one result]` : line);
      used += Math.min(size, budget);
    }
    const last = start + shown.length - 1;
    const more = last < end ? `; to read on, call read_file with startLine=${last + 1}` : "";
    return { ok: true, content: `[lines ${start}-${last} of ${total}${more}]\n${shown.join("\n")}` };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List the entries of a directory in the workspace. Directories end with a trailing slash.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative directory path (default '.')" } },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = String(args.path ?? ".");
    const abs = resolveInWorkspace(ctx.workspaceRoot, target || ".");
    const entries = await readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return { ok: true, content: "(empty)" };
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, content: lines.join("\n") };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file in the workspace. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    let content = String(args.content ?? "");
    // Overwriting a CRLF file keeps CRLF, so the change is not a whole-file diff.
    const existing = await readFile(abs, "utf8").catch(() => undefined);
    if (existing !== undefined && eolOf(existing) === "\r\n" && !content.includes("\r\n")) content = withEol(content, "\r\n");
    await ctx.checkpoint?.record(abs, String(args.path ?? ""));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    // Saying how much a file shrank lets a model notice it dropped part of it.
    const lineCount = (text: string): number => text.split(/\r?\n/).length;
    const overwrote = existing !== undefined ? ` (replaced ${lineCount(existing)} lines with ${lineCount(content)})` : "";
    return { ok: true, content: `Wrote ${content.length} bytes to ${args.path}${overwrote}` };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make a surgical edit to an existing workspace file by replacing an exact text snippet. Prefer this over write_file to change part of a file without rewriting the whole thing. oldText must match exactly (including whitespace) and be unique unless replaceAll is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      oldText: {
        type: "string",
        description: "Exact existing text to replace, including enough surrounding context to be unique",
      },
      newText: { type: "string" },
      replaceAll: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match (default false)",
      },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    let oldText = String(args.oldText ?? "");
    if (!oldText) return { ok: false, content: "oldText is required" };
    let newText = String(args.newText ?? "");
    if (oldText === newText) return { ok: false, content: "oldText and newText are the same, so there is nothing to change." };
    const replaceAll = args.replaceAll === true;

    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      return { ok: false, content: `File not found: ${args.path}. To create a file, use write_file.` };
    }

    // Models write \n; a Windows file may use \r\n. Match and write in the file's own line ending.
    let count = countOccurrences(text, oldText);
    // In a file with mixed line endings, the other ending may be the one that matches.
    for (const eol of [eolOf(text), eolOf(text) === "\r\n" ? "\n" : "\r\n"] as const) {
      if (count > 0 || withEol(oldText, eol) === oldText) continue;
      const converted = withEol(oldText, eol);
      const found = countOccurrences(text, converted);
      if (found > 0) {
        oldText = converted;
        count = found;
      }
    }
    // Lines a model writes with \n take a CRLF file's line ending, so the file
    // does not end up mixed; text that already has \r\n is kept as written.
    if (eolOf(text) === "\r\n" && !newText.includes("\r\n")) newText = withEol(newText, "\r\n");
    if (count === 0) return { ok: false, content: `oldText not found in ${args.path}.${nearMiss(text, oldText)}` };
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        content: `oldText matches ${count} places in ${args.path}; add surrounding context to make it unique, or set replaceAll to true`,
      };
    }

    // A replacement function keeps newText literal so "$&"/"$1" style sequences
    // are written verbatim rather than interpreted by String.prototype.replace.
    const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    await ctx.checkpoint?.record(abs, String(args.path ?? ""));
    await writeFile(abs, updated, "utf8");
    const n = replaceAll ? count : 1;
    const line = text.slice(0, text.indexOf(oldText)).split("\n").length;
    return { ok: true, content: `Replaced ${n} occurrence${n === 1 ? "" : "s"} in ${args.path}${n === 1 ? ` at line ${line}` : ""}` };
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search workspace files for text (case-insensitive) and return matching lines as 'path:line: text'. The query is literal unless regex is true. Lockfiles and minified files are skipped unless include names them.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for (case-insensitive)" },
      regex: { type: "boolean", description: "Treat query as a JavaScript regular expression, e.g. 'foo|bar' (default false)" },
      include: { type: "string", description: "Only search files whose name or path matches this glob, e.g. '*.ts' or 'src/**/*.{ts,tsx}'" },
      path: {
        type: "string",
        description: "Workspace-relative directory to search under (default '.')",
      },
      maxResults: { type: "number", description: "Maximum matching lines to return (default 100, max 1000)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (!query.trim()) return { ok: false, content: "query is required" };
    const searchRoot = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ".") || ".");
    const maxResults = clampInt(args.maxResults, 100, 1, 1000);
    let match: (lines: string[]) => LineMatches | Promise<LineMatches>;
    let regex: RegexLineMatcher | undefined;
    if (args.regex === true) {
      try {
        new RegExp(query, "i");
      } catch (error) {
        return { ok: false, content: `Invalid regular expression: ${(error as Error).message}` };
      }
      // A slow pattern runs out its time in a worker instead of freezing the app.
      regex = new RegexLineMatcher(query, "i", REGEX_BUDGET_MS);
      const matcher = regex;
      match = (lines) => matcher.match(lines.map((line) => (line.length > 2_000 ? line.slice(0, 2_000) : line)));
    } else {
      const needle = query.toLowerCase();
      match = (lines) => lines.flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []));
    }
    const include = typeof args.include === "string" && args.include.trim() ? args.include.trim() : "";
    const includeTest = include ? globToRegExp(include.startsWith("./") ? include.slice(2) : include) : undefined;
    // Like glob_files: a pattern with "/" matches the path under the search folder, one without matches the name.
    const fileFilter = (abs: string): boolean => {
      const rel = relative(searchRoot, abs).split(sep).join("/");
      return includeTest ? includeTest.test(include.includes("/") ? rel : basename(abs)) : !NOISE_FILES.test(rel);
    };

    const matches: string[] = [];
    let timedOut = false;
    try {
      timedOut = await collectMatches(searchRoot, ctx, match, fileFilter, matches, maxResults);
    } finally {
      regex?.close();
    }

    const stopped = timedOut ? `\n[stopped after ${REGEX_BUDGET_MS / 1000} seconds: the regular expression is too slow; simplify it]` : "";
    if (matches.length === 0) {
      const hint = args.regex !== true && /[|\\()[\]*+?^$]/.test(query) ? " The query was read as literal text; set regex to true to search for a pattern." : "";
      return { ok: !timedOut, content: `No matches for "${query}".${hint}${stopped}` };
    }
    const capped = matches.length >= maxResults;
    const body = matches.join("\n");
    return { ok: true, content: `${capped ? `${body}\n…[capped at ${maxResults} matches]` : body}${stopped}` };
  },
};

/** Generated files that match almost any search and crowd out source lines. */
const NOISE_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$/i;

/** Walk `dir` collecting matching lines; returns true when a regex search ran out of time. */
async function collectMatches(
  dir: string,
  ctx: ToolContext,
  match: (lines: string[]) => LineMatches | Promise<LineMatches>,
  fileFilter: (abs: string) => boolean,
  out: string[],
  max: number,
): Promise<boolean> {
  if (ctx.signal.aborted || out.length >= max) return false;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  for (const entry of entries) {
    if (ctx.signal.aborted || out.length >= max) return false;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      if (await collectMatches(abs, ctx, match, fileFilter, out, max)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fileFilter(abs)) continue;
    const rel = relative(ctx.workspaceRoot, abs).split(sep).join("/");
    let text: string;
    try {
      if ((await stat(abs)).size > MAX_SEARCH_FILE_BYTES) continue;
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // skip binary files
    const lines = text.split(/\r?\n/);
    const hits = await match(lines);
    if (hits === "timeout") return true;
    for (const i of hits) {
      if (out.length >= max) return false;
      out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  return false;
}

const GLOB_MAX_DEFAULT = 200;
const GLOB_MAX = 2000;

// Convert a glob to an anchored RegExp. `**`/`**` spans path segments, `*` stays
// within a segment, `?` is a single non-separator char, and `{ts,tsx}` is any of
// its comma-separated parts. The `**/` token also matches zero directories so
// `**/*.ts` finds top-level files too.
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`, "i");
}

function globSource(glob: string): string {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "{") {
      let depth = 0;
      let end = i;
      for (; end < glob.length; end++) {
        if (glob[end] === "{") depth++;
        else if (glob[end] === "}" && --depth === 0) break;
      }
      if (end < glob.length) {
        const parts: string[] = [];
        let start = i + 1;
        depth = 0;
        for (let j = i + 1; j < end; j++) {
          if (glob[j] === "{") depth++;
          else if (glob[j] === "}") depth--;
          else if (glob[j] === "," && depth === 0) {
            parts.push(glob.slice(start, j));
            start = j + 1;
          }
        }
        parts.push(glob.slice(start, end));
        re += `(?:${parts.map(globSource).join("|")})`;
        i = end + 1;
        continue;
      }
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*\\/)*"; // **/ -> zero or more path segments
          i += 3;
        } else {
          re += ".*"; // trailing **
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "/") {
      re += "\\/";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return re;
}

export const globFilesTool: Tool = {
  name: "glob_files",
  description:
    "Find workspace files whose path matches a glob pattern. Supports '*' (within a path segment), '**' (across segments), '?', and '{ts,tsx}'. A pattern without '/', such as '*.test.ts', matches file names in every folder; './*.ts' matches only the top folder. Returns matching paths one per line, sorted. Skips .git, dependency, cache, and build output directories.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the search root, e.g. 'src/**/*.ts'" },
      path: {
        type: "string",
        description: "Workspace-relative directory to search under (default '.')",
      },
      maxResults: { type: "number", description: "Maximum paths to return (default 200, max 2000)" },
    },
    required: ["pattern"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern.trim()) return { ok: false, content: "pattern is required" };
    const searchRoot = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ".") || ".");
    const max = clampInt(args.maxResults, GLOB_MAX_DEFAULT, 1, GLOB_MAX);
    const pathPattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;
    const regex = globToRegExp(pathPattern);

    const out: string[] = [];
    // Collect past the cap so the result is sorted rather than walk-ordered.
    await collectFiles(searchRoot, ctx, regex, searchRoot, out, GLOB_MAX + 1, !pattern.includes("/"));
    if (out.length === 0) return { ok: true, content: `No files match "${pattern}"` };
    out.sort();
    const capped = out.length > max;
    const body = out.slice(0, max).join("\n");
    return { ok: true, content: capped ? `${body}\n\u2026[capped at ${max} matches]` : body };
  },
};

async function collectFiles(
  dir: string,
  ctx: ToolContext,
  regex: RegExp,
  searchRoot: string,
  out: string[],
  max: number,
  byName = false,
): Promise<void> {
  if (ctx.signal.aborted || out.length >= max) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (ctx.signal.aborted || out.length >= max) return;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(abs, ctx, regex, searchRoot, out, max, byName);
      continue;
    }
    if (!entry.isFile()) continue;
    const relMatch = relative(searchRoot, abs).split(sep).join("/");
    if (regex.test(byName ? basename(abs) : relMatch)) {
      out.push(relative(ctx.workspaceRoot, abs).split(sep).join("/"));
    }
  }
}

export const moveFileTool: Tool = {
  name: "move_file",
  description:
    "Move or rename a file or directory within the workspace. The destination's parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Existing workspace-relative path" },
      to: { type: "string", description: "New workspace-relative path" },
    },
    required: ["from", "to"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const fromAbs = resolveInWorkspace(ctx.workspaceRoot, String(args.from ?? ""));
    const toAbs = resolveInWorkspace(ctx.workspaceRoot, String(args.to ?? ""));
    await ctx.checkpoint?.record(fromAbs, String(args.from ?? ""));
    await ctx.checkpoint?.record(toAbs, String(args.to ?? ""));
    try {
      await mkdir(dirname(toAbs), { recursive: true });
      await rename(fromAbs, toAbs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { ok: false, content: `Source not found: ${args.from}` };
      return { ok: false, content: e.message };
    }
    return { ok: true, content: `Moved ${args.from} to ${args.to}` };
  },
};
