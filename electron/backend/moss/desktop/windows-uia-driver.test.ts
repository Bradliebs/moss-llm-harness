import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createWindowsUiaDriverFactory } from "./windows-uia-driver";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.skipIf(process.platform !== "win32")("closing a desktop session kills and awaits its active bridge", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { end: vi.fn() }, kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const driver = await createWindowsUiaDriverFactory()({ taskId: "test", sessionId: "session", processName: "notepad", windowTitle: "fixture" });
  const operation = driver.inspect();
  const rejected = expect(operation).rejects.toThrow("aborted");
  let closed = false;
  const closing = driver.close().then(() => { closed = true; });
  expect(child.kill).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(closed).toBe(false);
  child.emit("close", 0);
  await rejected;
  await closing;
  expect(closed).toBe(true);
  await expect(driver.inspect()).rejects.toThrow("closed");
  expect(spawn).toHaveBeenCalledOnce();
});