// electron/backend/moss/workspace/orientation.ts
//
// A short map of the workspace for coding turns: the files (capped, cache and
// build folders skipped) and the project's test and build commands. Small
// models otherwise spend their first rounds listing folders and guessing
// paths, at a minute or more per round on a local GPU.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { wrapExternalContent } from "../safety/untrusted-wrap";
import { suggestVerificationCommands } from "./workspace-insights";

const MAX_FILES = 60;
const MAX_SCANNED = 3_000;
const MAX_DEPTH = 4;
const SKIPPED = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".venv", "venv", "__pycache__", "target", ".idea", ".vscode", ".cache", ".turbo", "vendor", "bin", "obj"]);

/** A file name fit to show a model: control characters removed, length
 *  capped, and names that read like sentences (a prompt-injection vector in a
 *  cloned repository) left out. */
function safeName(rel: string): string | undefined {
  const name = rel.replace(/[\u0000-\u001f\u007f]/g, "");
  const base = name.split("/").at(-1) ?? name;
  if (base.trim().split(/\s+/).length >= 5) return undefined;
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

/** Files under the workspace in breadth-first order, so the top of the tree comes first. */
async function listFiles(root: string): Promise<{ files: string[]; more: boolean }> {
  const files: string[] = [];
  let scanned = 0;
  let more = false;
  let level: string[] = [""];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) return { files, more: true };
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".")) next.push(rel);
        } else if (entry.isFile() && !entry.name.startsWith(".")) {
          const name = safeName(rel);
          if (name === undefined) continue;
          if (files.length < MAX_FILES) files.push(name);
          else more = true;
        }
      }
    }
    level = next;
  }
  return { files, more: more || level.length > 0 };
}

/** The orientation note, or "" when the workspace cannot be read. */
export async function workspaceOrientation(workspaceRoot: string): Promise<string> {
  if (!workspaceRoot) return "";
  const [{ files, more }, commands] = await Promise.all([listFiles(workspaceRoot), suggestVerificationCommands(workspaceRoot).catch(() => [])]);
  if (files.length === 0) return "";
  // File names come from whoever wrote the repository: data, never instructions.
  const lines = [
    `Workspace files (paths relative to the workspace folder${more ? `; the first ${files.length}, without hidden files and dependency and build folders` : ""}):`,
    wrapExternalContent("workspace-file-names", files.join("\n")),
  ];
  if (commands.length > 0) lines.push(`Project commands: ${commands.map((item) => item.command).join(", ")}`);
  return lines.join("\n");
}
