import type { EvalCase, EvalDifficulty, EvalProfile } from "../../../../common/evals";
import type { TaskSpec } from "../../../../common/types";
import type { VerificationCheck } from "../../../../common/verification";
import { validateCase } from "./eval-runner";

type PortableGovernance = Pick<EvalCase, "suite" | "split" | "family" | "familyRole" | "domain" | "perturbation"
  | "scenario" | "lineage" | "benchmark" | "estimatedHumanMinutes" | "taskMessiness">;

export interface PortableEvalCase extends PortableGovernance {
  id: string;
  profile: EvalProfile;
  difficulty: EvalDifficulty;
  task: TaskSpec;
  allowedCapabilities: string[];
  checks: VerificationCheck[];
  repetitions?: number;
  tags?: string[];
}

export interface PortableEvalDataset {
  schemaVersion: 1;
  format: "moss-portable-eval";
  cases: PortableEvalCase[];
}

export function exportPortableDataset(cases: readonly EvalCase[]): PortableEvalDataset {
  return {
    schemaVersion: 1,
    format: "moss-portable-eval",
    cases: cases.map((testCase) => ({
      id: testCase.id,
      profile: testCase.profile,
      difficulty: testCase.difficulty,
      ...portableGovernance(testCase),
      task: structuredClone(testCase.task),
      allowedCapabilities: [...testCase.allowedCapabilities],
      checks: structuredClone(testCase.checks),
      ...(testCase.repetitions !== undefined ? { repetitions: testCase.repetitions } : {}),
      ...(testCase.tags ? { tags: [...testCase.tags] } : {}),
    })),
  };
}

export function importPortableDataset(value: unknown): EvalCase[] {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.format !== "moss-portable-eval"
    || !Array.isArray(value.cases)) {
    throw new Error("Invalid moss portable eval dataset");
  }
  return value.cases.map((portable, index) => {
    if (!isRecord(portable)) throw new Error(`Invalid portable eval case at index ${index}`);
    const testCase = {
      schemaVersion: 1,
      id: portable.id,
      profile: portable.profile,
      difficulty: portable.difficulty,
      task: portable.task,
      allowedCapabilities: portable.allowedCapabilities,
      checks: portable.checks,
      ...(portable.repetitions !== undefined ? { repetitions: portable.repetitions } : {}),
      ...(portable.tags !== undefined ? { tags: portable.tags } : {}),
      suite: portable.suite, split: portable.split, family: portable.family, familyRole: portable.familyRole,
      domain: portable.domain, perturbation: portable.perturbation, scenario: portable.scenario,
      lineage: portable.lineage, benchmark: portable.benchmark,
      estimatedHumanMinutes: portable.estimatedHumanMinutes, taskMessiness: portable.taskMessiness,
    } as EvalCase;
    validateCase(testCase);
    return structuredClone(testCase);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function portableGovernance(testCase: PortableGovernance): PortableGovernance {
  return structuredClone({
    suite: testCase.suite, split: testCase.split, family: testCase.family, familyRole: testCase.familyRole,
    domain: testCase.domain, perturbation: testCase.perturbation, scenario: testCase.scenario,
    lineage: testCase.lineage, benchmark: testCase.benchmark,
    estimatedHumanMinutes: testCase.estimatedHumanMinutes, taskMessiness: testCase.taskMessiness,
  });
}
