import { createHash } from "node:crypto";

import type { EvalCase, EvalDatasetLineage } from "../../../../common/evals";

export interface EvalDuplicateWarning {
  leftCaseId: string;
  rightCaseId: string;
  similarity: number;
}

export interface EvalLineageHealth {
  valid: boolean;
  errors: string[];
  duplicateWarnings: EvalDuplicateWarning[];
}

export function createInitialLineage(testCase: EvalCase): EvalDatasetLineage {
  const contentHash = caseContentHash(testCase);
  return {
    revision: 1,
    revisionId: `${testCase.id}@1:${contentHash.slice(0, 12)}`,
    familyRootId: testCase.perturbation?.canonicalCaseId ?? testCase.id,
    contentHash,
  };
}

export function reviseEvalCase(
  previous: EvalCase,
  next: EvalCase,
  authoredFromRun?: EvalDatasetLineage["authoredFromRun"],
): EvalCase {
  if (!previous.lineage) throw new Error(`Case '${previous.id}' has no lineage to revise`);
  if (previous.id !== next.id) throw new Error("A revision cannot change case identity");
  const contentHash = caseContentHash(next);
  if (contentHash === previous.lineage.contentHash) throw new Error("A revision must change governed case content");
  const revision = previous.lineage.revision + 1;
  return {
    ...structuredClone(next),
    lineage: {
      revision,
      revisionId: `${next.id}@${revision}:${contentHash.slice(0, 12)}`,
      parentRevisionId: previous.lineage.revisionId,
      familyRootId: previous.lineage.familyRootId,
      contentHash,
      ...(authoredFromRun ? { authoredFromRun: structuredClone(authoredFromRun) } : {}),
    },
  };
}

export function validateDatasetLineage(cases: readonly EvalCase[]): EvalLineageHealth {
  const errors: string[] = [];
  const revisionIds = new Set<string>();
  const splitByFamily = new Map<string, Set<string>>();
  for (const testCase of cases) {
    const lineage = testCase.lineage;
    if (!lineage) {
      errors.push(`Case '${testCase.id}' lacks dataset lineage`);
      continue;
    }
    if (lineage.contentHash !== caseContentHash(testCase)) errors.push(`Case '${testCase.id}' content changed without a revision`);
    if (revisionIds.has(lineage.revisionId)) errors.push(`Duplicate revision id '${lineage.revisionId}'`);
    revisionIds.add(lineage.revisionId);
    const splits = splitByFamily.get(lineage.familyRootId) ?? new Set<string>();
    if (testCase.split) splits.add(testCase.split);
    splitByFamily.set(lineage.familyRootId, splits);
  }
  for (const [family, splits] of splitByFamily) {
    if (splits.has("holdout") && splits.size > 1) {
      errors.push(`Family '${family}' crosses holdout and non-holdout splits`);
    }
  }
  return {
    valid: errors.length === 0,
    errors: errors.sort(),
    duplicateWarnings: findDuplicateWarnings(cases),
  };
}

export function findDuplicateWarnings(cases: readonly EvalCase[], threshold = 0.82): EvalDuplicateWarning[] {
  const warnings: EvalDuplicateWarning[] = [];
  for (let leftIndex = 0; leftIndex < cases.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < cases.length; rightIndex++) {
      if (cases[leftIndex].family && cases[leftIndex].family === cases[rightIndex].family) continue;
      const similarity = jaccard(tokens(cases[leftIndex].task.objective), tokens(cases[rightIndex].task.objective));
      if (similarity >= threshold) {
        warnings.push({
          leftCaseId: cases[leftIndex].id,
          rightCaseId: cases[rightIndex].id,
          similarity: Number(similarity.toFixed(4)),
        });
      }
    }
  }
  return warnings;
}

function caseContentHash(testCase: EvalCase): string {
  return stableHash({
    id: testCase.id,
    profile: testCase.profile,
    difficulty: testCase.difficulty,
    estimatedHumanMinutes: testCase.estimatedHumanMinutes,
    taskMessiness: testCase.taskMessiness,
    suite: testCase.suite,
    split: testCase.split,
    family: testCase.family,
    domain: testCase.domain,
    perturbation: testCase.perturbation,
    task: testCase.task,
    allowedCapabilities: testCase.allowedCapabilities,
    checks: testCase.checks,
    benchmark: testCase.benchmark,
  });
}

function tokens(value: string): Set<string> {
  return new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
