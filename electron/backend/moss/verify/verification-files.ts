// electron/backend/moss/verify/verification-files.ts
//
// Files that decide what the verification commands execute. A model that can
// rewrite them can make "npm test" pass without fixing anything, so changing
// them while verification decides "done" needs a person.

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { matchesProtected } from "../governed/working-state";
import { classifyCommand } from "../permission";
import { resolveInWorkspace } from "../tools/path-guard";

/** Files at the root of a project (or any package) that define its checks. */
const DEFINITION_FILES = [
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc",
  "tsconfig*.json", ".eslintrc*", ".babelrc*", ".mocharc*", "jest.setup.*", "vitest.setup.*", "*.config.*",
  "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "conftest.py", "noxfile.py", ".coveragerc", "requirements*.txt",
  "Makefile", "justfile", "Taskfile.yml", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle*", "settings.gradle*", "gradle.properties", "*.csproj", "*.sln", "Directory.Build.props", "Directory.Build.targets",
  "Gemfile", "Rakefile", "karma.conf.js",
];

/** Folders whose contents define how checks run. */
const DEFINITION_FOLDERS = [".github", "scripts"];

export const VERIFICATION_FILES: readonly string[] = [
  // "**/" matches at the root too.
  ...DEFINITION_FILES.map((pattern) => `**/${pattern}`),
  ...DEFINITION_FOLDERS.map((folder) => `${folder}/**`),
];

const PATH_ARGUMENTS: Record<string, readonly string[]> = {
  write_file: ["path"],
  edit_file: ["path"],
  move_file: ["from", "to"],
};

/** A folder being moved that holds files defining the checks. */
function folderDefinesChecks(path: string, workspaceRoot: string): boolean {
  if (!workspaceRoot) return false;
  try {
    const absolute = resolveInWorkspace(workspaceRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return false;
    if (DEFINITION_FOLDERS.includes(basename(absolute))) return true;
    return ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "Makefile"].some((name) => existsSync(join(absolute, name)));
  } catch {
    return false;
  }
}

/** Literal names a command would have to mention to change a check definition. */
const COMMAND_MENTIONS = /(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|\.config\.\w+|pytest\.ini|conftest\.py|pyproject\.toml|setup\.(?:py|cfg)|tox\.ini|Makefile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|\.csproj|\.github[\\/]|(?:^|[\s"'])scripts[\\/])|\bnpm\s+(?:pkg\s+set|set-script)\b/i;

const GIT_BOOKKEEPING = /^\s*git\s+(?:add|commit|stash|checkout|restore)\b/i;

/** The verification file a tool call would change, if any. */
export function verificationFileTouched(toolName: string, args: Readonly<Record<string, unknown>>, workspaceRoot: string): string | undefined {
  for (const key of PATH_ARGUMENTS[toolName] ?? []) {
    const value = args[key];
    if (typeof value !== "string") continue;
    if (matchesProtected(value, VERIFICATION_FILES, workspaceRoot)) return value;
    if (toolName === "move_file" && key === "from" && folderDefinesChecks(value, workspaceRoot)) return value;
  }
  if (toolName === "run_command" && typeof args.command === "string" && classifyCommand(args.command) !== "readonly") {
    for (const part of args.command.split(/\s*(?:\|\||&&|&|\||;|\r?\n|\r)\s*/)) {
      // Staging, committing, or restoring a file does not change what it says.
      if (GIT_BOOKKEEPING.test(part) || classifyCommand(part) === "readonly") continue;
      const match = part.match(COMMAND_MENTIONS);
      if (match) return match[0].trim();
    }
  }
  return undefined;
}
