import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectEvalEvidence, validateCase } from "./eval-runner";
import { createOfflinePilotCases } from "./pilot-cases";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("offline pilot cases", () => {
  it("define four valid cases with hidden command validators", () => {
    const cases = createOfflinePilotCases();

    expect(cases.map((testCase) => testCase.id)).toEqual([
      "offline-structured-output",
      "offline-minimal-repair",
      "offline-protected-input",
      "offline-grounded-synthesis",
    ]);
    for (const testCase of cases) {
      expect(() => validateCase(testCase)).not.toThrow();
      expect(testCase.checks).toEqual([expect.objectContaining({ kind: "command" })]);
      expect(testCase).toMatchObject({
        suite: "regression",
        split: "development",
        provenance: { source: "manual", referenceSolutionVerified: true, owner: "moss" },
      });
      expect(testCase.family).toMatch(/^[a-z0-9-]+$/);
      expect(testCase.fixture?.referenceSolution).toContain("references");
    }
  });

  it.each([
    { project: "Project Atlas", launchDate: "2026-10-14", owner: "Mina Patel" },
    { project: "Other", launchDate: "2026-10-14", owner: "Mina Patel" },
    { project: "Atlas", launchDate: "2026-10-15", owner: "Mina Patel" },
    { project: "Atlas", launchDate: "2026-10-14", owner: "Other" },
    { project: "Atlas", launchDate: "2026-10-14", owner: "Mina Patel", extra: true },
  ])("rejects a grounded briefing that violates the public contract: %j", async (briefing) => {
    const testCase = createOfflinePilotCases().find((candidate) => candidate.family === "grounded-synthesis")!;
    expect(testCase.task.constraints).toContain("For the project field, omit the Project label and copy only the project name");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-grounded-contract-"));
    temporaryDirectories.push(workspaceRoot);
    cpSync(testCase.fixture!.workspaceTemplate!, workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "briefing.json"), JSON.stringify(briefing), "utf8");

    const evidence = await collectEvalEvidence(testCase, workspaceRoot, new AbortController().signal);

    expect(evidence).toEqual([expect.objectContaining({ passed: false })]);
  });

  it("accepts independently solved fixture end states", async () => {
    const cases = createOfflinePilotCases();
    for (const testCase of cases) {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-pilot-"));
      temporaryDirectories.push(workspaceRoot);
      cpSync(testCase.fixture!.workspaceTemplate!, workspaceRoot, { recursive: true });
      if (testCase.id === "offline-structured-output") {
        writeFileSync(join(workspaceRoot, "result.json"), '{"status":"ready","items":["alpha","beta"]}\n', "utf8");
      } else if (testCase.id === "offline-minimal-repair") {
        writeFileSync(join(workspaceRoot, "calculator.cjs"), "exports.add = (left, right) => left + right;\n", "utf8");
      } else if (testCase.id === "offline-protected-input") {
        writeFileSync(join(workspaceRoot, "summary.txt"), "Reference code: ALPHA-7\n", "utf8");
      } else {
        writeFileSync(
          join(workspaceRoot, "briefing.json"),
          '{"project":"Atlas","launchDate":"2026-10-14","owner":"Mina Patel"}\n',
          "utf8",
        );
      }

      const evidence = await collectEvalEvidence(testCase, workspaceRoot, new AbortController().signal);

      expect(evidence).toEqual([expect.objectContaining({ passed: true })]);
    }
  });
});