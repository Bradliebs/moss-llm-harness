// electron/backend/moss/tools/shell-tool.ts
//
// Runs a shell command inside the workspace. This is the highest-risk tool. The
// permission policy (see permission.ts) classifies each command: provably
// read-only ones run unprompted, destructive ones always ask, and the rest
// follow auto-approve and the untrusted-content gate.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { Tool, ToolContext, ToolResult } from "./types";

const OUTPUT_CAP = 20_000;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

/** The shell `spawn(..., { shell: true })` uses, named so the model writes
 *  commands for it rather than assuming a POSIX shell. */
export const SHELL_NAME = process.platform === "win32"
  ? "Windows cmd.exe (not PowerShell or bash: use dir, type, findstr, del, and set; && chains commands)"
  : "/bin/sh";

/** The deadline a run_command call asked for: timeoutSeconds, default 60, at most 600. */
export function commandTimeoutMs(args: Record<string, unknown>): number {
  const requested = Number(args.timeoutSeconds);
  const seconds = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(requested)) : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1_000;
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    `Run a foreground shell command with its working directory set to the workspace root. The shell is ${SHELL_NAME}. Returns stdout, then stderr, and the exit code when it is not 0; long output keeps its start and end. Commands stop after timeoutSeconds (default 60, at most 600); do not use this tool to keep servers or watchers running.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutSeconds: { type: "number", description: "Seconds before the command is stopped (default 60, max 600). Raise it for a full test suite or build." },
    },
    required: ["command"],
  },
  // The runner's backstop; the command's own deadline comes from timeoutSeconds.
  timeoutMs: (MAX_TIMEOUT_SECONDS + 10) * 1_000,
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? "").trim();
    if (!command) return Promise.resolve({ ok: false, content: "command is required" });
    if (!ctx.workspaceRoot) {
      return Promise.resolve({ ok: false, content: "No workspace folder selected" });
    }
    if (ctx.signal.aborted) {
      return Promise.resolve({ ok: false, content: "Command aborted before launch" });
    }

    return runShellCommand(command, ctx.workspaceRoot, ctx.signal, commandTimeoutMs(args), OUTPUT_CAP);
  },
};

/** Keeps the first and last characters of a stream once it outgrows `cap`:
 *  test runners and compilers print their summary and failures at the end. */
class HeadTail {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(private readonly cap: number) {}
  push(text: string): void {
    this.total += text.length;
    const headCap = Math.floor(this.cap * 0.4);
    if (this.head.length < headCap) {
      const room = headCap - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail = (this.tail + text).slice(-(this.cap - headCap));
  }
  toString(): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return omitted > 0 ? `${this.head}\n...[${omitted} characters omitted]...\n${this.tail}` : this.head + this.tail;
  }
}

export function runShellCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number, outputCap: number): Promise<ToolResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, content: "Command aborted before launch" });
    return new Promise<ToolResult>((resolvePromise) => {
      // stdin is closed, so a command that waits for input (a confirmation, an
      // editor, a password) fails at once instead of hanging until the timeout.
      // Python is told to write UTF-8 so a printed symbol cannot crash a script.
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      const out = new HeadTail(outputCap);
      const err = new HeadTail(outputCap);
      // A decoder per stream keeps a multibyte character that spans two chunks intact.
      const outText = new StringDecoder("utf8");
      const errText = new StringDecoder("utf8");
      const captured = (): string => [out.toString().trim(), err.toString().trim() ? `[stderr]\n${err.toString().trim()}` : ""].filter(Boolean).join("\n");
      /** What the model sees when a command is stopped: its output so far, then why. */
      const stopped = (message: string): string => (captured() ? `${captured()}\n[${message}]` : message);
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
        timeout = setTimeout(() => finish({ ok: false, content: stopped(`${reason}; process cleanup could not be confirmed within 5 seconds.`) }), 5_000);
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5_000,
          });
          killer.on("error", (error: Error) => {
            child.kill();
            finish({ ok: false, content: stopped(`${reason}; process-tree cleanup failed: ${error.message}`) });
          });
          killer.on("close", (code: number | null) => {
            finish({ ok: false, content: stopped(code === 0
              ? `${reason}; process tree terminated.`
              : `${reason}; process-tree cleanup failed (taskkill exit ${code}); termination is unconfirmed.`) });
          });
        } else {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill();
            finish({ ok: false, content: stopped(`${reason}; process-group termination requested.`) });
          } catch (error) {
            finish({ ok: false, content: stopped(`${reason}; process-group cleanup failed: ${(error as Error).message}`) });
          }
        }
      };
      const onAbort = () => stop("Command aborted");

      child.stdout.on("data", (d: Buffer) => out.push(outText.write(d)));
      child.stderr.on("data", (d: Buffer) => err.push(errText.write(d)));
      child.on("error", (e: Error) => finish({ ok: false, content: e.message }));
      child.on("close", (code: number | null) => {
        if (stopping) return;
        out.push(outText.end());
        err.push(errText.end());
        const body = captured();
        // The model sees only this text, so a failure must say so.
        if (code === 0) finish({ ok: true, content: body || "(exited with code 0)" });
        else finish({ ok: false, content: body ? `${body}\n[exit code ${code}]` : `(exited with code ${code})` });
      });
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => stop(`Command timed out after ${timeoutMs / 1000} seconds`), timeoutMs);
      if (signal.aborted) onAbort();
    });
}
