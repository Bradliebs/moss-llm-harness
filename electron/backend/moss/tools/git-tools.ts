// electron/backend/moss/tools/git-tools.ts
//
// Read-only git inspection, so the agent can see what it actually changed
// before the verify pass runs instead of guessing shell syntax through
// run_command.
//
// Both tools spawn git with an argument array and shell: false. A path
// argument therefore cannot inject a second command, and `--` terminates
// option parsing so a path beginning with `-` is treated as a path rather
// than a git flag. Neither tool can mutate the repository.

import { spawn } from "node:child_process";

import type { Tool, ToolContext, ToolResult } from "./types";

const OUTPUT_CAP = 20_000;
const TIMEOUT_MS = 30_000;

function runGit(args: string[], ctx: ToolContext, emptyMessage: string): Promise<ToolResult> {
  if (!ctx.workspaceRoot) {
    return Promise.resolve({ ok: false, content: "No workspace folder selected" });
  }

  return new Promise<ToolResult>((resolvePromise) => {
    // shell: false (the default) -- args are passed to git directly, so shell
    // metacharacters in a model-supplied path are inert.
    const child = spawn("git", args, { cwd: ctx.workspaceRoot });
    let out = "";
    let err = "";
    let settled = false;

    const onAbort = () => child.kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    child.stdout.on("data", (d: Buffer) => {
      if (out.length < OUTPUT_CAP) out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < OUTPUT_CAP) err += d.toString();
    });
    child.on("error", (e: Error) => finish({ ok: false, content: e.message }));
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        finish({ ok: false, content: err.trim() || out.trim() || `git exited with code ${code}` });
        return;
      }
      finish({ ok: true, content: out.trim() || emptyMessage });
    });
  });
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description: "Show the current branch and working tree status of the workspace repository.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return runGit(["status", "--porcelain=v1", "--branch"], ctx, "(working tree clean)");
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: "Show uncommitted changes to tracked files in the workspace repository as a unified diff. New untracked files are not included: git_status lists them and read_file shows them.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Limit the diff to this workspace-relative path" },
      staged: { type: "boolean", description: "Diff staged changes instead of unstaged" },
    },
  },
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ["diff"];
    if (args.staged === true) gitArgs.push("--staged");
    const path = String(args.path ?? "").trim();
    if (path) gitArgs.push("--", path);
    return runGit(gitArgs, ctx, "(no changes)");
  },
};

export const GIT_TOOLS: Tool[] = [gitStatusTool, gitDiffTool];
