// electron/backend/moss/task/task-engine.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEvidence, TaskMissionPlan, TaskSpec, TaskStep } from "../../../../common/types";
import { TaskEngine } from "./task-engine";
import { TaskStore } from "./task-store";

const SPEC: TaskSpec = {
  objective: "Implement and verify the change",
  acceptanceCriteria: [{ id: "tests", description: "Tests pass", mandatory: true }],
  constraints: [],
  assumptions: [],
};

const PLAN: TaskStep[] = [
  {
    id: "implement",
    description: "Implement the change",
    state: "pending",
    dependsOn: [],
    requiredCapabilities: ["workspace-edit"],
  },
];

describe("TaskEngine", () => {
  let dir: string;
  let store: TaskStore;
  let engine: TaskEngine;
  let now: Date;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-engine-"));
    store = new TaskStore(dir);
    now = new Date("2026-07-12T10:00:00.000Z");
    engine = new TaskEngine(store, { now: () => now });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires an objective and a mandatory completion criterion", async () => {
    await expect(engine.create({ ...SPEC, objective: " " }, "bad-1")).rejects.toThrow("objective");
    await expect(
      engine.create({ ...SPEC, acceptanceCriteria: [{ id: "optional", description: "Nice", mandatory: false }] }, "bad-2"),
    ).rejects.toThrow("mandatory acceptance criterion");
  });

  it("validates execution grants before persisting a task", async () => {
    await expect(engine.create({
      ...SPEC,
      budget: { maxActions: 2 },
      executionGrant: {
        schemaVersion: 1,
        authority: "policy-scoped",
        allowedCapabilities: ["edit_file"],
        maxAutoApprovedRisk: "mutating",
        budget: { maxActions: 3 },
        scopes: {},
      },
    }, "bad-grant")).rejects.toThrow("bounded by task limit 2");

    expect(await store.get("bad-grant")).toBeNull();
  });

  it("plans, executes, records an attempt, and completes only after verification", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1", "implement");
    await engine.recordUsage("task-1", attempt.id, { actions: 2, usage: { inputTokens: 5, outputTokens: 3 } });
    await engine.finishAttempt("task-1", attempt.id, "succeeded");
    await engine.beginVerification("task-1");

    await expect(engine.complete("task-1")).rejects.toThrow("Tests pass");
    const evidence: TaskEvidence = {
      id: "evidence-1",
      criterionId: "tests",
      kind: "command",
      passed: true,
      summary: "npm test passed",
      capturedAt: now.toISOString(),
      attemptId: attempt.id,
    };
    await engine.recordEvidence("task-1", evidence);
    const completed = await engine.complete("task-1");

    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.attempts[0]).toMatchObject({ outcome: "succeeded", actionCount: 2 });
    expect(completed.steps[0].state).toBe("completed");
  });

  it("uses only the newest evidence for each mandatory criterion", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.beginVerification("task-1");
    await engine.recordEvidence("task-1", {
      id: "pass",
      criterionId: "tests",
      kind: "command",
      passed: true,
      summary: "passed",
      capturedAt: "2026-07-12T10:00:00.000Z",
    });
    await engine.recordEvidence("task-1", {
      id: "fail",
      criterionId: "tests",
      kind: "command",
      passed: false,
      summary: "regressed",
      capturedAt: "2026-07-12T10:01:00.000Z",
    });

    await expect(engine.complete("task-1")).rejects.toThrow("Tests pass");
  });

  it("settles concurrent pause requests without a duplicate transition", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const executing = await engine.start("task-1");
    const transition = store.transition.bind(store);
    let arrivals = 0;
    let releaseTransitions!: () => void;
    const bothArrived = new Promise<void>((resolve) => { releaseTransitions = resolve; });
    const transitionSpy = vi.spyOn(store, "transition").mockImplementation(async (...args) => {
      arrivals += 1;
      if (arrivals === 2) releaseTransitions();
      await bothArrived;
      return transition(...args);
    });

    const results = await Promise.allSettled([
      engine.pause("task-1", "First worker interrupted"),
      engine.pause("task-1", "Second worker interrupted"),
    ]);
    transitionSpy.mockRestore();

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const paused = await store.get("task-1");
    expect(paused).toMatchObject({ state: "paused", revision: executing.revision + 1 });
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value).toEqual(paused);
    }
    expect(await engine.pause("task-1", "Repeated pause")).toEqual(paused);
  });

  it("propagates pause persistence failures when the task is not paused", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const executing = await engine.start("task-1");
    const failure = new Error("Task write failed");
    const transitionSpy = vi.spyOn(store, "transition").mockRejectedValueOnce(failure);

    await expect(engine.pause("task-1", "Interrupted")).rejects.toBe(failure);
    transitionSpy.mockRestore();

    expect(await store.get("task-1")).toEqual(executing);
  });

  it("does not turn a cancelled task into a successful pause", async () => {
    await engine.create(SPEC, "task-1");
    const cancelled = await engine.cancel("task-1");

    await expect(engine.pause("task-1", "Interrupted")).rejects.toThrow("Invalid task transition: cancelled -> paused");
    expect(await store.get("task-1")).toEqual(cancelled);
  });

  it("pauses when an action budget is reached", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 1 } }, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1");
    const paused = await engine.recordUsage("task-1", attempt.id, { actions: 1 });

    expect(paused.state).toBe("paused");
    expect(paused.blocker).toMatchObject({ kind: "budget", resumable: true });
  });

  it("rejects unknown attempt updates without changing the task revision", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const before = await store.get("task-1");

    await expect(engine.recordUsage("task-1", "missing", { actions: 1 })).rejects.toThrow("Unknown task attempt");
    await expect(engine.finishAttempt("task-1", "missing", "failed")).rejects.toThrow("Unknown task attempt");

    expect((await store.get("task-1"))?.revision).toBe(before?.revision);
  });

  it("rejects plans with missing dependencies", async () => {
    await engine.create(SPEC, "task-1");
    await expect(
      engine.setPlan("task-1", [{ ...PLAN[0], dependsOn: ["missing"] }]),
    ).rejects.toThrow("unknown dependency");
  });

  it("persists a validated versioned mission plan", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 2 } }, "task-1");
    const missionPlan: TaskMissionPlan = {
      schemaVersion: 1,
      revision: 1,
      steps: [{
        ...PLAN[0],
        requiredCapabilities: ["edit_file"],
        mission: {
          kind: "implement",
          workerRole: "implementer",
          executionLane: "exclusive",
          acceptanceCriterionIds: ["tests"],
          budget: { maxActions: 2 },
          expectedArtifacts: ["changed-files"],
        },
      }],
    };

    const planned = await engine.setMissionPlan("task-1", missionPlan, [{ id: "edit_file", risk: "mutating" }]);

    expect(planned.state).toBe("planning");
    expect(planned.missionPlan).toEqual(missionPlan);
    expect((await new TaskStore(dir).get("task-1"))?.missionPlan).toEqual(missionPlan);
  });

  it("records only artifacts tied to the current mission step attempt", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 2 } }, "task-1");
    await engine.setMissionPlan("task-1", {
      schemaVersion: 1,
      revision: 1,
      steps: [{
        ...PLAN[0],
        requiredCapabilities: ["edit_file"],
        mission: {
          kind: "implement",
          workerRole: "implementer",
          executionLane: "exclusive",
          acceptanceCriterionIds: ["tests"],
          budget: { maxActions: 2 },
          expectedArtifacts: ["changed-files"],
        },
      }],
    }, [{ id: "edit_file", risk: "mutating" }]);
    const { attempt } = await engine.beginAttempt("task-1", "implement");
    const artifact = {
      id: "artifact-1",
      taskId: "task-1",
      planRevision: 1,
      stepId: "implement",
      attemptId: attempt.id,
      name: "changed-files",
      summary: "Changed one file",
      sha256: "a".repeat(64),
      byteLength: 16,
      createdAt: now.toISOString(),
    };

    const updated = await engine.recordArtifact("task-1", artifact);
    expect(updated.artifacts).toEqual([artifact]);
    await expect(engine.recordArtifact("task-1", { ...artifact, attemptId: "missing" })).rejects.toThrow("does not belong");
    await expect(engine.recordArtifact("task-1", { ...artifact, planRevision: 2 })).rejects.toThrow("not current");
  });

  it("replaces only unresolved mission work and invalidates its evidence and artifacts", async () => {
    await engine.create(SPEC, "task-1");
    const initial: TaskMissionPlan = {
      schemaVersion: 1,
      revision: 1,
      steps: [
        {
          id: "inspect",
          description: "Inspect the current state",
          state: "pending",
          dependsOn: [],
          requiredCapabilities: ["read_file"],
          mission: {
            kind: "research",
            workerRole: "researcher",
            executionLane: "readonly-parallel",
            acceptanceCriterionIds: ["tests"],
            budget: {},
            expectedArtifacts: ["findings"],
          },
        },
        {
          id: "implement",
          description: "Implement the original approach",
          state: "pending",
          dependsOn: ["inspect"],
          requiredCapabilities: ["read_file"],
          mission: {
            kind: "implement",
            workerRole: "implementer",
            executionLane: "readonly-parallel",
            acceptanceCriterionIds: [],
            budget: {},
            expectedArtifacts: ["change"],
          },
        },
      ],
    };
    const capabilities = [{ id: "read_file", risk: "readonly" as const }];
    await engine.setMissionPlan("task-1", initial, capabilities);
    const completedAttempt = (await engine.beginAttempt("task-1", "inspect")).attempt;
    await engine.recordEvidence("task-1", {
      id: "accepted-evidence",
      criterionId: "tests",
      kind: "file",
      passed: true,
      summary: "Inspection passed",
      capturedAt: now.toISOString(),
      attemptId: completedAttempt.id,
    });
    await engine.recordArtifact("task-1", {
      id: "accepted-artifact",
      taskId: "task-1",
      planRevision: 1,
      stepId: "inspect",
      attemptId: completedAttempt.id,
      name: "findings",
      summary: "Accepted findings",
      sha256: "a".repeat(64),
      byteLength: 10,
      createdAt: now.toISOString(),
    });
    await engine.finishAttempt("task-1", completedAttempt.id, "succeeded");
    const failedAttempt = (await engine.beginAttempt("task-1", "implement")).attempt;
    await engine.recordEvidence("task-1", {
      id: "stale-evidence",
      criterionId: "tests",
      kind: "model-review",
      passed: false,
      summary: "Original approach failed",
      capturedAt: now.toISOString(),
      attemptId: failedAttempt.id,
    });
    await engine.recordArtifact("task-1", {
      id: "stale-artifact",
      taskId: "task-1",
      planRevision: 1,
      stepId: "implement",
      attemptId: failedAttempt.id,
      name: "change",
      summary: "Rejected change",
      sha256: "b".repeat(64),
      byteLength: 10,
      createdAt: now.toISOString(),
    });
    await engine.finishAttempt("task-1", failedAttempt.id, "failed", "Original approach failed");

    const replacement: TaskMissionPlan = {
      schemaVersion: 1,
      revision: 2,
      supersedesRevision: 1,
      revisionReason: "Original approach failed",
      steps: [
        structuredClone(initial.steps[0]),
        {
          ...structuredClone(initial.steps[1]),
          id: "review",
          description: "Review an alternate approach",
          mission: { ...structuredClone(initial.steps[1].mission!), kind: "review", workerRole: "reviewer", expectedArtifacts: ["review"] },
        },
      ],
    };
    const tampered = structuredClone(replacement);
    tampered.steps[0].description = "Rewrite completed history";
    await expect(engine.replaceMissionPlan("task-1", tampered, capabilities)).rejects.toThrow("structurally identical");

    const replanned = await engine.replaceMissionPlan("task-1", replacement, capabilities);
    expect(replanned.missionPlan?.revision).toBe(2);
    expect(replanned.steps.map((step) => [step.id, step.state])).toEqual([["inspect", "completed"], ["review", "pending"]]);
    expect(replanned.evidence.map((item) => item.id)).toEqual(["accepted-evidence"]);
    expect(replanned.artifacts?.map((item) => item.id)).toEqual(["accepted-artifact"]);
    expect(replanned.attempts.map((attempt) => attempt.id)).toEqual([completedAttempt.id, failedAttempt.id]);
  });

  it("rejects an attempt whose step dependencies are incomplete", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", [
      ...PLAN,
      {
        id: "verify",
        description: "Verify the change",
        state: "pending",
        dependsOn: ["implement"],
        requiredCapabilities: [],
      },
    ]);

    await expect(engine.beginAttempt("task-1", "verify")).rejects.toThrow("incomplete dependencies");
  });

  it("rejects restarting a completed step", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    const { attempt } = await engine.beginAttempt("task-1", "implement");
    await engine.finishAttempt("task-1", attempt.id, "succeeded");

    await expect(engine.beginAttempt("task-1", "implement")).rejects.toThrow("not eligible");
  });

  it("recovers active tasks as paused without replaying work", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");

    const recovered = await engine.recoverInterruptedTasks();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe("paused");
    expect(recovered[0].blocker?.summary).toContain("interrupted");
  });

  it("persists approval waiting and only resumes after the matching decision", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");

    const waiting = await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "write_file",
      arguments: '{"path":"result.txt"}',
      risk: "mutating",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    expect(waiting.state).toBe("waiting_for_approval");
    expect((await new TaskStore(dir).get("task-1"))?.approval).toEqual(waiting.approval);
    await expect(engine.start("task-1")).rejects.toThrow("pending approval");
    await expect(engine.resolveApproval("task-1", "other-call", true)).rejects.toThrow("does not match");

    now = new Date("2026-07-12T10:01:00.000Z");
    const resolved = await engine.resolveApproval("task-1", "call-1", true, "Reviewed");
    expect(resolved).toMatchObject({
      state: "executing",
      approval: {
        callId: "call-1",
        status: "approved",
        comment: "Reviewed",
        respondedAt: now.toISOString(),
      },
    });
  });

  it("interrupts a pending approval on restart without replaying it", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "run_command",
      arguments: '{"command":"npm test"}',
      risk: "mutating",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    now = new Date("2026-07-12T10:02:00.000Z");
    const [recovered] = await engine.recoverInterruptedTasks();

    expect(recovered).toMatchObject({
      state: "paused",
      approval: {
        callId: "call-1",
        status: "interrupted",
        respondedAt: now.toISOString(),
      },
      blocker: { kind: "approval", resumable: true },
    });
    expect(recovered.blocker?.summary).toContain("not executed");
  });

  it("interrupts a matching pending approval when its renderer disappears", async () => {
    await engine.create(SPEC, "task-1");
    await engine.setPlan("task-1", PLAN);
    await engine.start("task-1");
    await engine.requestApproval("task-1", {
      taskId: "task-1",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "write_file",
      arguments: "{}",
      status: "pending",
      requestedAt: now.toISOString(),
    });

    await expect(engine.interruptApproval("task-1", "other-call", "Renderer closed")).rejects.toThrow("does not match");
    now = new Date("2026-07-12T10:03:00.000Z");
    const interrupted = await engine.interruptApproval("task-1", "call-1", "Renderer closed");

    expect(interrupted).toMatchObject({
      state: "paused",
      approval: {
        callId: "call-1",
        status: "interrupted",
        comment: "Renderer closed",
        respondedAt: now.toISOString(),
      },
      blocker: { kind: "approval", resumable: true },
    });
  });

  it("cancels non-terminal tasks idempotently", async () => {
    await engine.create(SPEC, "task-1");
    const cancelled = await engine.cancel("task-1");
    expect(cancelled.state).toBe("cancelled");
    expect(await engine.cancel("task-1")).toEqual(cancelled);
  });
});