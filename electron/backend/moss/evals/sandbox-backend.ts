import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { applySandboxSnapshot, SANDBOX_SUPERVISOR, SNAPSHOT_OUTPUT_BYTES, WORKSPACE_BYTES } from "./sandbox-snapshot";

const OUTPUT_CAP = 8_000;

export class SandboxCleanupError extends Error {
  constructor(name: string) {
    super(`Docker sandbox cleanup failed for ${name}; check the engine before continuing`);
    this.name = "SandboxCleanupError";
  }
}

export interface SandboxCommandRequest {
  workspaceRoot: string;
  command: string;
  signal: AbortSignal;
  timeoutMs?: number;
  allowNetwork?: boolean;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface EvalSandboxBackend {
  readonly kind: "docker";
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
}

export type ContainerProcessRunner = (
  executable: string,
  args: readonly string[],
  request: Pick<SandboxCommandRequest, "signal" | "timeoutMs"> & { outputLimit?: number },
) => Promise<SandboxCommandResult>;

export interface DockerSandboxOptions {
  image: string;
  dockerExecutable?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  processRunner?: ContainerProcessRunner;
}

export class DockerEvalSandboxBackend implements EvalSandboxBackend {
  readonly kind = "docker" as const;
  private readonly dockerExecutable: string;
  private readonly processRunner: ContainerProcessRunner;

  constructor(private readonly options: DockerSandboxOptions) {
    validateOptions(options);
    this.dockerExecutable = options.dockerExecutable ?? "docker";
    this.processRunner = options.processRunner ?? runContainerProcess;
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (!request.command.trim()) throw new Error("Sandbox command is required");
    request.signal.throwIfAborted();
    if (!Number.isSafeInteger(request.timeoutMs ?? 180_000) || (request.timeoutMs ?? 180_000) < 1) {
      throw new Error("Sandbox timeout must be a positive integer");
    }
    const name = `moss-eval-${randomUUID()}`;
    const args = buildDockerArgs(this.options, request);
    args[0] = "create";
    args.splice(1, 0, "--name", name);
    try {
      const created = await this.processRunner(this.dockerExecutable, args, { ...request, timeoutMs: 30_000 })
        .catch(() => { throw new SandboxCleanupError(name); });
      if (created.timedOut || created.exitCode === null || request.signal.aborted) throw new SandboxCleanupError(name);
      if (created.exitCode !== 0) throw new Error("Docker sandbox creation failed");
      request.signal.throwIfAborted();
      const result = await this.processRunner(this.dockerExecutable, ["start", "--attach", name], { ...request, outputLimit: SNAPSHOT_OUTPUT_BYTES });
      if (result.exitCode === 125) throw new Error("Docker sandbox engine failed during execution");
      if (result.timedOut || request.signal.aborted) return { ...result, stdout: "", stderr: "" };
      if (result.exitCode !== 0) throw new Error("Docker sandbox supervisor failed during execution");
      const snapshot: unknown = JSON.parse(result.stdout);
      if (!snapshot || typeof snapshot !== "object" || !("schemaVersion" in snapshot) || snapshot.schemaVersion !== 1) {
        throw new Error("Invalid sandbox supervisor response");
      }
      if ("error" in snapshot && typeof snapshot.error === "string") throw new Error(snapshot.error.slice(0, OUTPUT_CAP));
      if (!("exitCode" in snapshot) || (snapshot.exitCode !== null && !Number.isInteger(snapshot.exitCode))
        || !("stdout" in snapshot) || typeof snapshot.stdout !== "string" || snapshot.stdout.length > OUTPUT_CAP
        || !("stderr" in snapshot) || typeof snapshot.stderr !== "string" || snapshot.stderr.length > OUTPUT_CAP
        || !("entries" in snapshot)) throw new Error("Invalid sandbox supervisor response");
      applySandboxSnapshot(request.workspaceRoot, snapshot.entries);
      return { exitCode: snapshot.exitCode as number | null, stdout: snapshot.stdout, stderr: snapshot.stderr, timedOut: false };
    } finally {
      const cleanup = await this.processRunner(this.dockerExecutable, ["rm", "--force", name], {
        signal: new AbortController().signal, timeoutMs: 30_000,
      }).catch(() => { throw new SandboxCleanupError(name); });
      if (cleanup.timedOut || (cleanup.exitCode !== 0 && !cleanup.stderr.includes("No such container"))) {
        throw new SandboxCleanupError(name);
      }
    }
  }
}

export function buildDockerArgs(options: DockerSandboxOptions, request: SandboxCommandRequest): string[] {
  validateOptions(options);
  const workspaceRoot = resolve(request.workspaceRoot);
  if (/[,\r\n"]/.test(workspaceRoot)) throw new Error("Sandbox workspace path contains unsupported mount characters");
  return [
    "run",
    "--rm",
    "--pull", "never",
    "--init",
    "--log-driver", "none",
    "--network", request.allowNetwork === true ? "bridge" : "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(options.pidsLimit ?? 128),
    "--memory", `${options.memoryMb ?? 512}m`,
    "--memory-swap", `${options.memoryMb ?? 512}m`,
    "--cpus", String(options.cpus ?? 1),
    "--mount", `type=bind,source=${workspaceRoot},target=/input,readonly,bind-recursive=disabled`,
    "--tmpfs", `/workspace:rw,exec,nosuid,nodev,size=${WORKSPACE_BYTES},nr_inodes=20001`,
    "--workdir", "/workspace",
    "--entrypoint", "node",
    options.image,
    "-e", SANDBOX_SUPERVISOR, "--", request.command,
  ];
}

function validateOptions(options: DockerSandboxOptions): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(options.image)) {
    throw new Error("Docker sandbox image must be pinned by sha256 digest");
  }
  if (!Number.isSafeInteger(options.memoryMb ?? 512) || (options.memoryMb ?? 512) < 64) {
    throw new Error("Docker sandbox memoryMb must be an integer of at least 64");
  }
  if (!Number.isFinite(options.cpus ?? 1) || (options.cpus ?? 1) <= 0) throw new Error("Docker sandbox cpus must be positive and finite");
  if (!Number.isSafeInteger(options.pidsLimit ?? 128) || (options.pidsLimit ?? 128) < 1) {
    throw new Error("Docker sandbox pidsLimit must be a positive integer");
  }
}

async function runContainerProcess(
  executable: string,
  args: readonly string[],
  request: Pick<SandboxCommandRequest, "signal" | "timeoutMs"> & { outputLimit?: number },
): Promise<SandboxCommandResult> {
  request.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const outputLimit = request.outputLimit ?? OUTPUT_CAP;
    let timedOut = false;
    let settled = false;
    const finish = (result: SandboxCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const onAbort = (): void => { child.kill("SIGKILL"); };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs ?? 180_000);
    if (request.signal.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(0, outputLimit); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, OUTPUT_CAP); });
    child.on("error", (error) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error(`Docker sandbox failed to start: ${error.message}`));
    });
    child.on("close", (exitCode) => finish({
      exitCode,
      stdout: stdout.slice(0, outputLimit),
      stderr: stderr.slice(0, OUTPUT_CAP),
      timedOut,
    }));
  });
}
