import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tool } from "../tools/types";
import type { runVerify } from "../verify/verifier";
import type { EvalSandboxBackend } from "./sandbox-backend";

const HOST_TOOLS = new Set(["read_file", "write_file", "edit_file", "move_file", "list_dir", "glob_files", "search_files", "plan"]);

export function validateTurnEvalCapabilities(capabilities: readonly string[], trustedCapabilities: readonly string[] = []): void {
  for (const capability of capabilities) {
    if (capability !== "run_command" && !HOST_TOOLS.has(capability) && !trustedCapabilities.includes(capability)) {
      throw new Error(`Tool '${capability}' has no sandbox adapter`);
    }
  }
}

export function assertSandboxWorkspace(root: string): void {
  const absolute = resolve(root);
  const canonical = realpathSync(absolute);
  const samePath = process.platform === "win32" ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute;
  if (!samePath || lstatSync(absolute).isSymbolicLink()) {
    throw new Error("Sandbox workspace root must not traverse links");
  }
  const pending = [absolute];
  let visited = 0;
  while (pending.length) {
    if (++visited > 20_000) throw new Error("Sandbox workspace exceeds inspection limit");
    const path = pending.pop()!;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
      throw new Error("Sandbox workspace contains a link or special file");
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) pending.push(join(path, entry));
    }
  }
}

export function createSandboxTools(tools: Tool[], backend: EvalSandboxBackend, root: string, allowNetwork = false, trustedCapabilities: readonly string[] = []) {
  validateTurnEvalCapabilities(tools.map((tool) => tool.name), trustedCapabilities);
  let failure: unknown;
  const assertHealthy = (): void => {
    if (failure) throw failure;
    try { assertSandboxWorkspace(root); } catch (error) { failure = error; throw error; }
  };
  const run = async (command: string, signal: AbortSignal, timeoutMs?: number) => {
    assertHealthy();
    try {
      const result = await backend.run({ workspaceRoot: root, command, signal, timeoutMs, allowNetwork });
      assertHealthy();
      return result;
    } catch (error) { failure = error; throw error; }
  };
  assertHealthy();
  const adapted = tools.map((tool): Tool => {
    return {
      ...tool,
      ...(tool.name === "run_command" ? { description: "Run a Linux shell command in /workspace inside the isolated evaluation container." } : {}),
      execute: async (args, context) => {
        assertHealthy();
        if (tool.name !== "run_command") return tool.execute(args, context);
        if (typeof args.command !== "string" || !args.command.trim()) return { ok: false, content: "command is required" };
        const result = await run(args.command, context.signal, tool.timeoutMs);
        return { ok: result.exitCode === 0 && !result.timedOut && !context.signal.aborted,
          content: result.timedOut ? "Sandbox command timed out" : [result.stdout, result.stderr].filter(Boolean).join("\n") || `Exited with code ${result.exitCode}` };
      },
    };
  });
  const verify: typeof runVerify = async (commands, _cwd, signal, options) => {
    const results = [];
    for (const command of commands.map((value) => value.trim()).filter(Boolean)) {
      if (signal.aborted) return { ok: false, results };
      const result = await run(command, signal, options?.commandTimeoutMs);
      const checked = { command, ok: result.exitCode === 0 && !result.timedOut && !signal.aborted, output: [result.stdout, result.stderr].join("\n") };
      results.push(checked);
      if (!checked.ok) break;
    }
    return { ok: !signal.aborted && results.every((result) => result.ok), results };
  };
  return { tools: adapted, verify, assertHealthy };
}