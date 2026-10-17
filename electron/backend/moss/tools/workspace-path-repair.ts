// electron/backend/moss/tools/workspace-path-repair.ts
//
// Models trained in containers write /workspace/src/a.js or /repo/src/a.js,
// and some put a slash in front of a relative path (/src/a.js). The workspace
// sandbox rightly refuses those, and a small model tends to repeat the same
// path. This rewrites such an argument to the workspace-relative path it
// clearly means, before any guard runs, so protected paths, approvals,
// checkpoints, and the sandbox all see the real path.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ToolCall } from "../../../../common/types";

/** File tools and the arguments that name a workspace path. */
const PATH_ARGUMENTS: Record<string, readonly string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  move_file: ["from", "to"],
  list_dir: ["path"],
  search_files: ["path"],
  glob_files: ["path"],
  git_diff: ["path"],
  view_image: ["path"],
};

/** First folders that container images use for the project. */
const CONTAINER_ROOTS = new Set(["workspace", "workspaces", "repo", "testbed", "app", "code", "project"]);

const escapes = (rel: string): boolean => rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel);

/** The workspace-relative path a rooted, drive-less path means, or undefined
 *  when it is fine as it is or there is no clear reading. A candidate must name
 *  something in the workspace, or a new file in a folder that exists. */
export function repairWorkspacePath(workspaceRoot: string, input: string): string | undefined {
  if (!workspaceRoot || !/^[\\/](?![\\/])/.test(input)) return undefined;
  if (!escapes(relative(workspaceRoot, resolve(workspaceRoot, input)))) return undefined;
  const parts = input.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.includes("..") || parts[0].includes(":")) return undefined;
  // `list_dir /workspace` is a container-trained model's usual first call.
  if (parts.length === 1 && CONTAINER_ROOTS.has(parts[0].toLowerCase()) && !existsSync(resolve(workspaceRoot, parts[0]))) return ".";
  const candidates = [parts.join("/")];
  // The literal reading first: in a Rails project /app/models/a.rb is app/models/a.rb.
  if (CONTAINER_ROOTS.has(parts[0].toLowerCase()) && parts.length > 1) candidates.push(parts.slice(1).join("/"));
  for (const candidate of candidates) {
    const abs = resolve(workspaceRoot, candidate);
    if (escapes(relative(workspaceRoot, abs))) continue;
    if (existsSync(abs)) return candidate;
  }
  // A new file: only where its folder already exists, never a new tree.
  for (const candidate of candidates) {
    const abs = resolve(workspaceRoot, candidate);
    if (!escapes(relative(workspaceRoot, abs)) && candidate.includes("/") && existsSync(dirname(abs))) return candidate;
  }
  const rest = parts.slice(1).join("/");
  return CONTAINER_ROOTS.has(parts[0].toLowerCase()) && parts.length === 2 ? rest : undefined;
}

/** A glob such as `/workspace/src/**` relative to the workspace (`src/**`). */
function repairGlobPattern(workspaceRoot: string, pattern: string): string | undefined {
  const match = /^[\\/](?![\\/])([^\\/:*?{]+)[\\/](.+)$/.exec(pattern);
  if (!match || match[2].split(/[\\/]/).includes("..")) return undefined;
  if (CONTAINER_ROOTS.has(match[1].toLowerCase()) && !existsSync(resolve(workspaceRoot, match[1]))) return match[2];
  return existsSync(resolve(workspaceRoot, match[1])) ? `${match[1]}/${match[2]}` : undefined;
}

/** Rewrite container-style path arguments of a file tool call. */
export function repairPathArguments(call: ToolCall, workspaceRoot: string | undefined): { call: ToolCall; repairs: string[] } {
  const keys = PATH_ARGUMENTS[call.name];
  if (!keys || !workspaceRoot) return { call, repairs: [] };
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { call, repairs: [] };
    args = parsed as Record<string, unknown>;
  } catch {
    return { call, repairs: [] };
  }
  const repairs: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const repaired = repairWorkspacePath(workspaceRoot, value);
    if (repaired === undefined) continue;
    args[key] = repaired;
    repairs.push(`read ${key} ${value} as ${repaired} in the workspace`);
  }
  if (call.name === "glob_files" && typeof args.pattern === "string") {
    const repaired = repairGlobPattern(workspaceRoot, args.pattern);
    if (repaired !== undefined) {
      repairs.push(`read pattern ${args.pattern} as ${repaired} in the workspace`);
      args.pattern = repaired;
    }
  }
  return repairs.length > 0 ? { call: { ...call, arguments: JSON.stringify(args) }, repairs } : { call, repairs };
}
