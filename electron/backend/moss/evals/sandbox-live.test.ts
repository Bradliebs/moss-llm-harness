import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DockerEvalSandboxBackend } from "./sandbox-backend";
import { createSandboxTools } from "./sandbox-tools";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe.runIf(process.env.MOSS_EVAL_SANDBOX_LIVE === "1")("live Linux container containment", () => {
  let backend: DockerEvalSandboxBackend;
  beforeAll(() => {
    backend = new DockerEvalSandboxBackend({ image: process.env.MOSS_EVAL_SANDBOX_IMAGE ?? "", memoryMb: 256, cpus: 0.5, pidsLimit: 32 });
    expect(execFileSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8", timeout: 15_000 }).trim()).toBe("linux");
    execFileSync("docker", ["image", "inspect", process.env.MOSS_EVAL_SANDBOX_IMAGE!], { timeout: 15_000, stdio: "ignore" });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "moss-live-sandbox-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    writeFileSync(join(root, "canary.txt"), "unchanged");
    return { root, workspaceRoot, signal: new AbortController().signal };
  }

  it("permits workspace output but blocks parent writes and host-canary access through links", async () => {
    const request = fixture();
    const result = await backend.run({ ...request, command: "echo safe > answer.txt; echo changed > ../canary.txt" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(request.workspaceRoot, "answer.txt"), "utf8").trim()).toBe("safe");
    expect(readFileSync(join(request.root, "canary.txt"), "utf8")).toBe("unchanged");
    const tool = { name: "run_command", description: "fixture", parameters: {}, execute: async () => { throw new Error("host must not run"); } };
    const adapted = createSandboxTools([tool], backend, request.workspaceRoot);
    const rejection: unknown = await adapted.tools[0].execute({ command: "ln -s ../canary.txt escape; cat escape" }, request)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    if (process.platform === "win32" && rejection instanceof Error && "code" in rejection && rejection.code === "EACCES") {
      expect(rejection).toMatchObject({ code: "EACCES", syscall: "lstat", path: join(request.workspaceRoot, "escape") });
    } else {
      expect(rejection).toMatchObject({ message: "Sandbox workspace contains a link or special file" });
    }
    await expect(adapted.tools[0].execute({ command: "echo unsafe > after-rejection.txt" }, request)).rejects.toBe(rejection);
    expect(existsSync(join(request.workspaceRoot, "after-rejection.txt"))).toBe(false);
    expect(readFileSync(join(request.root, "canary.txt"), "utf8")).toBe("unchanged");
  }, 60_000);

  it("bounds output and applies cgroup memory and process limits", async () => {
    const request = fixture();
    const result = await backend.run({ ...request, command: `node -e 'process.stdout.write("x".repeat(100000))'` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(8000);
    const limits = await backend.run({ ...request, command: "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max" });
    expect(limits.exitCode).toBe(0);
    expect(limits.stdout).toContain("268435456");
    expect(limits.stdout).toContain("32");
    expect(limits.stdout).toContain("50000 100000");
  }, 60_000);

  it("enforces workspace capacity during writes and mounts host input read-only", async () => {
    const request = fixture();
    writeFileSync(join(request.workspaceRoot, "input.txt"), "unchanged");
    const result = await backend.run({ ...request, command: `node -e 'const fs=require("fs");let full=false;try{const fd=fs.openSync("large.bin","w");try{for(let index=0;index<64;index++)fs.writeSync(fd,Buffer.alloc(1024*1024));}finally{fs.closeSync(fd);}}catch(error){if(error.code!=="ENOSPC")throw error;full=true;}fs.rmSync("large.bin");if(!full)throw Error("quota not enforced");try{fs.writeFileSync("/input/input.txt","changed");throw Error("input writable");}catch(error){if(error.code!=="EROFS"&&error.code!=="EACCES")throw error;}process.stdout.write("quota enforced");'` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("quota enforced");
    expect(readFileSync(join(request.workspaceRoot, "input.txt"), "utf8")).toBe("unchanged");
    expect(existsSync(join(request.workspaceRoot, "large.bin"))).toBe(false);
  }, 60_000);

  it("disables external networking and removes a timed-out container", async () => {
    const request = fixture();
    const network = await backend.run({ ...request, command: `node -e 'const interfaces=Object.values(require("os").networkInterfaces()).flat();process.exit(interfaces.every(address=>address.internal)?0:1)'` });
    expect(network.exitCode).toBe(0);
    const result = await backend.run({ ...request, command: `node -e 'setInterval(()=>{},1000)'`, timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    const containers = execFileSync("docker", ["ps", "-aq", "--filter", `volume=${request.workspaceRoot}`], { encoding: "utf8", timeout: 15_000 });
    expect(containers.trim()).toBe("");
  }, 60_000);
});