import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommandTool } from "./shell-tool";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function childProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

let child: ReturnType<typeof childProcess>;
let killer: ReturnType<typeof childProcess>;

beforeEach(() => {
  vi.useFakeTimers();
  child = childProcess();
  killer = childProcess();
  vi.mocked(spawn)
    .mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    .mockReturnValue(killer as unknown as ReturnType<typeof spawn>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("run_command cancellation", () => {
  it("settles on abort even when the shell never emits close", async () => {
    const controller = new AbortController();
    const result = vi.fn();
    void runCommandTool.execute({ command: "server" }, {
      workspaceRoot: process.cwd(), signal: controller.signal,
    }).then(result);

    controller.abort();
    if (process.platform === "win32") killer.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringMatching(/abort/i) }));
    if (process.platform === "win32") {
      expect(spawn).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
      expect(child.kill).not.toHaveBeenCalled();
    }
    child.emit("close", 0);
    expect(result).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spawn a command for an already aborted turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = vi.fn();
    void runCommandTool.execute({ command: "server" }, {
      workspaceRoot: process.cwd(), signal: controller.signal,
    }).then(result);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringMatching(/abort/i) }));
  });

  it("enforces its timeout even without an external executor", async () => {
    const result = vi.fn();
    void runCommandTool.execute({ command: "server" }, {
      workspaceRoot: process.cwd(), signal: new AbortController().signal,
    }).then(result);
    await vi.advanceTimersByTimeAsync(60_000);
    if (process.platform === "win32") killer.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringMatching(/timed out/i) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves output and clears cancellation resources on normal completion", async () => {
    const controller = new AbortController();
    const pending = runCommandTool.execute({ command: "echo hello" }, {
      workspaceRoot: process.cwd(), signal: controller.signal,
    });
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.stderr.emit("data", Buffer.from("warning\n"));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true, content: "hello\n[stderr]\nwarning" });
    controller.abort();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the end of long output, where test runners print their summary", async () => {
    const pending = runCommandTool.execute({ command: "npm test" }, { workspaceRoot: process.cwd(), signal: new AbortController().signal });
    for (let i = 0; i < 3_000; i++) child.stdout.emit("data", Buffer.from(`ok test ${i}\n`));
    child.stdout.emit("data", Buffer.from("Tests: 1 failed, 2999 passed\n"));
    child.emit("close", 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.content.startsWith("ok test 0")).toBe(true);
    expect(result.content).toMatch(/\.\.\.\[\d+ characters omitted\]\.\.\./);
    expect(result.content).toContain("Tests: 1 failed, 2999 passed");
    expect(result.content.endsWith("[exit code 1]")).toBe(true);
    expect(result.content.length).toBeLessThan(20_200);
  });

  it("reports a nonzero exit code even when the command printed output", async () => {
    const pending = runCommandTool.execute({ command: "node x.js" }, { workspaceRoot: process.cwd(), signal: new AbortController().signal });
    child.stdout.emit("data", Buffer.from("done\n"));
    child.emit("close", 2);
    await expect(pending).resolves.toEqual({ ok: false, content: "done\n[exit code 2]" });
  });

  it("honours a longer requested time limit, up to 600 seconds", async () => {
    const result = vi.fn();
    void runCommandTool.execute({ command: "npm test", timeoutSeconds: 120 }, { workspaceRoot: process.cwd(), signal: new AbortController().signal }).then(result);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    if (process.platform === "win32") killer.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ ok: false, content: expect.stringMatching(/timed out after 120 seconds/i) }));
  });

  it("keeps the output a command printed before it timed out", async () => {
    const result = vi.fn();
    void runCommandTool.execute({ command: "npm test" }, { workspaceRoot: process.cwd(), signal: new AbortController().signal }).then(result);
    child.stdout.emit("data", Buffer.from("Running 40 tests\n"));
    child.stderr.emit("data", Buffer.from("test 7 is slow\n"));
    await vi.advanceTimersByTimeAsync(60_000);
    if (process.platform === "win32") killer.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    const content = (result.mock.calls[0][0] as { content: string }).content;
    expect(content).toMatch(/^Running 40 tests\n\[stderr\]\ntest 7 is slow\n\[Command timed out after 60 seconds/);
  });

  it("closes stdin, keeps characters split across chunks, and runs Python in UTF-8", async () => {
    const pending = runCommandTool.execute({ command: "echo" }, { workspaceRoot: process.cwd(), signal: new AbortController().signal });
    const euro = Buffer.from("cost: €5\n");
    child.stdout.emit("data", euro.subarray(0, 8));
    child.stdout.emit("data", euro.subarray(8));
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ ok: true, content: "cost: €5" });
    const options = vi.mocked(spawn).mock.calls[0][1] as unknown as { stdio: unknown[]; env: Record<string, string> };
    expect(options.stdio[0]).toBe("ignore");
    expect(options.env).toMatchObject({ PYTHONUTF8: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  it("names the shell in its description", () => {
    expect(runCommandTool.description).toContain(process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  });

  it.skipIf(process.platform !== "win32")("reports cleanup failure instead of claiming termination", async () => {
    const controller = new AbortController();
    const pending = runCommandTool.execute({ command: "server" }, { workspaceRoot: process.cwd(), signal: controller.signal });
    controller.abort();
    child.emit("close", 0);
    killer.emit("close", 1);
    await expect(pending).resolves.toMatchObject({ ok: false, content: expect.stringContaining("unconfirmed") });
  });

  it.skipIf(process.platform !== "win32")("bounds a stuck cleanup process", async () => {
    const controller = new AbortController();
    const pending = runCommandTool.execute({ command: "server" }, { workspaceRoot: process.cwd(), signal: controller.signal });
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ ok: false, content: expect.stringContaining("could not be confirmed") });
    expect(vi.getTimerCount()).toBe(0);
  });
});