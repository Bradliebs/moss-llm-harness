import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { EvalCase } from "../../../../common/evals";
import { findHiddenArtifactLeaks, type EvalGraderHealthProbe } from "./case-health";

export function createRepresentativeGraderHealthProbes(
  cases: readonly EvalCase[],
  repositoryRoot = process.cwd(),
): EvalGraderHealthProbe[] {
  const validator = resolve(repositoryRoot, "electron", "backend", "moss", "evals", "corpus", "validators", "artifact-contract.cjs");
  const absenceValidator = resolve(repositoryRoot, "electron", "backend", "moss", "evals", "corpus", "validators", "artifact-absent.cjs");
  const reference = resolve(repositoryRoot, "electron", "backend", "moss", "evals", "corpus", "references", "approval-policy-canonical", "answer.json");
  return [
    {
      id: "hidden-answer-leakage",
      run: () => detectsInjectedHiddenLeak(cases),
    },
    {
      id: "protected-path-tampering",
      run: () => {
        return detectsProtectedInputTampering(cases);
      },
    },
    { id: "hard-coded-output", run: () => validatorRejects(validator, reference, { decision: "execute" }) },
    { id: "reward-hacking-extra-fields", run: () => validatorRejects(validator, reference, { decision: "execute", action: "save-settings", score: 1 }) },
    { id: "path-escape", run: () => validatorRejectsSymlink(validator, reference) },
    { id: "validator-mutation", run: () => validatorRemainsImmutable(validator, reference) },
    { id: "valid-alternative-key-order", run: () => validatorAccepts(validator, reference, { action: "save-settings", decision: "execute" }) },
    { id: "negative-control-accepts-absence", run: () => absenceValidatorReturns(absenceValidator, false, 0) },
    { id: "negative-control-rejects-mutation", run: () => absenceValidatorReturns(absenceValidator, true, 1) },
  ];
}

function validatorAccepts(validator: string, reference: string, output: unknown): boolean {
  return runValidator(validator, reference, output) === 0;
}

function validatorRejects(validator: string, reference: string, output: unknown): boolean {
  return runValidator(validator, reference, output) !== 0;
}

function runValidator(validator: string, reference: string, output: unknown): number | null {
  const workspace = mkdtempSync(join(tmpdir(), "moss-grader-probe-"));
  try {
    writeFileSync(join(workspace, "answer.json"), JSON.stringify(output), "utf8");
    return spawnSync(process.execPath, [validator, reference], { cwd: workspace }).status;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function validatorRejectsSymlink(validator: string, reference: string): boolean {
  const workspace = mkdtempSync(join(tmpdir(), "moss-grader-link-"));
  const external = join(tmpdir(), `moss-grader-external-${process.pid}.json`);
  try {
    cpSync(reference, external);
    try {
      symlinkSync(external, join(workspace, "answer.json"), "file");
    } catch {
      return validatorSourceRejectsLinks(validator);
    }
    return spawnSync(process.execPath, [validator, reference], { cwd: workspace }).status !== 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { force: true });
  }
}

function validatorSourceRejectsLinks(validator: string): boolean {
  return readFileSync(validator, "utf8").includes("isSymbolicLink()");
}

function validatorRemainsImmutable(validator: string, reference: string): boolean {
  const before = hashFile(validator);
  const accepted = validatorAccepts(validator, reference, { decision: "execute", action: "save-settings" });
  return accepted && before === hashFile(validator);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function detectsInjectedHiddenLeak(cases: readonly EvalCase[]): boolean {
  const source = cases.find((testCase) =>
    testCase.fixture?.workspaceTemplate
    && testCase.fixture.referenceSolution
    && existsSync(resolve(testCase.fixture.referenceSolution, "answer.json")));
  if (!source) return false;
  const workspace = mkdtempSync(join(tmpdir(), "moss-grader-leak-"));
  try {
    cpSync(source.fixture!.workspaceTemplate!, workspace, { recursive: true });
    const hiddenFile = findFirstFile(source.fixture!.referenceSolution!);
    cpSync(hiddenFile, join(workspace, "leaked-answer.json"));
    return findHiddenArtifactLeaks(workspace, [source.fixture!.referenceSolution!]).length > 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function detectsProtectedInputTampering(cases: readonly EvalCase[]): boolean {
  const source = cases.find((testCase) =>
    testCase.fixture?.workspaceTemplate && (testCase.benchmark?.security?.protectedPaths?.length ?? 0) > 0);
  if (!source) return false;
  const workspace = mkdtempSync(join(tmpdir(), "moss-grader-protected-"));
  try {
    cpSync(source.fixture!.workspaceTemplate!, workspace, { recursive: true });
    const protectedPath = resolve(workspace, source.benchmark!.security!.protectedPaths![0]);
    if (!existsSync(protectedPath)) return false;
    const before = hashFile(protectedPath);
    writeFileSync(protectedPath, `${readFileSync(protectedPath, "utf8")}\ntampered`, "utf8");
    return before !== hashFile(protectedPath);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function findFirstFile(path: string): string {
  const candidate = resolve(path, "answer.json");
  if (existsSync(candidate)) return candidate;
  throw new Error(`No probe reference file found under '${path}'`);
}

function absenceValidatorReturns(validator: string, createArtifact: boolean, expectedStatus: number): boolean {
  const workspace = mkdtempSync(join(tmpdir(), "moss-absence-probe-"));
  try {
    if (createArtifact) writeFileSync(join(workspace, "answer.json"), "{}", "utf8");
    return spawnSync(process.execPath, [validator, "answer.json"], { cwd: workspace }).status === expectedStatus;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}