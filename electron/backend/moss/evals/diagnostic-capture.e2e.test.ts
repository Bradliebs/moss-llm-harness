import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { HarnessMatrixReport } from "../../../../common/evals";
import type { ChatProvider, ProviderStreamEvent } from "../providers/types";
import { runEvalCli, type HarnessEvalConfig } from "./eval-cli";
import { createTurnEvalExecutor } from "./turn-eval-executor";
import { HarnessDiagnosticArtifactStore } from "./diagnostic-artifact-store";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup(providerFails = false): { root: string; config: HarnessEvalConfig } {
  const root = mkdtempSync(join(tmpdir(), "moss-capture-e2e-"));
  roots.push(root);
  return { root, config: {
    cases: [{
      schemaVersion: 1, id: "capture", profile: "platform", difficulty: "smoke",
      task: { objective: "Complete the fixture", acceptanceCriteria: [{ id: "done", description: "Complete", mandatory: true }], constraints: [], assumptions: [] },
      allowedCapabilities: ["write_file"],
      checks: [{ id: "receipt", criterionId: "done", kind: "receipt", asserted: true }],
    }],
    targets: [{ schemaVersion: 1, id: "fixture", providerId: "fixture", providerKind: "deterministic", model: "fixture" }],
    variants: [{ schemaVersion: 1, id: "gated", description: "Gated fixture", autoApprove: false }],
    createExecutor: (_target, variant, workspaceRoot, context) => {
      let round = 0;
      const provider: ChatProvider = {
        kind: "deterministic", listModels: async () => ["fixture"],
        async *streamChat(): AsyncIterable<ProviderStreamEvent> {
          if (providerFails) throw new Error("fixture API failure Bearer abcdefghijklmnopqrstuvwxyz");
          if (round++ === 0) {
            yield { type: "tool-call", toolCall: { id: "fixture-call", name: "write_file", arguments: '{"password":"fixture-secret","path":"answer.txt"}' } };
          } else {
            yield { type: "text-delta", text: "Bearer abcdef" };
            yield { type: "text-delta", text: "ghijklmnopqrstuvwxyz" };
          }
        },
      };
      return createTurnEvalExecutor({
        provider, model: "fixture", variant, workspaceRoot: () => workspaceRoot,
        diagnostics: context?.diagnostics,
        ...(variant.verify?.enabled ? { sandboxBackend: { kind: "docker" as const, run: async () => ({ exitCode: 0, stdout: "verifier-fixture", stderr: "", timedOut: false }) } } : {}),
        messages: () => [{ role: "user", content: "private fixture prompt" }],
        requestApproval: async () => ({ approved: true, comment: "approval fixture comment" }),
        toolRegistry: new Map([["write_file", {
          name: "write_file", description: "Fixture write", parameters: { type: "object", properties: {} },
          execute: async () => ({ ok: true, content: '{"password":"result-secret","status":"private fixture result"}' }),
        }]]),
      });
    },
  } };
}

describe("local diagnostic capture", () => {
  it.each([false, true])("captures production data only with opt-in: %s", async (enabled) => {
    const { root, config } = setup();
    const output = join(root, "report.json");
    const diagnosticsDir = join(root, "private");
    await runEvalCli(["run", "fixture.cjs", output, ...(enabled ? ["--diagnostics-dir", diagnosticsDir] : [])], {
      loadConfig: () => config, io: { stdout: vi.fn(), stderr: vi.fn() },
    });
    const serialized = readFileSync(output, "utf8");
    const report = JSON.parse(serialized) as HarnessMatrixReport;
    expect(report.cells[0].result.success).toBe(true);
    expect(serialized).not.toContain("private fixture");
    expect(serialized).not.toContain("fixture-secret");
    expect(serialized).not.toContain("approval fixture comment");
    expect(existsSync(diagnosticsDir)).toBe(enabled);
    if (enabled) {
      const artifact = new HarnessDiagnosticArtifactStore(diagnosticsDir).read(report.cells[0].diagnostics!);
      const detail = JSON.stringify(artifact);
      expect(detail).toContain("private fixture prompt");
      expect(detail).toContain("private fixture result");
      expect(detail).toContain("approval fixture comment");
      expect(detail).not.toContain("fixture-secret");
      expect(detail).not.toContain("result-secret");
      expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(artifact.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["provider-request", "tool-call", "tool-result", "approval-response", "evaluation"]));
      const stdout = vi.fn();
      await runEvalCli(["inspect", output, "--diagnostics-dir", diagnosticsDir], { io: { stdout, stderr: vi.fn() } });
      expect(JSON.parse(stdout.mock.calls[0][0]).diagnostics).toEqual(artifact);
      const htmlPath = join(root, "inspection.html");
      await runEvalCli(["export", output, htmlPath, "--format", "html", "--diagnostics-dir", diagnosticsDir]);
      expect(readFileSync(htmlPath, "utf8")).toContain("Redacted Trajectory");
    } else expect(report.cells[0].diagnostics).toBeUndefined();
  });

  it("captures redacted provider errors", async () => {
    const { root, config } = setup(true);
    const output = join(root, "report.json");
    const diagnosticsDir = join(root, "private");
    await runEvalCli(["run", "fixture.cjs", output, "--diagnostics-dir", diagnosticsDir], {
      loadConfig: () => config, io: { stdout: vi.fn(), stderr: vi.fn() },
    });
    const report = JSON.parse(readFileSync(output, "utf8")) as HarnessMatrixReport;
    const artifact = new HarnessDiagnosticArtifactStore(diagnosticsDir).read(report.cells[0].diagnostics!);
    expect(artifact.events.some((event) => event.kind === "provider-error")).toBe(true);
    expect(JSON.stringify(artifact)).toContain("fixture API failure");
    expect(JSON.stringify(artifact)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("captures verifier details before the terminal tool-disabled provider request", async () => {
    const { root, config } = setup();
    config.variants[0].verify = { enabled: true, commands: ["echo verifier-fixture"], maxCycles: 1 };
    config.variants[0].maxRounds = 1;
    const output = join(root, "report.json");
    const diagnosticsDir = join(root, "private");
    await runEvalCli(["run", "fixture.cjs", output, "--diagnostics-dir", diagnosticsDir], {
      loadConfig: () => config, io: { stdout: vi.fn(), stderr: vi.fn() },
    });
    const serialized = readFileSync(output, "utf8");
    const report = JSON.parse(serialized) as HarnessMatrixReport;
    const artifact = new HarnessDiagnosticArtifactStore(diagnosticsDir).read(report.cells[0].diagnostics!);
    const requests = artifact.events.filter((event) => event.kind === "provider-request");
    expect(requests).toHaveLength(2);
    const event = artifact.events.find((event) => event.kind === "verification-details")!;
    expect(event).toBeDefined();
    expect(event.sequence).toBeLessThan(requests[1].sequence);
    expect(JSON.stringify(artifact.payloads[event.payload])).toContain("verifier-fixture");
    expect(JSON.stringify(report.cells)).not.toContain("verifier-fixture");
  });

  it.each([false, true])("requires existing captures when resuming with diagnostics: %s", async (enabled) => {
    const { root, config } = setup();
    const output = join(root, "report.json");
    const progress = join(root, "progress.json");
    const diagnosticsDir = join(root, "private");
    const dependencies = { loadConfig: () => config, io: { stdout: vi.fn(), stderr: vi.fn() } };
    await runEvalCli(["run", "fixture.cjs", output, "--resume", progress, ...(enabled ? ["--diagnostics-dir", diagnosticsDir] : [])], dependencies);
    const resumed = runEvalCli(["run", "fixture.cjs", output, "--diagnostics-dir", diagnosticsDir, "--resume", progress], dependencies);
    if (enabled) await expect(resumed).resolves.toBe(0);
    else await expect(resumed).rejects.toThrow("no diagnostic artifact");
  });

  it.each([["--diagnostics-dir"], ["--diagnostics-dir", " "], ["--diagnostics-dir", "--resume"],
    ["--diagnostics-dir", "private", "--diagnostics-dir", "other"], ["--unknown", "private"],
  ])("rejects malformed capture flags before loading config: %j", async (flags) => {
    const loadConfig = vi.fn();
    await expect(runEvalCli(["run", "fixture.cjs", "report.json", ...flags], { loadConfig })).rejects.toThrow("Invalid arguments");
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("keeps release capture disabled and upload paths explicitly limited to compact reports", () => {
    const workflow = readFileSync(resolve(".github/workflows/eval-release.yml"), "utf8");
    expect(workflow).not.toContain("--diagnostics-dir");
    const parsed = parse(workflow) as { jobs: Record<string, { steps: Array<{ uses?: string; with?: { path?: string } }> }> };
    const uploadPaths = parsed.jobs["release-eval"].steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
      ?.with?.path?.trim().split(/\r?\n/);
    expect(uploadPaths).toEqual(["reports/release-candidate.json", "reports/release-candidate.progress.json", "reports/release-diff.json"]);
  });
});