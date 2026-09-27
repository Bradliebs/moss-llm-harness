import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MissionWorkerResult, MissionWorkOrder } from "./mission-controller";
import { buildMissionVerificationChecks, WorkspaceMissionVerifier } from "./mission-verifier";
import { VerificationRegistry } from "../verify/verification-registry";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WorkspaceMissionVerifier", () => {
  it("fails closed when no deterministic workspace check exists", async () => {
    const workspaceRoot = temporaryWorkspace();
    const verifier = new WorkspaceMissionVerifier({ workspaceRoot });

    const evidence = await verifier.verify(order(), result(), new AbortController().signal);

    expect(evidence).toEqual([expect.objectContaining({ criterionId: "tests", passed: false })]);
    expect(evidence[0].summary).toContain("No deterministic workspace verification check");
  });

  describe("buildMissionVerificationChecks", () => {
    it("converts criterion bindings into host verification checks", () => {
      expect(buildMissionVerificationChecks({
        objective: "Build",
        acceptanceCriteria: [{
          id: "done",
          description: "Tests pass",
          mandatory: true,
          verification: { kind: "commands", commands: ["npm test"] },
        }],
        constraints: [],
        assumptions: [],
      }, { enabled: true, commands: ["npm test"] })).toEqual([{
        id: "done-command-1",
        criterionId: "done",
        kind: "command",
        command: "npm test",
      }]);
    });

    it("converts file and HTTP bindings without introducing commands", () => {
      expect(buildMissionVerificationChecks({
        objective: "Build",
        acceptanceCriteria: [
          {
            id: "artifact",
            description: "Artifact exists",
            mandatory: true,
            verification: { kind: "file-exists", path: "dist/report.json" },
          },
          {
            id: "content",
            description: "Artifact is complete",
            mandatory: true,
            verification: { kind: "file-contains", path: "dist/report.json", substring: "\"complete\": true" },
          },
          {
            id: "health",
            description: "Service is healthy",
            mandatory: true,
            verification: { kind: "http", url: "https://example.com/health", expectedStatus: 204 },
          },
        ],
        constraints: [],
        assumptions: [],
      }, undefined)).toEqual([
        { id: "artifact-file-exists", criterionId: "artifact", kind: "file-exists", path: "dist/report.json" },
        {
          id: "content-file-contains",
          criterionId: "content",
          kind: "file-contains",
          path: "dist/report.json",
          substring: "\"complete\": true",
        },
        {
          id: "health-http",
          criterionId: "health",
          kind: "http",
          url: "https://example.com/health",
          expectedStatus: 204,
        },
      ]);
    });

    it("rejects mandatory criteria without bindings and commands not enabled by the user", () => {
      const spec = {
        objective: "Build",
        acceptanceCriteria: [{ id: "done", description: "Tests pass", mandatory: true }],
        constraints: [],
        assumptions: [],
      };
      expect(() => buildMissionVerificationChecks(spec, undefined)).toThrow("requires a verification method");
      spec.acceptanceCriteria[0] = {
        ...spec.acceptanceCriteria[0],
        verification: { kind: "commands", commands: ["npm test"] },
      };
      expect(() => buildMissionVerificationChecks(spec, { enabled: false, commands: ["npm test"] }))
        .toThrow("not enabled in Settings");
    });
  });

  it("passes a criterion only when all explicitly bound host checks pass", async () => {
    const workspaceRoot = temporaryWorkspace({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
    const registry = new VerificationRegistry(false);
    registry.register("command", async () => ({ ok: true, summary: "passed" }));
    const verifier = new WorkspaceMissionVerifier({ workspaceRoot, registry, checks: [
      { id: "tests", criterionId: "tests", kind: "command", command: "npm test" },
      { id: "types", criterionId: "tests", kind: "command", command: "npm run typecheck" },
    ] });

    const evidence = await verifier.verify(order(), result(), new AbortController().signal);

    expect(evidence).toEqual([{ criterionId: "tests", kind: "command", passed: true, summary: "passed; passed" }]);
  });

  it("does not use a passing project test as evidence for a missing requested file", async () => {
    const workspaceRoot = temporaryWorkspace({ scripts: { test: "exit 0" } });
    const verifier = new WorkspaceMissionVerifier({ workspaceRoot });
    const workOrder = order();
    workOrder.acceptanceCriteria[0].description = "requested.txt exists and contains READY";
    expect((await verifier.verify(workOrder, result(), new AbortController().signal))[0].passed).toBe(false);
  });

  it("checks actual file content for a host-bound file criterion", async () => {
    const workspaceRoot = temporaryWorkspace();
    const verifier = new WorkspaceMissionVerifier({ workspaceRoot, checks: [
      { id: "content", criterionId: "tests", kind: "file-contains", path: "requested.txt", substring: "READY" },
    ] });
    expect((await verifier.verify(order(), result(), new AbortController().signal))[0].passed).toBe(false);
    writeFileSync(join(workspaceRoot, "requested.txt"), "READY");
    expect((await verifier.verify(order(), result(), new AbortController().signal))[0].passed).toBe(true);
  });
});

function temporaryWorkspace(pkg: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "moss-mission-verifier-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
  return dir;
}

function order(): MissionWorkOrder {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    planRevision: 1,
    attemptId: "attempt-1",
    objective: "Verify",
    constraints: [],
    assumptions: [],
    step: {
      id: "verify",
      description: "Verify",
      state: "running",
      dependsOn: [],
      requiredCapabilities: [],
      mission: {
        kind: "verify",
        workerRole: "verifier",
        executionLane: "exclusive",
        acceptanceCriterionIds: ["tests"],
        budget: {},
        expectedArtifacts: [],
      },
    },
    acceptanceCriteria: [{ id: "tests", description: "Tests pass", mandatory: true }],
    dependencyArtifacts: [],
    remainingTaskBudget: {},
  };
}

function result(): MissionWorkerResult {
  return { status: "succeeded", summary: "done", artifacts: [] };
}