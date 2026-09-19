import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { runCommandTool } from "./shell-tool";
import { runVerify } from "../verify/verifier";

const executeFile = promisify(execFile);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

it.skipIf(process.platform !== "win32").each(["shell", "verification-abort", "verification-timeout"])("%s terminates real Windows descendants", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "moss-shell-cancel-"));
  const controller = new AbortController();
  let processIds: number[] = [];
  const result = vi.fn();
  try {
    await writeFile(join(root, "server.cjs"), [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
      'writeFileSync("pids.json", JSON.stringify([process.pid, descendant.pid]));',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const command = `"${process.execPath}" server.cjs`;
    if (mode === "shell") {
      void runCommandTool.execute({ command }, { workspaceRoot: root, signal: controller.signal }).then(result);
    } else {
      void runVerify([command], root, controller.signal, { commandTimeoutMs: mode === "verification-timeout" ? 1_000 : 10_000 })
        .then((verification) => result({ ok: verification.ok, content: verification.results[0]?.output }));
    }

    await vi.waitFor(async () => {
      processIds = JSON.parse(await readFile(join(root, "pids.json"), "utf8")) as number[];
      expect(processIds).toHaveLength(2);
      expect(processIds.every(isRunning)).toBe(true);
    }, { timeout: 5_000 });

    if (mode !== "verification-timeout") controller.abort();
    await vi.waitFor(() => {
      expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringMatching(/abort|timed out/i) }));
      expect(processIds.filter(isRunning)).toEqual([]);
    }, { timeout: 5_000 });
  } finally {
    controller.abort();
    for (const pid of processIds.filter(isRunning)) {
      await executeFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);