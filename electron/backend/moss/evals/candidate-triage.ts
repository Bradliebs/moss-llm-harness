import { createHash } from "node:crypto";

import type { EvalCase, EvalDatasetSplit } from "../../../../common/evals";
import type { TerminalRunRecord } from "../learning/run-journal";
import { checkEvalCases, type EvalCaseHealthOptions, type EvalCaseHealthReport } from "./case-health";
import { createInitialLineage, reviseEvalCase } from "./dataset-lineage";

export interface EvalFamilyDraft {
  schemaVersion: 1;
  status: "draft" | "approved";
  candidate: EvalCandidatePackage;
  cases: EvalCase[];
  health?: EvalCaseHealthReport;
}

export function createEvalFamilyDraft(candidate: EvalCandidatePackage, cases: readonly EvalCase[]): EvalFamilyDraft {
  return {
    schemaVersion: 1,
    status: "draft",
    candidate: { ...structuredClone(candidate), status: "draft", review: emptyReview() },
    cases: cases.map((original) => {
      const testCase = structuredClone(original);
      testCase.family = candidate.id;
      testCase.suite = "capability";
      testCase.split = "development";
      testCase.provenance = {
        source: "production",
        sourceId: candidate.id,
        sourceEvidence: candidate.affectedTasks.join(", "),
        referenceSolutionVerified: false,
      };
      testCase.lineage = { ...createInitialLineage(testCase), familyRootId: candidate.id };
      return testCase;
    }),
  };
}

export async function approveEvalFamilyDraft(
  draft: EvalFamilyDraft,
  reviewer: string,
  options: EvalCaseHealthOptions,
  reviewedAt = new Date(),
): Promise<EvalFamilyDraft> {
  const snapshot = structuredClone(draft);
  const candidate = approveEvalCandidate(snapshot.candidate, reviewer, reviewedAt);
  if (snapshot.status !== "draft") throw new Error("Only draft families can be approved");
  if (!options.evaluatorArtifacts?.length || !options.graderHealthProbes?.length) {
    throw new Error("Family approval requires hidden grader artifacts and control probes");
  }
  const roles = new Set(snapshot.cases.map((testCase) => testCase.familyRole));
  if (!roles.has("positive") || !roles.has("negative")) throw new Error("Family approval requires positive and negative controls");
  if (new Set(snapshot.cases.map((testCase) => testCase.id)).size !== snapshot.cases.length) {
    throw new Error("Family case IDs must be unique");
  }
  for (const testCase of snapshot.cases) {
    if (testCase.family !== candidate.id || testCase.lineage?.familyRootId !== candidate.id
      || testCase.split !== "development" || testCase.suite !== "capability"
      || testCase.provenance?.sourceId !== candidate.id || testCase.provenance.source !== "production"
      || !["positive", "negative"].includes(testCase.familyRole ?? "") || !testCase.checks.length) {
      throw new Error("Authored families must retain candidate provenance, development split, capability suite and graders");
    }
    testCase.provenance.referenceSolutionVerified = true;
  }
  const health = await checkEvalCases(snapshot.cases, {
    ...options,
    corpusPolicy: { ...options.corpusPolicy, requireDatasetLineage: true, requireSourceEvidence: true },
  });
  if (!health.publicationReady) throw new Error(`Family health failed: ${JSON.stringify(health)}`);
  return { ...snapshot, status: "approved", candidate, health };
}

export async function promoteEvalFamilyToRegression(
  approved: EvalFamilyDraft,
  reviewer: string,
  options: EvalCaseHealthOptions,
  reviewedAt = new Date(),
): Promise<EvalCase[]> {
  if (approved.status !== "approved" || approved.candidate.status !== "approved") {
    throw new Error("Regression promotion requires an approved family");
  }
  const checked = await approveEvalFamilyDraft({ ...approved, status: "draft" }, reviewer, options, reviewedAt);
  return checked.cases.map((testCase) => reviseEvalCase(testCase, {
    ...testCase,
    suite: "regression",
    provenance: {
      ...testCase.provenance!,
      promotion: { from: "capability", reviewedBy: reviewer.trim(), reviewedAt: reviewedAt.toISOString() },
    },
  }));
}

export interface EvalCandidateReview {
  objectiveApproved: boolean;
  fixtureMinimized: boolean;
  expectedBehaviorApproved: boolean;
  splitApproved: boolean;
  hiddenGraderApproved: boolean;
  reviewer?: string;
  reviewedAt?: string;
}

export interface EvalCandidatePackage {
  schemaVersion: 1;
  id: string;
  status: "draft" | "approved";
  familyCandidate: string;
  failureSignature: string;
  rankScore: number;
  occurrences: number;
  affectedTasks: string[];
  userSignalCount: number;
  traceRefs: NonNullable<TerminalRunRecord["traceRef"]>[];
  proposed: {
    objectiveClass: string;
    split: EvalDatasetSplit;
    provenance: { source: "production"; taskIds: string[] };
  };
  review: EvalCandidateReview;
}

export function createEvalCandidatePackages(records: readonly TerminalRunRecord[]): EvalCandidatePackage[] {
  const clusters = new Map<string, TerminalRunRecord[]>();
  for (const record of records) {
    for (const signature of record.failureSignatures) {
      const key = `${record.taskFamilyCandidate.id}:${signature}`;
      const group = clusters.get(key) ?? [];
      group.push(record);
      clusters.set(key, group);
    }
  }
  return [...clusters.entries()].map(([key, grouped]) => {
    const tasks = [...new Set(grouped.map((record) => record.taskId))].sort();
    const userSignalCount = grouped.reduce((total, record) => total + record.userSignals.length, 0);
    const severeOutcomes = grouped.filter((record) => record.outcome === "failed" || record.outcome === "blocked").length;
    const [familyCandidate, failureSignature] = splitClusterKey(key);
    return {
      schemaVersion: 1,
      id: `candidate-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
      status: "draft",
      familyCandidate,
      failureSignature,
      rankScore: grouped.length * 2 + userSignalCount * 3 + severeOutcomes,
      occurrences: grouped.length,
      affectedTasks: tasks,
      userSignalCount,
      traceRefs: grouped.flatMap((record) => record.traceRef ? [record.traceRef] : []),
      proposed: {
        objectiveClass: grouped[0].objectiveClass,
        split: "development",
        provenance: { source: "production", taskIds: tasks },
      },
      review: emptyReview(),
    } satisfies EvalCandidatePackage;
  }).sort((left, right) => right.rankScore - left.rankScore || left.id.localeCompare(right.id));
}

export function approveEvalCandidate(
  candidate: EvalCandidatePackage,
  reviewer: string,
  reviewedAt = new Date(),
): EvalCandidatePackage {
  const confirmations = [
    candidate.review.objectiveApproved,
    candidate.review.fixtureMinimized,
    candidate.review.expectedBehaviorApproved,
    candidate.review.splitApproved,
    candidate.review.hiddenGraderApproved,
  ];
  if (!confirmations.every(Boolean)) throw new Error("All eval candidate review checks must be confirmed");
  if (!reviewer.trim() || !Number.isFinite(reviewedAt.getTime())) throw new Error("Candidate approval requires a reviewer and valid time");
  return {
    ...structuredClone(candidate),
    status: "approved",
    review: { ...structuredClone(candidate.review), reviewer: reviewer.trim(), reviewedAt: reviewedAt.toISOString() },
  };
}

function emptyReview(): EvalCandidateReview {
  return {
    objectiveApproved: false,
    fixtureMinimized: false,
    expectedBehaviorApproved: false,
    splitApproved: false,
    hiddenGraderApproved: false,
  };
}

function splitClusterKey(key: string): [string, string] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), key.slice(separator + 1)];
}
