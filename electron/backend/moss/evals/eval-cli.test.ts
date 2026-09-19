import { describe, expect, it, vi } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { EvalCase, EvalModelTarget, HarnessMatrixReport, HarnessVariant } from "../../../../common/evals";
import type { HarnessEvalConfig } from "./eval-cli";
import { runEvalCli, summarizeCaseCoverage } from "./eval-cli";
import { buildHarnessManifest } from "./matrix-runner";
import { createOfflinePilotCases } from "./pilot-cases";
import { RunJournal } from "../learning/run-journal";

const testCase: EvalCase = {
  schemaVersion: 1,
  id: "cli-case",
  profile: "platform",
  difficulty: "smoke",
  task: {
    objective: "Validate the CLI config",
    acceptanceCriteria: [{ id: "valid", description: "Config is valid", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  allowedCapabilities: [],
  checks: [{ id: "valid-check", criterionId: "valid", kind: "receipt", asserted: true }],
  repetitions: 2,
};

const target: EvalModelTarget = {
  schemaVersion: 1,
  id: "cli-model",
  providerId: "fixture",
  providerKind: "deterministic",
  model: "fixture-model",
};

const variants: HarnessVariant[] = [
  { schemaVersion: 1, id: "one", description: "First" },
  { schemaVersion: 1, id: "two", description: "Second" },
];

function compatibleBaseline(config: HarnessEvalConfig): HarnessMatrixReport {
  const cells = config.targets.flatMap((modelTarget) => config.variants.flatMap((variant) =>
    config.cases.flatMap((evalCase) => Array.from({ length: evalCase.repetitions ?? 1 }, (_, repetition) => ({
      caseId: evalCase.id,
      targetId: modelTarget.id,
      variantId: variant.id,
      repetition,
    })))));
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-13T10:00:00.000Z",
    manifest: buildHarnessManifest(config.cases, config.targets, config.variants, undefined, undefined, config.executionCoverage, config.executionPolicy, config.healthCases),
    cells,
    summary: {},
  } as HarnessMatrixReport;
}

describe("runEvalCli", () => {
  it("reports exclusions and rejects partial release preflight before execution", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor,
      healthCases: [testCase, { ...testCase, id: "command", allowedCapabilities: ["run_command"] }],
      executionCoverage: { selection: "local", corpusCaseIds: [testCase.id, "command"],
        excluded: [{ caseId: "command", reason: "requires-container" }] } };
    const stdout = vi.fn();
    await runEvalCli(["dry-run", "fixture.cjs"], { loadConfig: () => config, io: { stdout, stderr: vi.fn() } });
    expect(JSON.parse(stdout.mock.calls[0][0]).manifest.executionCoverage).toEqual(config.executionCoverage);
    await expect(runEvalCli(["preflight", "fixture.cjs", "baseline.json", "--policy", "reports/pilot-thresholds.json"], {
      loadConfig: () => config, readReport: () => compatibleBaseline(config), io: { stdout, stderr: vi.fn() },
    })).rejects.toThrow("full execution coverage");
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it.each([
    ["dry-run", "fixture.cjs"],
    ["preflight", "fixture.cjs", "baseline.json"],
    ["run", "fixture.cjs", "output.json"],
  ])("checks execution prerequisites for %s without starting any cells", async (...args) => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor,
      validateExecution: () => { throw new Error("pinned image missing"); } };
    await expect(runEvalCli(args, { loadConfig: () => config })).rejects.toThrow("pinned image missing");
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("keeps no-model health independent of execution prerequisites", async () => {
    const validateExecution = vi.fn(() => { throw new Error("pinned image missing"); });
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor: vi.fn(), validateExecution };
    await runEvalCli(["health", "fixture.cjs"], { loadConfig: () => config, io: { stdout: vi.fn(), stderr: vi.fn() } });
    expect(validateExecution).not.toHaveBeenCalled();
  });

  it("dry-runs a config without invoking its executor", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor };
    const stdout = vi.fn();

    const exitCode = await runEvalCli(["dry-run", "fixture.cjs"], {
      loadConfig: () => config,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(createExecutor).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"cells": 4'));
    expect(config.createExecutor).not.toHaveBeenCalled();
    expect(config.createExecutor).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"metadataComplete": 0'));
  });

  it("preflights baseline compatibility without invoking the executor", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor };
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    const stdout = vi.fn();

    await expect(runEvalCli(["preflight", "fixture.cjs", "baseline.json"], {
      loadConfig: () => config,
      readReport: () => baseline,
      io: { stdout, stderr: vi.fn() },
    })).rejects.toThrow("case set");

    expect(createExecutor).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("accepts a complete compatible baseline without invoking the executor", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor };
    const stdout = vi.fn();

    const exitCode = await runEvalCli(["preflight", "fixture.cjs", "baseline.json"], {
      loadConfig: () => config,
      readReport: () => compatibleBaseline(config),
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(createExecutor).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"valid": true'));
  });

  it("rejects a compatible baseline with incomplete repetition coverage", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor };
    const baseline = compatibleBaseline(config);
    baseline.cells.pop();

    await expect(runEvalCli(["preflight", "fixture.cjs", "baseline.json"], {
      loadConfig: () => config,
      readReport: () => baseline,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("requested config requires 4");

    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("summarizes case governance and evaluator coverage", () => {
    const coverage = summarizeCaseCoverage([{
      ...testCase,
      suite: "regression",
      split: "development",
      family: "cli",
      provenance: { source: "test", referenceSolutionVerified: true },
      allowedCapabilities: ["read_file"],
    }]);

    expect(coverage).toMatchObject({
      cases: 1,
      metadataComplete: 1,
      bySuite: { regression: 1 },
      bySplit: { development: 1 },
      byFamily: { cli: 1 },
      byCapability: { read_file: 1 },
      byCheckKind: { receipt: 1 },
    });
  });

  it("exports and imports the portable dataset format", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-portable-cli-"));
    const portablePath = resolve(root, "portable.json");
    const importedPath = resolve(root, "imported.json");
    const config: HarnessEvalConfig = {
      cases: [testCase],
      targets: [target],
      variants,
      createExecutor: vi.fn(),
    };
    try {
      expect(await runEvalCli(["dataset-export", "fixture.cjs", portablePath], {
        loadConfig: () => config,
        io: { stdout: vi.fn(), stderr: vi.fn() },
      })).toBe(0);
      expect(await runEvalCli(["dataset-import", portablePath, importedPath], {
        io: { stdout: vi.fn(), stderr: vi.fn() },
      })).toBe(0);

      const imported = JSON.parse(readFileSync(importedPath, "utf8")) as { cases: EvalCase[] };
      expect(imported.cases).toHaveLength(1);
      expect(imported.cases[0].id).toBe(testCase.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a usage error for unknown commands", async () => {
    const stderr = vi.fn();

    const exitCode = await runEvalCli([], { io: { stdout: vi.fn(), stderr } });

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("writes human-gated draft candidates from the production run journal", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-triage-"));
    const output = resolve(root, "candidates.json");
    try {
      await new RunJournal(root).append({
        taskId: "task-1",
        objectiveClass: "code-repair",
        capabilityIds: ["shell"],
        attempts: [],
        failures: [{ category: "tool", reasonCode: "timeout", summary: "timed out" }],
        recoveryChoices: [],
        criteria: [{ criterionId: "tests", passed: false, summary: "failed" }],
        outcome: "failed",
        durationMs: 100,
        costUsd: 0,
        userSignals: [],
      });
      const stdout = vi.fn();

      const exitCode = await runEvalCli(["triage", root, output], { io: { stdout, stderr: vi.fn() } });
      const result = JSON.parse(readFileSync(output, "utf8")) as { candidates: Array<{ status: string }> };

      expect(exitCode).toBe(0);
      expect(result.candidates).toEqual([expect.objectContaining({ status: "draft" })]);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("1 draft eval candidates"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a failed health result for a case without reference fixtures", async () => {
    const stdout = vi.fn();
    const config: HarnessEvalConfig = {
      cases: [testCase],
      targets: [target],
      variants,
      createExecutor: vi.fn(),
    };

    const exitCode = await runEvalCli(["health", "fixture.cjs"], {
      loadConfig: () => config,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"valid": false'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("referenceSolution"));
  });

  it("returns a failed health result when grader probes block publication", async () => {
    const stdout = vi.fn();
    const config: HarnessEvalConfig = {
      cases: [createOfflinePilotCases()[0]],
      targets: [target],
      variants,
      createExecutor: vi.fn(),
      graderHealthProbes: [{ id: "tamper-probe", run: () => false }],
    };

    const exitCode = await runEvalCli(["health", "fixture.cjs"], {
      loadConfig: () => config,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"valid": true'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"publicationReady": false'));
  });

  it("loads an explicit threshold policy for report diffs", async () => {
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    const loadThresholds = vi.fn(() => ({ maxTokenIncrease: 2_000 }));
    const stdout = vi.fn();

    const exitCode = await runEvalCli([
      "diff",
      "baseline.json",
      "candidate.json",
      "--policy",
      "reports/pilot-thresholds.json",
    ], {
      readReport: () => baseline,
      loadThresholds,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(loadThresholds).toHaveBeenCalledWith(resolve("reports/pilot-thresholds.json"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"passed": true'));
  });

  it("rejects process thresholds outside the score delta range", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-policy-"));
    const policyPath = resolve(root, "invalid.json");
    writeFileSync(policyPath, '{"minProcessDelta":-5}', "utf8");
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;

    await expect(runEvalCli([
      "diff",
      "baseline.json",
      "candidate.json",
      "--policy",
      policyPath,
    ], {
      readReport: () => baseline,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("Invalid harness threshold policy");

    rmSync(root, { recursive: true, force: true });
  });

  it("loads a validated suite-specific release policy", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-suite-policy-"));
    const policyPath = resolve(root, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      minimumRepetitions: 1,
      minimumPairedCells: 1,
      minimumPairedCases: 1,
      nonInferiorityMargin: 0.1,
      suites: {
        regression: { nonInferiorityMargin: 0.1, minimumPairedCases: 1 },
      },
    }), "utf8");
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    baseline.manifest.caseSuites = Object.fromEntries(baseline.manifest.caseIds.map((caseId) => [caseId, "regression"]));

    const exitCode = await runEvalCli(["diff", "baseline.json", "candidate.json", "--policy", policyPath], {
      readReport: () => baseline,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { minimumPairedCases: 0 },
    { minimumPairedCases: 1.5 },
    { nonInferiorityMargin: -0.01 },
    { nonInferiorityMargin: 1.01 },
  ])("rejects malformed canonical non-inferiority policy %#", async (policy) => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-invalid-non-inferiority-policy-"));
    const policyPath = resolve(root, "policy.json");
    writeFileSync(policyPath, JSON.stringify(policy), "utf8");

    await expect(runEvalCli(["diff", "baseline.json", "candidate.json", "--policy", policyPath], {
      readReport: () => JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("Invalid harness threshold policy");

    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown fields inside suite-specific release policy", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-invalid-suite-policy-"));
    const policyPath = resolve(root, "policy.json");
    writeFileSync(policyPath, '{"suites":{"regression":{"unknown":1}}}', "utf8");

    await expect(runEvalCli(["diff", "baseline.json", "candidate.json", "--policy", policyPath], {
      readReport: () => JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("Invalid harness threshold policy");

    rmSync(root, { recursive: true, force: true });
  });

  it("inspects one selected trial with an optional baseline delta", async () => {
    const report = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    const cell = report.cells[0];
    const stdout = vi.fn();

    const exitCode = await runEvalCli([
      "inspect",
      "candidate.json",
      "--case", cell.caseId,
      "--target", cell.targetId,
      "--variant", cell.variantId,
      "--repetition", String(cell.repetition),
      "--baseline", "baseline.json",
    ], {
      readReport: () => report,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`"runId": "${cell.result.observation.runId}"`));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"baselineDelta"'));
  });

  it("exports a self-contained HTML trial inspection", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-inspection-"));
    const output = resolve(root, "trial.html");
    const report = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    const cell = report.cells[0];

    const exitCode = await runEvalCli([
      "export", "report.json", output,
      "--case", cell.caseId,
      "--target", cell.targetId,
      "--variant", cell.variantId,
      "--repetition", String(cell.repetition),
      "--format", "html",
    ], {
      readReport: () => report,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("<!doctype html>");
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects malformed inspection selectors", async () => {
    await expect(runEvalCli(["inspect", "report.json", "--repetition", "-1"], {
      readReport: vi.fn(),
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("Invalid eval trial repetition");
  });
});