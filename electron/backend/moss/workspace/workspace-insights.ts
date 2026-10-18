// electron/backend/moss/workspace/workspace-insights.ts
//
// Read-only workspace helpers for the renderer: the current content of a file a
// pending write would change (for approval diffs), and verification commands
// inferred from well-known project manifests. Both stay inside the workspace
// sandbox and never execute anything.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { VerificationSuggestion, WorkspaceFilePreview } from "../../../../common/types";
import { resolveInWorkspace } from "../tools/path-guard";

export const MAX_PREVIEW_BYTES = 256 * 1024;

export async function readWorkspacePreview(workspaceRoot: string, path: string): Promise<WorkspaceFilePreview> {
  let absolute: string;
  try {
    absolute = resolveInWorkspace(workspaceRoot, path);
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { exists: true, error: "Not a regular file" };
    if (info.size > MAX_PREVIEW_BYTES) return { exists: true, truncated: true, byteLength: info.size };
    const buffer = await readFile(absolute);
    if (buffer.includes(0)) return { exists: true, binary: true, byteLength: info.size };
    return { exists: true, content: buffer.toString("utf8"), byteLength: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A file: URL for an HTML page inside the workspace, so the user can open a
 *  page the agent wrote in their browser; null for anything else. The path
 *  goes through the workspace sandbox check, so it cannot name a file outside. */
export async function workspaceHtmlUrl(workspaceRoot: string, path: string): Promise<string | null> {
  if (!workspaceRoot || !/\.html?$/i.test(path)) return null;
  let absolute: string;
  try {
    absolute = resolveInWorkspace(workspaceRoot, path);
  } catch {
    return null;
  }
  try {
    if (!(await stat(absolute)).isFile()) return null;
  } catch {
    return null;
  }
  return pathToFileURL(absolute).href;
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Largest workspace image a reply shows inline. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** A data: URL for a raster image inside the workspace that a reply refers to
 *  (`![chart](charts/q3.png)`), or null. The path goes through the workspace
 *  sandbox check; a leading slash or a file: URL means the same place. */
export async function workspaceImageDataUrl(workspaceRoot: string, reference: string): Promise<string | null> {
  if (!workspaceRoot || !reference) return null;
  let path = reference.trim();
  try {
    path = path.startsWith("file:") ? fileURLToPath(path) : decodeURIComponent(path.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  if (/^[\\/](?![\\/])/.test(path)) path = path.slice(1);
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    const absolute = resolveInWorkspace(workspaceRoot, path);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_INLINE_IMAGE_BYTES) return null;
    return `data:${type};base64,${(await readFile(absolute)).toString("base64")}`;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function packageManager(entries: Set<string>): "npm" | "pnpm" | "yarn" | "bun" {
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("bun.lockb") || entries.has("bun.lock")) return "bun";
  return "npm";
}

/** Infer verification commands from project manifests at the workspace root.
 *  Suggestions are advisory: the user must accept each one before it becomes a
 *  mission verification method. */
export async function suggestVerificationCommands(workspaceRoot: string): Promise<VerificationSuggestion[]> {
  if (!workspaceRoot) return [];
  let names: string[];
  try {
    names = await readdir(workspaceRoot);
  } catch {
    return [];
  }
  const entries = new Set(names);
  const suggestions: VerificationSuggestion[] = [];
  const add = (command: string, source: string): void => {
    if (!suggestions.some((suggestion) => suggestion.command === command)) suggestions.push({ command, source });
  };

  if (entries.has("package.json")) {
    const text = await readText(join(workspaceRoot, "package.json"));
    try {
      const scripts = (JSON.parse(text ?? "{}") as { scripts?: Record<string, unknown> }).scripts ?? {};
      const manager = packageManager(entries);
      const run = (script: string): string => manager === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `${manager} ${script}`;
      for (const script of ["test", "typecheck", "lint", "build"]) {
        const value = scripts[script];
        if (typeof value === "string" && !/no test specified/i.test(value)) add(run(script), `package.json "${script}" script`);
      }
    } catch {
      // An unparsable manifest yields no suggestions rather than a failure.
    }
  }
  if (entries.has("pyproject.toml") || entries.has("pytest.ini") || entries.has("setup.cfg") || entries.has("tox.ini")) {
    const pyproject = entries.has("pyproject.toml") ? await readText(join(workspaceRoot, "pyproject.toml")) : "";
    if (entries.has("uv.lock")) add("uv run pytest", "uv project");
    else if (/\[tool\.poetry\]/.test(pyproject ?? "")) add("poetry run pytest", "Poetry project");
    else add("python -m pytest", entries.has("pytest.ini") ? "pytest.ini" : "Python project");
  }
  if (entries.has("Cargo.toml")) add("cargo test", "Cargo.toml");
  if (entries.has("go.mod")) add("go test ./...", "go.mod");
  if (names.some((name) => /\.(sln|csproj|fsproj)$/i.test(name))) add("dotnet test", ".NET solution or project");
  if (entries.has("pom.xml")) add("mvn -q test", "pom.xml");
  if (entries.has("build.gradle") || entries.has("build.gradle.kts")) add(entries.has("gradlew.bat") ? ".\\gradlew.bat test" : "gradle test", "Gradle build");
  if (entries.has("Makefile")) {
    const makefile = await readText(join(workspaceRoot, "Makefile"));
    if (/^test\s*:/m.test(makefile ?? "")) add("make test", "Makefile test target");
  }
  return suggestions.slice(0, 6);
}
