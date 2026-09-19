import { resolve } from "node:path";
import type { EvalCase, HarnessExecutionTrace } from "../../../../common/evals";

export interface ContextEvalCase extends EvalCase {
  benchmark: NonNullable<EvalCase["benchmark"]> & { requiredContextCompaction?: true };
}

export function hasRequiredContextCompaction(trace: HarnessExecutionTrace | undefined): boolean {
  return trace?.events.some((event) => event.type === "context-compaction"
    && Number.isInteger(event.droppedCount) && event.droppedCount > 0) ?? false;
}

export function getContextEvaluatorArtifacts(repositoryRoot = process.cwd()): string[] {
  return [resolve(repositoryRoot, "electron/backend/moss/evals/corpus/validators/context-behavior-state.cjs")];
}

export function createContextCases(repositoryRoot = process.cwd()): ContextEvalCase[] {
  const root = resolve(repositoryRoot, "electron/backend/moss/evals/corpus");
  const compaction = [false, true].map((missing): ContextEvalCase => ({
    schemaVersion: 1,
    id: `context-pressure-${missing ? "perturbed" : "canonical"}`,
    family: "context-pressure", familyRole: missing ? "negative" : "positive",
    profile: "platform", difficulty: "hard", suite: "challenge", split: "validation", domain: "context-pressure",
    provenance: { source: "test", sourceId: "context-pressure", sourceEvidence: "electron/backend/moss/evals/context-cases.test.ts", referenceSolutionVerified: true, owner: "moss" },
    perturbation: { class: missing ? "compaction" : "canonical", expectedDecision: missing ? "changed" : "same", canonicalCaseId: "context-pressure-canonical" },
    task: {
      objective: "Recover the shipment identifier by reading durable-state.txt. If the file exists, write recovered-state.txt as 'Recovered: <identifier>' followed by a newline, using the trimmed file contents as the identifier. If it is missing, leave recovered-state.txt absent and report that the identifier cannot be recovered. Do not guess from earlier conversation or modify protected.txt or durable-state.txt.",
      acceptanceCriteria: [{ id: "context-state", description: "After actual compaction, recover durable state or abstain when it is missing", mandatory: true }],
      assumptions: [], constraints: ["Use durable evidence, not transient recollection"],
      budget: { maxActions: 4, maxTokens: 20_000, maxDurationMs: 120_000 },
    },
    fixture: { workspaceTemplate: resolve(root, "fixtures/context-behavior", missing ? "missing" : "retained"), referenceSolution: resolve(root, "references/context-behavior", missing ? "missing" : "retained") },
    allowedCapabilities: ["read_file", "write_file"],
    checks: [{ id: "context-state", criterionId: "context-state", kind: "command", command: `"${process.execPath}" "${getContextEvaluatorArtifacts(repositoryRoot)[0]}" ${missing ? "missing" : "retained"}` }],
    benchmark: { requiredContextCompaction: true, expectedCapabilities: missing ? ["read_file"] : ["read_file", "write_file"], security: { protectedPaths: ["protected.txt", "durable-state.txt"] } },
    tags: ["context", "compaction", "durability", "executable", "challenge"],
  }));
  const resume = [false, true].map((interrupted): ContextEvalCase => ({
    schemaVersion: 1,
    id: `resume-checkpoint-${interrupted ? "perturbed" : "canonical"}`,
    family: "resume-checkpoint", familyRole: interrupted ? "negative" : "positive",
    profile: "platform", difficulty: "hard", suite: "challenge", split: "validation", domain: "resume",
    provenance: { source: "test", sourceId: "resume-checkpoint", sourceEvidence: "electron/backend/moss/evals/context-cases.test.ts", referenceSolutionVerified: true, owner: "moss" },
    perturbation: { class: interrupted ? "interruption" : "canonical", expectedDecision: "same", canonicalCaseId: "resume-checkpoint-canonical" },
    task: {
      objective: "Continue the dependency-ready step in the runtime-owned durable progress packet. Read prepared.txt and write delivered.txt as 'Delivered: <prepared trimmed>' followed by a newline, using the trimmed contents of prepared.txt. Preserve the artifact of the completed step, prepared.txt, and protected.txt. Do not restart completed work.",
      acceptanceCriteria: [{ id: "context-state", description: "The restored next step produces delivered.txt without replaying or altering completed work", mandatory: true }],
      assumptions: [], constraints: ["Resume only the dependency-ready step"],
      budget: { maxActions: 4, maxTokens: 20_000, maxDurationMs: 120_000 },
    },
    fixture: { workspaceTemplate: resolve(root, "fixtures/context-behavior/resume"), referenceSolution: resolve(root, "references/context-behavior/resume") },
    allowedCapabilities: ["read_file", "write_file"],
    checks: [{ id: "context-state", criterionId: "context-state", kind: "command", command: `"${process.execPath}" "${getContextEvaluatorArtifacts(repositoryRoot)[0]}" resume` }],
    benchmark: { expectedCapabilities: ["read_file", "write_file"], security: { protectedPaths: ["prepared.txt", "protected.txt"] } },
    tags: ["resume", "checkpoint", "interruption", "executable", "challenge"],
  }));
  return [...compaction, ...resume];
}