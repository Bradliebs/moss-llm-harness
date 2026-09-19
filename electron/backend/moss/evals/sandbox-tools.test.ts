import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxTools } from "./sandbox-tools";
import { createTurnEvalExecutor } from "./turn-eval-executor";
import type { EvalCase } from "../../../../common/evals";
import type { ProviderStreamEvent } from "../providers/types";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moss-sandbox-tools-"));
  roots.push(root);
  const host = vi.fn(async () => ({ ok: true, content: "host" }));
  const tool = { name: "run_command", description: "command", parameters: {}, execute: host };
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "container", stderr: "", timedOut: false }));
  const backend = { kind: "docker" as const, run };
  return { root, host, tool, backend };
}

describe("sandbox turn tools", () => {
  it.each(["git_status", "delegate", "custom_code", "run_command"])("rejects unconfigured %s before a provider call", async (name) => {
    const { root, tool, host } = fixture();
    const streamChat = vi.fn(async function* (): AsyncIterable<ProviderStreamEvent> { yield { type: "text-delta", text: "unexpected" }; });
    const executor = createTurnEvalExecutor({ model: "fixture", workspaceRoot: () => root,
      toolRegistry: new Map([[name, { ...tool, name }]]),
      provider: { kind: "deterministic", listModels: async () => [], streamChat },
    });
    const testCase: EvalCase = { schemaVersion: 1, id: "sandbox", profile: "coding", difficulty: "smoke", allowedCapabilities: [name],
      task: { objective: "run fixture", acceptanceCriteria: [], constraints: [], assumptions: [] }, checks: [] };
    await expect(executor(testCase, 0)).rejects.toThrow(name === "run_command" ? "digest" : "no sandbox adapter");
    expect(streamChat).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
  });

  it("routes model commands and verification through the backend, never the host tool", async () => {
    const { root, host, tool, backend } = fixture();
    let round = 0;
    const executor = createTurnEvalExecutor({ model: "fixture", workspaceRoot: () => root, toolRegistry: new Map([[tool.name, tool]]),
      sandboxBackend: backend, requestApproval: async () => ({ approved: true }),
      messages: () => [{ role: "user", content: "run fixture" }],
      provider: { kind: "deterministic", listModels: async () => [], async *streamChat(): AsyncIterable<ProviderStreamEvent> {
        if (round++ === 0) yield { type: "tool-call", toolCall: { id: "command", name: "run_command", arguments: '{"command":"echo container"}' } };
        else yield { type: "text-delta", text: "done" };
      } },
    });
    const testCase: EvalCase = { schemaVersion: 1, id: "sandbox", profile: "coding", difficulty: "smoke", allowedCapabilities: ["run_command"],
      task: { objective: "run fixture", acceptanceCriteria: [], constraints: [], assumptions: [] }, checks: [] };
    await executor(testCase, 0);
    expect(backend.run).toHaveBeenCalledWith(expect.objectContaining({ command: "echo container", workspaceRoot: root, allowNetwork: false }));
    expect(host).not.toHaveBeenCalled();
    const adapted = createSandboxTools([tool], backend, root);
    expect((await adapted.verify(["echo verified"], root, new AbortController().signal)).ok).toBe(true);
    expect(backend.run).toHaveBeenLastCalledWith(expect.objectContaining({ command: "echo verified" }));
  });

  it("blocks unsupported host tools before execution", () => {
    const { root, tool, backend } = fixture();
    expect(() => createSandboxTools([{ ...tool, name: "git_status" }], backend, root)).toThrow("no sandbox adapter");
  });

  it("blocks host access after a container creates a link and keeps the failure sticky", async () => {
    const { root, tool, host, backend } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "moss-outside-"));
    roots.push(outside);
    backend.run.mockImplementationOnce(async () => {
      symlinkSync(outside, join(root, "escape"), "junction");
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const adapted = createSandboxTools([tool, { ...tool, name: "read_file" }], backend, root);
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(adapted.tools[0].execute({ command: "fixture" }, context)).rejects.toThrow("link");
    unlinkSync(join(root, "escape"));
    await expect(adapted.tools[1].execute({ path: "escape/secret" }, context)).rejects.toThrow("link");
    expect(host).not.toHaveBeenCalled();
    expect(() => adapted.assertHealthy()).toThrow("link");
  });

  it("rejects a linked workspace root", () => {
    const { root, tool, backend } = fixture();
    mkdirSync(join(root, "target"));
    symlinkSync(join(root, "target"), join(root, "linked"), "junction");
    expect(() => createSandboxTools([tool], backend, join(root, "linked"))).toThrow("root");
  });
});