import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkEvalCases } from "./case-health";
import { createRepresentativeGraderHealthProbes } from "./grader-health";
import {
  REPRESENTATIVE_CORPUS_POLICY,
  createRepresentativeCorpus,
  getRepresentativeEvaluatorArtifacts,
  promoteCaseToRegression,
} from "./representative-corpus";

describe("representative eval corpus", () => {
  it("contains 30 governed cases across the required domains, suites, and perturbation pairs", () => {
    const cases = createRepresentativeCorpus();
    const ids = new Set(cases.map((testCase) => testCase.id));

    expect(cases).toHaveLength(30);
    expect(ids.size).toBe(cases.length);
    expect(new Set(cases.map((testCase) => testCase.domain))).toEqual(new Set(REPRESENTATIVE_CORPUS_POLICY.requiredDomains));
    expect(cases.filter((testCase) => testCase.suite === "regression")).toHaveLength(20);
    expect(cases.filter((testCase) => testCase.suite === "capability")).toHaveLength(6);
    expect(cases.filter((testCase) => testCase.suite === "challenge")).toHaveLength(4);
    expect(cases.every((testCase) => ids.has(testCase.perturbation!.canonicalCaseId))).toBe(true);
    expect(cases.every((testCase) => existsSync(resolve(testCase.provenance!.sourceEvidence!)))).toBe(true);
  });

  it("uses an executable positive/negative approval pair instead of scenario-reading decisions", () => {
    const cases = createRepresentativeCorpus();
    const granted = cases.find((testCase) => testCase.id === "approval-policy-canonical")!;
    const denied = cases.find((testCase) => testCase.id === "approval-policy-perturbed")!;

    expect(granted.task.objective).toBe(denied.task.objective);
    expect(granted.familyRole).toBe("positive");
    expect(denied.familyRole).toBe("negative");
    expect(granted.scenario?.disturbances).toEqual([
      expect.objectContaining({ type: "approval-response", approved: true }),
    ]);
    expect(denied.scenario?.disturbances).toEqual([
      expect.objectContaining({ type: "approval-response", approved: false }),
    ]);
    expect(denied.checks).toEqual([
      expect.objectContaining({ id: "artifact-absent", kind: "command" }),
    ]);
  });

  it("uses an executable transient-failure pair with an invariant outcome", () => {
    const cases = createRepresentativeCorpus();
    const canonical = cases.find((testCase) => testCase.id === "tool-recovery-canonical")!;
    const perturbed = cases.find((testCase) => testCase.id === "tool-recovery-perturbed")!;

    expect(canonical.task.objective).toBe(perturbed.task.objective);
    expect(canonical.familyRole).toBe("positive");
    expect(canonical.scenario).toBeUndefined();
    expect(perturbed.familyRole).toBe("negative");
    expect(perturbed.scenario?.disturbances).toEqual([expect.objectContaining({
      type: "tool-failure",
      capability: "read_file",
      failure: "transient",
    })]);
    expect(perturbed.perturbation?.expectedDecision).toBe("same");
  });

  it("passes the representative policy and every hidden reference validator", async () => {
    const report = await checkEvalCases(createRepresentativeCorpus(), {
      corpusPolicy: REPRESENTATIVE_CORPUS_POLICY,
      evaluatorArtifacts: getRepresentativeEvaluatorArtifacts(),
      graderHealthProbes: createRepresentativeGraderHealthProbes(createRepresentativeCorpus()),
    });

    expect(report.corpusErrors).toEqual([]);
    expect(report.cases.filter((testCase) => !testCase.passed)).toEqual([]);
    expect(report.graderHealth).toHaveLength(9);
    expect(report.graderHealth.filter((probe) => !probe.passed)).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.publicationReady).toBe(true);
  }, 15_000);

  it("promotes a reviewed case without replacing its identity or origin", () => {
    const capabilityCase = createRepresentativeCorpus().find((testCase) => testCase.suite === "capability")!;
    const promoted = promoteCaseToRegression(capabilityCase, "harness-owner", new Date("2026-07-23T12:00:00Z"));

    expect(promoted.id).toBe(capabilityCase.id);
    expect(promoted.suite).toBe("regression");
    expect(promoted.provenance).toMatchObject({
      source: capabilityCase.provenance!.source,
      promotion: {
        from: "capability",
        reviewedBy: "harness-owner",
        reviewedAt: "2026-07-23T12:00:00.000Z",
      },
    });
    expect(() => promoteCaseToRegression(promoted, "second-reviewer")).toThrow("must be in capability or challenge");
  });
});