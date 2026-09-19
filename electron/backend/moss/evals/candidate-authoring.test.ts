import { describe, expect, it } from "vitest";

import { approveEvalFamilyDraft, createEvalFamilyDraft, promoteEvalFamilyToRegression, type EvalCandidatePackage } from "./candidate-triage";
import { createOfflinePilotCases, getOfflinePilotEvaluatorArtifacts } from "./pilot-cases";
import { promoteCaseToRegression } from "./representative-corpus";

function draftFamily() {
  const candidate: EvalCandidatePackage = {
    schemaVersion: 1, id: "candidate-reviewed", status: "draft", familyCandidate: "contract",
    failureSignature: "wrong-output", rankScore: 2, occurrences: 1, affectedTasks: ["task-1"],
    userSignalCount: 0, traceRefs: [{ traceId: "source-trace", schemaVersion: 1, sha256: "a".repeat(64) }],
    proposed: { objectiveClass: "contract", split: "development", provenance: { source: "production", taskIds: ["task-1"] } },
    review: { objectiveApproved: false, fixtureMinimized: false, expectedBehaviorApproved: false, splitApproved: false, hiddenGraderApproved: false },
  };
  const cases = createOfflinePilotCases().filter((testCase) => !testCase.allowedCapabilities.includes("run_command")).slice(0, 2);
  cases[0].familyRole = "positive";
  cases[1].familyRole = "negative";
  return createEvalFamilyDraft(candidate, cases);
}

function reviewedDraft() {
  const draft = draftFamily();
  draft.candidate.review = {
    objectiveApproved: true, fixtureMinimized: true, expectedBehaviorApproved: true,
    splitApproved: true, hiddenGraderApproved: true,
  };
  return draft;
}

const options = {
  evaluatorArtifacts: getOfflinePilotEvaluatorArtifacts(),
  graderHealthProbes: [{ id: "reviewed-control", run: () => true }],
};

describe("reviewed family authoring", () => {
  it("requires new human review and never drafts directly into regression", async () => {
    const draft = draftFamily();
    expect(draft.cases.every((testCase) => testCase.suite === "capability" && testCase.split === "development")).toBe(true);
    await expect(approveEvalFamilyDraft(draft, "reviewer", options)).rejects.toThrow("review checks");
  });

  it("runs reference and grader health, preserving the unapproved original", async () => {
    const draft = reviewedDraft();
    const approved = await approveEvalFamilyDraft(draft, "reviewer", options);
    expect(approved).toMatchObject({ status: "approved", health: { publicationReady: true }, candidate: { review: { reviewer: "reviewer" } } });
    expect(approved.cases.every((testCase) => testCase.suite === "capability")).toBe(true);
    expect(draft.status).toBe("draft");
    expect(draft.cases[0].provenance?.referenceSolutionVerified).toBe(false);
    expect(approved.candidate.traceRefs).toEqual(draft.candidate.traceRefs);
  });

  it("promotes only an approved healthy family and links regression revisions", async () => {
    const draft = reviewedDraft();
    expect(() => promoteCaseToRegression(draft.cases[0], "reviewer")).toThrow("reviewed family");
    await expect(promoteEvalFamilyToRegression(draft, "reviewer", options)).rejects.toThrow("approved family");
    const approved = await approveEvalFamilyDraft(draft, "reviewer", options);
    const promoted = await promoteEvalFamilyToRegression(approved, "maintainer", options);
    expect(promoted.every((testCase) => testCase.suite === "regression" && testCase.lineage?.revision === 2)).toBe(true);
    expect(promoted[0].lineage?.parentRevisionId).toBe(approved.cases[0].lineage?.revisionId);
    expect(approved.cases[0].suite).toBe("capability");
    await expect(promoteEvalFamilyToRegression(approved, "maintainer", {
      ...options, graderHealthProbes: [{ id: "regressed-grader", run: () => false }],
    })).rejects.toThrow("health failed");
  });

  it("rejects missing controls, hidden graders, references, and failed probes", async () => {
    const missingControl = reviewedDraft();
    missingControl.cases.pop();
    await expect(approveEvalFamilyDraft(missingControl, "reviewer", options)).rejects.toThrow("controls");
    await expect(approveEvalFamilyDraft(reviewedDraft(), "reviewer", {})).rejects.toThrow("hidden grader");
    const missingReference = reviewedDraft();
    delete missingReference.cases[0].fixture!.referenceSolution;
    await expect(approveEvalFamilyDraft(missingReference, "reviewer", options)).rejects.toThrow("health failed");
    await expect(approveEvalFamilyDraft(reviewedDraft(), "reviewer", {
      ...options, graderHealthProbes: [{ id: "broken-control", run: () => false }],
    })).rejects.toThrow("health failed");
  });
});