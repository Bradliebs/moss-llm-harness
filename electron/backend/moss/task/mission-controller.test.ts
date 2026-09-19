import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskMissionPlan, TaskSpec } from "../../../../common/types";
import { MissionController, type MissionWorkOrder } from "./mission-controller";
import type { MissionPlanGenerator, MissionReplanContext } from "./mission-planner";
import { TaskArtifactStore } from "./task-artifact-store";
import { TaskEngine } from "./task-engine";
import { TaskStore } from "./task-store";

const SPEC: TaskSpec = {
  objective: "Research, then verify",
  acceptanceCriteria: [{ id: "verified", description: "Result is verified", mandatory: true }],
  constraints: [],
  assumptions: [],
  budget: { maxActions: 4 },
};

function missionPlan(): TaskMissionPlan {
  return {
    schemaVersion: 1,
    revision: 1,
    steps: [
      {
        id: "research",
        description: "Research the issue",
        state: "pending",
        dependsOn: [],
        requiredCapabilities: ["read_file"],
        mission: {
          kind: "research",
          workerRole: "researcher",
          executionLane: "readonly-parallel",
          acceptanceCriterionIds: [],
          budget: { maxActions: 2 },
          expectedArtifacts: ["findings"],
        },
      },
      {
        id: "verify",
        description: "Verify the findings",
        state: "pending",
        dependsOn: ["research"],
        requiredCapabilities: ["read_file"],
        mission: {
          kind: "verify",
          workerRole: "verifier",
          executionLane: "readonly-parallel",
          acceptanceCriterionIds: ["verified"],
          budget: { maxActions: 2 },
          expectedArtifacts: ["report"],
        },
      },
    ],
  };
}

describe("MissionController", () => {
  let dir: string;
  let store: TaskStore;
  let engine: TaskEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-controller-"));
    store = new TaskStore(dir);
    engine = new TaskEngine(store, { now: () => new Date("2026-08-23T12:00:00.000Z") });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("plans and serially executes dependency-ready steps with verifier-owned evidence", async () => {
    await engine.create(SPEC, "task-1");
    const orders: MissionWorkOrder[] = [];
    const controller = createController({
      planner: planned(missionPlan()),
      execute: async (order) => {
        orders.push(structuredClone(order));
        return {
          result: {
            status: "succeeded",
            summary: `${order.step.id} done`,
            artifacts: [{
              name: order.step.id === "research" ? "findings" : "report",
              summary: `${order.step.id} artifact`,
              content: `${order.step.id} content`,
            }],
          },
          usage: { actions: 1, usage: { inputTokens: 2, outputTokens: 1 } },
        };
      },
      verify: async (order) => order.step.id === "verify"
        ? [{ criterionId: "verified", kind: "command", passed: true, summary: "deterministic check passed" }]
        : [],
    });

    const completed = await controller.run("task-1", new AbortController().signal);

    expect(completed.state).toBe("completed");
    expect(completed.steps.map((step) => step.state)).toEqual(["completed", "completed"]);
    expect(completed.attempts).toHaveLength(2);
    expect(completed.artifacts?.map((artifact) => artifact.name)).toEqual(["findings", "report"]);
    expect(completed.evidence).toMatchObject([{ criterionId: "verified", passed: true, summary: "deterministic check passed" }]);
    expect(orders.map((order) => order.step.id)).toEqual(["research", "verify"]);
    expect(orders[0].dependencyArtifacts).toEqual([]);
    expect(orders[1].dependencyArtifacts.map((artifact) => artifact.name)).toEqual(["findings"]);
  });

  it("blocks intake when planning requires a user decision", async () => {
    await engine.create(SPEC, "task-1");
    const controller = createController({
      planner: {
        async plan() {
          return {
            kind: "blocked",
            attempts: 1,
            blocker: {
              kind: "user-decision",
              summary: "Choose a target",
              resumable: true,
              createdAt: "2026-08-23T12:00:00.000Z",
            },
          };
        },
      },
    });

    await expect(controller.run("task-1", new AbortController().signal)).resolves.toMatchObject({
      state: "blocked",
      blocker: { kind: "user-decision", summary: "Choose a target" },
    });
  });

  it("does not admit a dependent step after a worker failure", async () => {
    await engine.create(SPEC, "task-1");
    const executed: string[] = [];
    const controller = createController({
      planner: planned(missionPlan()),
      execute: async (order) => {
        executed.push(order.step.id);
        return { result: { status: "failed", summary: "research failed", artifacts: [] } };
      },
    });

    const blocked = await controller.run("task-1", new AbortController().signal);

    expect(blocked).toMatchObject({ state: "blocked", blocker: { summary: "research failed" } });
    expect(blocked.steps.map((step) => step.state)).toEqual(["failed", "pending"]);
    expect(executed).toEqual(["research"]);
  });

  it("replans one recoverable failure without repeating completed work", async () => {
    await engine.create(SPEC, "task-1");
    const replacement = missionPlan();
    replacement.revision = 2;
    replacement.supersedesRevision = 1;
    replacement.revisionReason = "Verifier worker failed";
    replacement.steps[1] = {
      ...replacement.steps[1],
      id: "verify-retry",
      description: "Verify with the alternate approach",
      dependsOn: ["research"],
    };
    let replanContext: MissionReplanContext | undefined;
    const planner: MissionPlanGenerator = {
      async plan() { return { kind: "planned", plan: missionPlan(), attempts: 1 }; },
      async replan(_spec, context) {
        replanContext = structuredClone(context);
        return { kind: "planned", plan: replacement, attempts: 1 };
      },
    };
    const executed: string[] = [];
    const controller = createController({
      planner,
      execute: async (order) => {
        executed.push(order.step.id);
        if (order.step.id === "verify") {
          return { result: { status: "failed", summary: "Verifier worker failed", artifacts: [] } };
        }
        return {
          result: {
            status: "succeeded",
            summary: "done",
            artifacts: [{
              name: order.step.id === "research" ? "findings" : "report",
              summary: "accepted",
              content: "accepted",
            }],
          },
          usage: { actions: 1 },
        };
      },
      verify: async (order) => order.step.id === "verify-retry"
        ? [{ criterionId: "verified", kind: "command", passed: true, summary: "alternate verification passed" }]
        : [],
    });

    const completed = await controller.run("task-1", new AbortController().signal);

    expect(completed.state).toBe("completed");
    expect(completed.missionPlan).toMatchObject({ revision: 2, supersedesRevision: 1 });
    expect(executed).toEqual(["research", "verify", "verify-retry"]);
    expect(replanContext?.completedSteps.map((step) => step.id)).toEqual(["research"]);
    expect(replanContext?.failures).toEqual([{ stepId: "verify", error: "Verifier worker failed" }]);
    expect(completed.artifacts?.map((artifact) => artifact.name)).toEqual(["findings", "report"]);
  });

  it("preserves a budget pause after the active worker settles", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 2 } }, "task-1");
    const plan = missionPlan();
    plan.steps[0].mission!.budget.maxActions = 1;
    plan.steps[1].mission!.budget.maxActions = 1;
    const controller = createController({
      planner: planned(plan),
      execute: async () => ({
        result: {
          status: "succeeded",
          summary: "research done",
          artifacts: [{ name: "findings", summary: "findings", content: "content" }],
        },
        usage: { actions: 2 },
      }),
    });

    const paused = await controller.run("task-1", new AbortController().signal);

    expect(paused).toMatchObject({ state: "paused", blocker: { kind: "budget" } });
    expect(paused.steps.map((step) => step.state)).toEqual(["completed", "pending"]);
  });

  it("rejects a concurrent controller run before duplicate work starts", async () => {
    await engine.create(SPEC, "task-1");
    let releaseWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const controller = createController({
      planner: planned(missionPlan()),
      execute: async (order) => {
        notifyStarted();
        await workerStarted;
        return {
          result: {
            status: "succeeded",
            summary: "done",
            artifacts: [{ name: order.step.id === "research" ? "findings" : "report", summary: "done", content: "done" }],
          },
        };
      },
      verify: async (order) => order.step.id === "verify"
        ? [{ criterionId: "verified", kind: "command", passed: true, summary: "passed" }]
        : [],
    });
    const first = controller.run("task-1", new AbortController().signal);
    await started;

    await expect(createController().run("task-1", new AbortController().signal)).rejects.toThrow("already leased");
    releaseWorker();
    await expect(first).resolves.toMatchObject({ state: "completed" });
  });

  it("runs independent readonly steps in parallel and settles them before exclusive work", async () => {
    await engine.create(SPEC, "task-1");
    const parallelPlan: TaskMissionPlan = {
      schemaVersion: 1,
      revision: 1,
      steps: [
        {
          id: "research-a",
          description: "Research A",
          state: "pending",
          dependsOn: [],
          requiredCapabilities: ["read_file"],
          mission: {
            kind: "research",
            workerRole: "researcher",
            executionLane: "readonly-parallel",
            acceptanceCriterionIds: [],
            budget: { maxActions: 1 },
            expectedArtifacts: ["findings-a"],
          },
        },
        {
          id: "research-b",
          description: "Research B",
          state: "pending",
          dependsOn: [],
          requiredCapabilities: ["read_file"],
          mission: {
            kind: "research",
            workerRole: "researcher",
            executionLane: "readonly-parallel",
            acceptanceCriterionIds: [],
            budget: { maxActions: 1 },
            expectedArtifacts: ["findings-b"],
          },
        },
        {
          id: "verify",
          description: "Verify both findings",
          state: "pending",
          dependsOn: ["research-a", "research-b"],
          requiredCapabilities: ["read_file"],
          mission: {
            kind: "verify",
            workerRole: "verifier",
            executionLane: "exclusive",
            acceptanceCriterionIds: ["verified"],
            budget: { maxActions: 2 },
            expectedArtifacts: ["report"],
          },
        },
      ],
    };
    let active = 0;
    let maxActive = 0;
    let readonlyStarted = 0;
    let notifyBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { notifyBothStarted = resolve; });
    let releaseReadonly!: () => void;
    const readonlyRelease = new Promise<void>((resolve) => { releaseReadonly = resolve; });
    const executed: string[] = [];
    const controller = createController({
      planner: planned(parallelPlan),
      execute: async (order) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        executed.push(order.step.id);
        try {
          if (order.step.mission?.executionLane === "readonly-parallel") {
            readonlyStarted += 1;
            if (readonlyStarted === 2) notifyBothStarted();
            await readonlyRelease;
          } else {
            expect(active).toBe(1);
          }
          const name = order.step.id === "research-a"
            ? "findings-a"
            : order.step.id === "research-b"
              ? "findings-b"
              : "report";
          return {
            result: {
              status: "succeeded",
              summary: `${order.step.id} done`,
              artifacts: [{ name, summary: `${name} accepted`, content: name }],
            },
            usage: { actions: 1 },
          };
        } finally {
          active -= 1;
        }
      },
      verify: async (order) => order.step.id === "verify"
        ? [{ criterionId: "verified", kind: "command", passed: true, summary: "both findings verified" }]
        : [],
    });

    const running = controller.run("task-1", new AbortController().signal);
    await bothStarted;
    const leased = await store.get("task-1");
    expect(leased?.steps.slice(0, 2).map((step) => step.state)).toEqual(["running", "running"]);
    expect(new Set(leased?.steps.slice(0, 2).map((step) => step.lease?.ownerId)).size).toBe(2);
    expect(leased?.steps[2].state).toBe("pending");
    releaseReadonly();

    const completed = await running;
    expect(completed.state).toBe("completed");
    expect(maxActive).toBe(2);
    expect(executed.slice(0, 2).sort()).toEqual(["research-a", "research-b"]);
    expect(executed[2]).toBe("verify");
    expect(completed.steps.every((step) => !step.lease)).toBe(true);
  });

  it.each(["resolve", "reject"])("stops admission on abort and settles active readonly workers as interrupted when they %s", async (settlement) => {
    await engine.create(SPEC, "task-1");
    const plan: TaskMissionPlan = {
      schemaVersion: 1,
      revision: 1,
      steps: [
        ...missionPlan().steps.slice(0, 1).map((step) => ({ ...structuredClone(step), id: "read-a", mission: { ...structuredClone(step.mission!), budget: { maxActions: 1 } } })),
        ...missionPlan().steps.slice(0, 1).map((step) => ({ ...structuredClone(step), id: "read-b", mission: { ...structuredClone(step.mission!), budget: { maxActions: 1 } } })),
        {
          ...structuredClone(missionPlan().steps[1]),
          id: "exclusive-verify",
          dependsOn: ["read-a", "read-b"],
          mission: { ...structuredClone(missionPlan().steps[1].mission!), executionLane: "exclusive" },
        },
      ],
    };
    let started = 0;
    let notifyBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { notifyBothStarted = resolve; });
    let releaseWorkers!: () => void;
    const workersReleased = new Promise<void>((resolve) => { releaseWorkers = resolve; });
    const executed: string[] = [];
    const controller = createController({
      planner: planned(plan),
      execute: async (order) => {
        executed.push(order.step.id);
        started += 1;
        if (started === 2) notifyBothStarted();
        await workersReleased;
        if (settlement === "reject") throw new Error("Worker aborted");
        return {
          result: {
            status: "succeeded",
            summary: "settled",
            artifacts: [{ name: "findings", summary: "settled", content: "settled" }],
          },
        };
      },
    });
    const abortController = new AbortController();
    const running = controller.run("task-1", abortController.signal);
    await bothStarted;
    abortController.abort();
    releaseWorkers();

    const paused = await running;
    expect(paused.state).toBe("paused");
    expect(paused.steps.map((step) => step.state)).toEqual(["failed", "failed", "pending"]);
    expect(paused.attempts.map((attempt) => attempt.outcome)).toEqual(["interrupted", "interrupted"]);
    expect(paused.steps.every((step) => !step.lease)).toBe(true);
    expect(executed.sort()).toEqual(["read-a", "read-b"]);
  });

  it("does not publish artifacts from a verification-failed attempt", async () => {
    await engine.create(SPEC, "task-1");
    const plan = missionPlan();
    plan.steps[0].mission!.acceptanceCriterionIds = ["verified"];
    plan.steps[1].mission!.acceptanceCriterionIds = [];
    const controller = createController({
      planner: planned(plan),
      execute: async () => ({
        result: {
          status: "succeeded",
          summary: "unverified",
          artifacts: [{ name: "findings", summary: "bad", content: "rejected content" }],
        },
      }),
      verify: async () => [{ criterionId: "verified", kind: "model-review", passed: false, summary: "rejected" }],
    });

    const blocked = await controller.run("task-1", new AbortController().signal);

    expect(blocked).toMatchObject({ state: "blocked", blocker: { kind: "verification" } });
    expect(blocked.artifacts).toBeUndefined();
  });

  it("can complete without another action after the final step reaches the exact budget", async () => {
    await engine.create({ ...SPEC, budget: { maxActions: 1 } }, "task-1");
    const plan = missionPlan();
    plan.steps = [plan.steps[1]];
    plan.steps[0].dependsOn = [];
    plan.steps[0].mission!.budget.maxActions = 1;
    const controller = createController({
      planner: planned(plan),
      execute: async () => ({
        result: {
          status: "succeeded",
          summary: "verified",
          artifacts: [{ name: "report", summary: "report", content: "report" }],
        },
        usage: { actions: 1 },
      }),
      verify: async () => [{ criterionId: "verified", kind: "command", passed: true, summary: "passed" }],
    });

    await expect(controller.run("task-1", new AbortController().signal)).resolves.toMatchObject({ state: "completed" });
  });

  function createController(overrides: {
    planner?: MissionPlanGenerator;
    execute?: (order: MissionWorkOrder) => Promise<unknown>;
    verify?: (order: MissionWorkOrder) => Promise<unknown>;
  } = {}): MissionController {
    return new MissionController({
      engine,
      store,
      artifactStore: new TaskArtifactStore(dir),
      planner: overrides.planner ?? planned(missionPlan()),
      capabilities: [{ id: "read_file", risk: "readonly" }],
      worker: { execute: overrides.execute ?? (async () => ({ result: { status: "failed", summary: "not configured", artifacts: [] } })) },
      verifier: { verify: overrides.verify ?? (async () => []) },
      now: () => new Date("2026-08-23T12:00:00.000Z"),
    });
  }
});

function planned(plan: TaskMissionPlan): MissionPlanGenerator {
  return { async plan() { return { kind: "planned", plan: structuredClone(plan), attempts: 1 }; } };
}