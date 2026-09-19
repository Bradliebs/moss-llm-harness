import type { EvalCase, HarnessExecutionCoverage, HarnessVariant } from "../../../../common/evals";
import { validateEvalCaseCapabilities } from "./trusted-scenario-tools";

export type EvalExecutionSelection = "local" | "container" | "full";

export function validateExecutionCoverage(coverage: HarnessExecutionCoverage, caseIds: readonly string[]): void {
  const accounted = [...caseIds, ...coverage.excluded.map((entry) => entry.caseId)];
  if (!["local", "container", "full"].includes(coverage.selection)
    || new Set(coverage.corpusCaseIds).size !== coverage.corpusCaseIds.length
    || new Set(accounted).size !== accounted.length
    || accounted.length !== coverage.corpusCaseIds.length
    || accounted.some((caseId) => !coverage.corpusCaseIds.includes(caseId))
    || coverage.excluded.some((entry) => !["requires-container", "local-case", "suite-filter", "split-filter"].includes(entry.reason))) {
    throw new Error("Invalid execution coverage accounting");
  }
}

export function requiresEvalSandbox(testCase: EvalCase, variant?: HarnessVariant): boolean {
  return testCase.allowedCapabilities.includes("run_command") || variant?.verify?.enabled === true || testCase.scenario?.verification !== undefined;
}

export function selectExecutionCases(cases: EvalCase[], variants: HarnessVariant[], selection: EvalExecutionSelection) {
  if (!["local", "container", "full"].includes(selection)) throw new Error("Execution selection must be local, container or full");
  const selected: EvalCase[] = [];
  const excluded: Array<{ caseId: string; reason: "requires-container" | "local-case" }> = [];
  for (const testCase of cases) {
    validateEvalCaseCapabilities(testCase);
    const container = requiresEvalSandbox(testCase) || variants.some((variant) => requiresEvalSandbox(testCase, variant));
    if (selection === "full" || (selection === "container") === container) selected.push(testCase);
    else excluded.push({ caseId: testCase.id, reason: container ? "requires-container" : "local-case" });
  }
  return { cases: selected, excluded };
}