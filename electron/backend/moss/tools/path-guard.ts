// electron/backend/moss/tools/path-guard.ts
//
// Resolves a tool-supplied path inside the workspace sandbox and rejects any
// path that escapes it: via `..`, an absolute path outside root, a different
// drive on Windows, or a symbolic link or junction inside the workspace that
// points outside it.

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel);
}

/** Real path of `path`, or of its nearest existing ancestor with the missing
 *  tail re-appended, so paths about to be created are checked too. */
function realPathOf(path: string, depth = 0): string {
  let existing = path;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    // existsSync follows links, so a link whose target is missing looks absent;
    // follow it by hand so a dangling link cannot point writes outside.
    const link = danglingLinkTarget(existing);
    if (link && depth < 8) return resolve(realPathOf(link, depth + 1), ...tail);
    const parent = dirname(existing);
    if (parent === existing) return path;
    tail.unshift(relative(parent, existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...tail);
}

function danglingLinkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

export function resolveInWorkspace(workspaceRoot: string, inputPath: string): string {
  if (!workspaceRoot) throw new Error("No workspace folder selected");
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("path is required");
  }
  const abs = isAbsolute(inputPath) ? normalize(inputPath) : resolve(workspaceRoot, inputPath);
  const rel = relative(workspaceRoot, abs);
  if (rel === "") return abs; // the root itself
  if (escapes(rel)) {
    throw new Error(`Path escapes the workspace sandbox: ${inputPath}`);
  }
  // A link inside the workspace can point anywhere; follow it before trusting it.
  if (existsSync(workspaceRoot)) {
    const realRel = relative(realpathSync.native(workspaceRoot), realPathOf(abs));
    if (realRel !== "" && escapes(realRel)) {
      throw new Error(`Path escapes the workspace sandbox through a link: ${inputPath}`);
    }
  }
  return abs;
}
