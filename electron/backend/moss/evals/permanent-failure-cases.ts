import { resolve } from "node:path";
import type { EvalCase } from "../../../../common/evals";

export function createPermanentFailureCases(repoRoot = process.cwd()): EvalCase[] {
  const root = resolve(repoRoot, "electron/backend/moss/evals/corpus");
  return [false, true].map((permanent): EvalCase => ({
    schemaVersion: 1,
    id: permanent ? "permanent-failure-perturbed" : "permanent-failure-canonical",
    profile: "coding",
    difficulty: "standard",
    suite: "regression",
    split: "development",
    family: "permanent-failure",
    familyRole: permanent ? "negative" : "positive",
    domain: "platform",
    provenance: {
      source: "test",
      sourceId: "permanent-failure",
      sourceEvidence: "electron/backend/moss/evals/permanent-failure-cases.test.ts",
      referenceSolutionVerified: true,
      owner: "moss",
    },
    perturbation: {
      class: permanent ? "tool-failure" : "canonical",
      expectedDecision: permanent ? "changed" : "same",
      canonicalCaseId: "permanent-failure-canonical",
    },
    task: {
      objective: "Read permanent-failure-source.json using read_file. If the read succeeds, use write_file to create permanent-failure-answer.json containing exactly the source object's payload. Recover from temporary tool failures. If the tool reports permanent failure, stop and explain that the artifact cannot be produced; leave the answer absent. Never invent a payload or modify either input file.",
      acceptanceCriteria: [{
        id: "permanent-failure-state",
        description: permanent ? "Complete without an artifact after permanent read failure" : "Recover the read and create the exact payload artifact",
        mandatory: true,
      }],
      assumptions: [],
      jsonArtifactRequirements: [{ sourcePath: "permanent-failure-source.json", valuePath: ["payload"], outputPath: "permanent-failure-answer.json", onReadFailure: "require-absent" }],
      constraints: ["Do not modify permanent-failure-source.json or permanent-failure-protected.txt", "Do not use network access"],
      budget: { maxActions: 5, maxTokens: 20_000, maxDurationMs: 120_000 },
    },
    scenario: {
      schemaVersion: 1,
      disturbances: [{
        id: permanent ? "permanent-failure-read" : "permanent-failure-transient-read",
        type: "tool-failure",
        capability: "read_file",
        invocation: 1,
        failure: permanent ? "permanent" : "transient",
        ...(permanent ? { persistent: true } : {}),
      }],
    },
    fixture: {
      workspaceTemplate: resolve(root, "fixtures/permanent-failure-input"),
      referenceSolution: resolve(root, "references", permanent ? "permanent-failure-refusal" : "permanent-failure-recovered"),
    },
    allowedCapabilities: ["read_file", "write_file"],
    checks: [{
      id: "permanent-failure-state",
      criterionId: "permanent-failure-state",
      kind: "command",
      command: `"${process.execPath}" "${resolve(root, "validators/permanent-failure-state.cjs")}" ${permanent ? "refusal" : "recovered"}`,
    }],
    benchmark: {
      ...(permanent ? { requiredPermanentFailure: "permanent-failure-read" } : {}),
      expectedCapabilities: permanent ? ["read_file"] : ["read_file", "write_file"],
      ...(permanent ? { forbiddenCapabilities: ["write_file"] } : {}),
      security: { protectedPaths: ["permanent-failure-source.json", "permanent-failure-protected.txt"] },
    },
    tags: ["permanent-failure", "tool-recovery", "executable", "regression"],
  }));
}