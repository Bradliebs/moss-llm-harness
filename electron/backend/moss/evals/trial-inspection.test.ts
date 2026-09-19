import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessDiagnosticArtifactStore, HarnessDiagnosticCapture } from "./diagnostic-artifact-store";

import type { HarnessMatrixReport } from "../../../../common/evals";
import { inspectHarnessTrial, renderTrialInspectionHtml } from "./trial-inspection";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function report(cost = 0.25): HarnessMatrixReport {
  const cell = {
    caseId: "case<script>",
    targetId: "model",
    variantId: "guarded",
    repetition: 0,
    result: {
      observation: {
        caseId: "case<script>",
        runId: "run-1",
        provider: "fixture",
        model: "model",
        outcome: "completed" as const,
        startedAt: "2026-08-18T10:00:00.000Z",
        completedAt: "2026-08-18T10:00:01.000Z",
        evidence: [],
        usage: { inputTokens: 10, outputTokens: 3 },
        estimatedCostUsd: cost,
        admissions: [],
      },
      criteria: [{
        criterionId: "required",
        mandatory: true,
        passed: false,
        summary: "Expected state absent",
        checks: [{ checkId: "check", kind: "receipt", passed: false, summary: "Not asserted" }],
      }],
      success: false,
      score: 0,
      durationMs: 1_000,
      failureAttribution: { category: "agent-behavior" as const, reasonCode: "mandatory-criterion-failed", diagnostic: true as const },
      rubricAssessment: {
        diagnostic: true as const,
        provenance: { provider: "fixture", model: "grader-v1", promptHash: "a".repeat(64) },
        judgments: [{ dimensionId: "communication", label: "pass" as const }],
      },
    },
    trace: {
      schemaVersion: 1 as const,
      events: [{ type: "round-start" as const, round: 0, toolsEnabled: true, sequence: 1, timestamp: "2026-08-18T10:00:00.000Z" }],
      toolCalls: [{ callId: "call", name: "read_file", approvalRequested: false, ok: true }],
      usage: { inputTokens: 10, outputTokens: 3 },
      terminalState: "completed" as const,
    },
    protectedInputHashesBefore: { "protected.txt": "before" },
    protectedInputHashesAfter: { "protected.txt": "after" },
    protectedInputsIntact: false,
  };
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-18T10:01:00.000Z",
    manifest: {
      evaluatorVersion: "v1",
      caseIds: [cell.caseId],
      targetIds: [cell.targetId],
      variantIds: [cell.variantId],
      caseSetHash: "cases",
      targetSetHash: "targets",
      variantSetHash: "variants",
    },
    cells: [cell],
    summary: {} as HarnessMatrixReport["summary"],
  };
}

describe("trial inspection", () => {
  it("loads only explicit diagnostics, escapes content, and preserves correction history without rescoring", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-inspection-"));
    roots.push(root);
    const store = new HarnessDiagnosticArtifactStore(root);
    const capture = new HarnessDiagnosticCapture();
    capture.append("tool-result", "</pre><script>alert(1)</script>");
    const candidate = report();
    candidate.cells[0].diagnostics = store.write(capture);
    const correction = store.recordCorrection(candidate.cells[0].diagnostics, {
      reviewedBy: "fixture reviewer", reason: "Outcome manually verified", success: true, score: 1,
    });
    const before = JSON.stringify(candidate);
    expect(inspectHarnessTrial(candidate).diagnostics).toBeUndefined();
    const inspection = inspectHarnessTrial(candidate, {}, undefined, { store, corrections: [correction] });
    expect(inspection.outcome.success).toBe(false);
    expect(inspection.corrections).toHaveLength(1);
    expect(inspection.reviewSignals).toEqual(expect.arrayContaining([
      expect.stringContaining("does not prove grader error"), expect.stringContaining("No provider requests captured"),
    ]));
    const html = renderTrialInspectionHtml(inspection);
    expect(html).toContain("Outcome Checks");
    expect(html).toContain("Redacted Trajectory");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(JSON.stringify(candidate)).toBe(before);
    const unrelated = store.write(new HarnessDiagnosticCapture());
    const wrongCorrection = store.recordCorrection(unrelated, { reviewedBy: "reviewer", reason: "Other trial", score: 1 });
    expect(() => inspectHarnessTrial(candidate, {}, undefined, { store, corrections: [wrongCorrection] })).toThrow("does not belong");
    writeFileSync(join(root, `${candidate.cells[0].diagnostics.sha256}.json`), "{}");
    expect(() => inspectHarnessTrial(candidate, {}, undefined, { store })).toThrow("digest mismatch");
  });

  it("rejects requested diagnostics when the selected trial has no capture", () => {
    expect(() => inspectHarnessTrial(report(), {}, undefined, { store: new HarnessDiagnosticArtifactStore("unused") }))
      .toThrow("no diagnostic artifact");
  });

  it("projects timeline, evidence, protected inputs, resources, attribution, and baseline delta", () => {
    const inspection = inspectHarnessTrial(report(0.25), {}, report(0.1));

    expect(inspection.timeline).toHaveLength(1);
    expect(inspection.criteria[0]).toMatchObject({ criterionId: "required", passed: false });
    expect(inspection.protectedInputs).toEqual({ intact: false, checkedPaths: ["protected.txt"], changedPaths: ["protected.txt"] });
    expect(inspection.resources).toMatchObject({ inputTokens: 10, outputTokens: 3, actions: 1, estimatedCostUsd: 0.25 });
    expect(inspection.outcome.failureAttribution?.category).toBe("agent-behavior");
    expect(inspection.rubricAssessment?.judgments).toEqual([{ dimensionId: "communication", label: "pass" }]);
    expect(inspection.baselineDelta?.costDeltaUsd).toBeCloseTo(0.15);
  });

  it("refuses ambiguous or missing selectors", () => {
    const ambiguous = report();
    ambiguous.cells.push({ ...ambiguous.cells[0], repetition: 1 });

    expect(() => inspectHarnessTrial(ambiguous)).toThrow("ambiguous");
    expect(() => inspectHarnessTrial(ambiguous, { repetition: 9 })).toThrow("No harness trial");
  });

  it("escapes report-controlled strings in standalone HTML", () => {
    const html = renderTrialInspectionHtml(inspectHarnessTrial(report()));

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("case&lt;script&gt;");
    expect(html).not.toContain("case<script>");
  });
});