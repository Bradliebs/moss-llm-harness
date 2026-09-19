import type { EvalCase, EvalDatasetSplit, EvalExecutionPolicy } from "../../../../common/evals";
import { findDuplicateWarnings, validateDatasetLineage } from "./dataset-lineage";

export function allowedExecutionSplits(policy: EvalExecutionPolicy): EvalDatasetSplit[] {
  switch (policy.purpose) {
    case "iteration": return ["development"];
    case "promotion": return ["validation"];
    case "release":
      if (!policy.measurementName?.trim()) throw new Error("Release execution requires a named measurement");
      return ["development", "validation", "holdout"];
    default: throw new Error("Unknown evaluation execution purpose");
  }
}

export function validateSplitExecution(
  cases: readonly EvalCase[],
  policy: EvalExecutionPolicy = { purpose: "iteration" },
  corpus: readonly EvalCase[] = cases,
): void {
  const allowed = allowedExecutionSplits(policy);
  const corpusById = new Map(corpus.map((testCase) => [testCase.id, testCase]));
  if (corpusById.size !== corpus.length) throw new Error("Split corpus contains duplicate case IDs");
  for (const testCase of cases) {
    const source = corpusById.get(testCase.id);
    if (!source || source.split !== testCase.split || source.family !== testCase.family
      || source.task.objective !== testCase.task.objective || source.lineage?.revisionId !== testCase.lineage?.revisionId) {
      throw new Error(`Case '${testCase.id}' differs from its split corpus entry`);
    }
    if (!allowed.includes(testCase.split ?? "development")) {
      throw new Error(`Case '${testCase.id}' split '${testCase.split}' cannot execute for '${policy.purpose}'`);
    }
  }
  const lineage = validateDatasetLineage(corpus.filter((testCase) => testCase.lineage || testCase.split === "holdout"));
  const errors = [...lineage.errors];
  const splitByFamily = new Map<string, Set<string>>();
  for (const testCase of corpus) {
    const roots = [
      `root:${testCase.lineage?.familyRootId ?? testCase.perturbation?.canonicalCaseId ?? testCase.id}`,
      ...(testCase.family ? [`family:${testCase.family}`] : []),
    ];
    for (const root of roots) {
      const splits = splitByFamily.get(root) ?? new Set<string>();
      splits.add(testCase.split ?? "development");
      splitByFamily.set(root, splits);
    }
  }
  for (const [family, splits] of splitByFamily) {
    if (splits.has("holdout") && splits.size > 1) errors.push(`Family '${family}' crosses holdout boundary`);
  }
  const duplicates = findDuplicateWarnings(corpus);
  for (const duplicate of duplicates) {
    const left = corpusById.get(duplicate.leftCaseId)!;
    const right = corpusById.get(duplicate.rightCaseId)!;
    if ((left.split === "holdout") !== (right.split === "holdout")) {
      errors.push(`Near-duplicate cases '${left.id}' and '${right.id}' cross holdout boundary`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}