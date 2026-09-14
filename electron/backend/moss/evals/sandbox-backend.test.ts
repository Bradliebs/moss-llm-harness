import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDockerArgs, DockerEvalSandboxBackend, SandboxCleanupError } from "./sandbox-backend";

const image = `node@sha256:${"a".repeat(64)}`;

const request = {
  workspaceRoot: "C:\\work\\fixture",
  command: "npm test",
  signal: new AbortController().signal,
};

describe("DockerEvalSandboxBackend", () => {
  it("builds a networkless resource-bounded container invocation", () => {
    const args = buildDockerArgs({ image, memoryMb: 256, cpus: 0.5, pidsLimit: 32 }, request);

    expect(args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "32",
      "--memory", "256m",
      "--cpus", "0.5",
      "--workdir", "/workspace",
      image,
      "--entrypoint", "node", "-e", "--", "npm test",
    ]));
    expect(args.join(" ")).toContain("target=/input,readonly,bind-recursive=disabled");
    expect(args).toContain("/workspace:rw,exec,nosuid,nodev,size=33554432,nr_inodes=20001");
  });

  it("uses an argument-vector process runner without a host shell", async () => {
    const processRunner = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, exitCode: 0, stdout: "ok", stderr: "", entries: [] }), stderr: "", timedOut: false }));
    const backend = new DockerEvalSandboxBackend({ image, processRunner });
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-sandbox-backend-"));
    try {
      await expect(backend.run({ ...request, workspaceRoot })).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    } finally { rmSync(workspaceRoot, { recursive: true, force: true }); }
    expect(processRunner).toHaveBeenCalledWith("docker", expect.arrayContaining(["create", "--network", "none"]), { ...request, workspaceRoot, timeoutMs: 30_000 });
    expect(processRunner.mock.calls).toHaveLength(3);
    expect(processRunner).toHaveBeenLastCalledWith("docker", ["rm", "--force", expect.stringMatching(/^moss-eval-/)], expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("cleans up timed out commands using a fresh cancellation signal", async () => {
    const processRunner = vi.fn().mockResolvedValueOnce({ exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ exitCode: null, timedOut: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, timedOut: false });
    const backend = new DockerEvalSandboxBackend({ image, processRunner });
    await expect(backend.run(request)).resolves.toMatchObject({ timedOut: true });
    expect(processRunner.mock.calls[2][2].signal).not.toBe(request.signal);
  });

  it("fails loudly when cleanup fails and never starts after failed creation", async () => {
    const processRunner = vi.fn().mockResolvedValueOnce({ exitCode: 125, timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, stderr: "daemon unavailable" });
    await expect(new DockerEvalSandboxBackend({ image, processRunner }).run(request)).rejects.toThrow("cleanup failed");
    expect(processRunner.mock.calls.some((call) => call[1][0] === "start")).toBe(false);
  });

  it("retains uncertainty after interrupted creation even when removal finds no container", async () => {
    const processRunner = vi.fn().mockResolvedValueOnce({ exitCode: null, timedOut: true })
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, stderr: "No such container" });
    await expect(new DockerEvalSandboxBackend({ image, processRunner }).run(request)).rejects.toBeInstanceOf(SandboxCleanupError);
    expect(processRunner.mock.calls.some((call) => call[1][0] === "start")).toBe(false);
    expect(processRunner).toHaveBeenLastCalledWith("docker", ["rm", "--force", expect.any(String)], expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("does not spawn for pre-aborted calls and enables bridge networking only explicitly", async () => {
    const processRunner = vi.fn();
    await expect(new DockerEvalSandboxBackend({ image, processRunner }).run({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(processRunner).not.toHaveBeenCalled();
    expect(buildDockerArgs({ image }, { ...request, allowNetwork: true })).toContain("bridge");
    expect(() => buildDockerArgs({ image }, { ...request, workspaceRoot: "unsafe,path" })).toThrow("mount characters");
  });

  it("rejects unsafe unbounded option values", () => {
    expect(() => new DockerEvalSandboxBackend({ image, memoryMb: 32 })).toThrow("memoryMb");
    expect(() => new DockerEvalSandboxBackend({ image: "", cpus: 1 })).toThrow("image");
    expect(() => new DockerEvalSandboxBackend({ image: "node:22-alpine" })).toThrow("digest");
    expect(() => new DockerEvalSandboxBackend({ image, memoryMb: NaN })).toThrow("memoryMb");
    expect(() => new DockerEvalSandboxBackend({ image, cpus: Infinity })).toThrow("cpus");
  });
});
