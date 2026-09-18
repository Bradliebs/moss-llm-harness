// electron/backend/moss/tools/shell-tool.ts
//
// Runs a shell command inside the workspace. This is the highest-risk tool and
// is always permission-gated (see permission.ts) — it is never auto-approved.

import { spawn } from "node:child_process";

import type { Tool, ToolContext, ToolResult } from "./types";

const OUTPUT_CAP = 20_000;
const TIMEOUT_MS = 60_000;

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a foreground shell command with its working directory set to the workspace root. Returns combined stdout/stderr when it exits. Commands are stopped after 60 seconds; do not use this tool to keep servers or watchers running.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  timeoutMs: TIMEOUT_MS,
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? "").trim();
    if (!command) return Promise.resolve({ ok: false, content: "command is required" });
    if (!ctx.workspaceRoot) {
      return Promise.resolve({ ok: false, content: "No workspace folder selected" });
    }
    if (ctx.signal.aborted) {
      return Promise.resolve({ ok: false, content: "Command aborted before launch" });
    }

    return runShellCommand(command, ctx.workspaceRoot, ctx.signal, TIMEOUT_MS, OUTPUT_CAP);
  },
};

export function runShellCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number, outputCap: number): Promise<ToolResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, content: "Command aborted before launch" });
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32" });
      let out = "";
      let err = "";
      let settled = false;
      let stopping = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };

      const stop = (reason: string) => {
        if (settled || stopping) return;
        stopping = true;
        clearTimeout(timeout);
        timeout = setTimeout(() => finish({ ok: false, content: `${reason}; process cleanup could not be confirmed within 5 seconds.` }), 5_000);
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5_000,
          });
          killer.on("error", (error: Error) => {
            child.kill();
            finish({ ok: false, content: `${reason}; process-tree cleanup failed: ${error.message}` });
          });
          killer.on("close", (code: number | null) => {
            finish({ ok: false, content: code === 0
              ? `${reason}; process tree terminated.`
              : `${reason}; process-tree cleanup failed (taskkill exit ${code}); termination is unconfirmed.` });
          });
        } else {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill();
            finish({ ok: false, content: `${reason}; process-group termination requested.` });
          } catch (error) {
            finish({ ok: false, content: `${reason}; process-group cleanup failed: ${(error as Error).message}` });
          }
        }
      };
      const onAbort = () => stop("Command aborted");

      child.stdout.on("data", (d: Buffer) => {
        if (out.length < outputCap) out += d.toString().slice(0, outputCap - out.length);
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < outputCap) err += d.toString().slice(0, outputCap - err.length);
      });
      child.on("error", (e: Error) => finish({ ok: false, content: e.message }));
      child.on("close", (code: number | null) => {
        if (stopping) return;
        const body = [out.trim(), err.trim() ? `[stderr]\n${err.trim()}` : ""]
          .filter(Boolean)
          .join("\n");
        finish({ ok: code === 0, content: body || `(exited with code ${code})` });
      });
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => stop(`Command timed out after ${timeoutMs / 1000} seconds`), timeoutMs);
      if (signal.aborted) onAbort();
    });
}
