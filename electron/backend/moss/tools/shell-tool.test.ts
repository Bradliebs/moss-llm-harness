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