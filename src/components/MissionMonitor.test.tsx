// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskSnapshot } from "@common/types";

import { MissionMonitor, blockerRecovery, budgetWarnings } from "./MissionMonitor";

function taskSnapshot(state: TaskSnapshot["state"]): TaskSnapshot {
  return {
    id: "task-1",
    revision: 3,
    state,
    spec: {
      objective: "Complete the durable task",
      acceptanceCriteria: [{ id: "outcome", description: "Requested outcome", mandatory: true }],
      constraints: [],
      assumptions: [],
      budget: { maxActions: 10, maxTokens: 10_000, maxCostUsd: 2, maxDurationMs: 600_000 },
    },
    steps: [{
      id: "implement",
      description: "Apply the verified change",
      state: "running",
      dependsOn: [],
      requiredCapabilities: ["write_file"],
    }],
    attempts: [{
      id: "attempt-1",
      stepId: "implement",
      startedAt: "2026-01-01T00:00:00.000Z",
      actionCount: 4,
      usage: { inputTokens: 2_000, outputTokens: 1_000 },
      estimatedCostUsd: 0.5,
    }],
    evidence: [{
      id: "evidence-1",
      criterionId: "outcome",
      kind: "command",
      passed: true,
      summary: "Focused tests passed",
      capturedAt: "2026-01-01T00:05:00.000Z",
    }],
    artifacts: [{
      id: "artifact-1",
      taskId: "task-1",
      planRevision: 3,
      stepId: "implement",
      attemptId: "attempt-1",
      name: "change-summary",
      summary: "Verified source update",
      sha256: "a".repeat(64),
      byteLength: 42,
      createdAt: "2026-01-01T00:05:00.000Z",
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
  };
}

afterEach(cleanup);

describe("MissionMonitor", () => {
  it("renders status, remaining budgets, details, history, and delegates actions", () => {
    const onResume = vi.fn();
    const onCancel = vi.fn();
    const onOpenArtifact = vi.fn();
    const task = taskSnapshot("paused");

    render(
      <MissionMonitor
        task={task}
        history={[{
          id: "event-1",
          taskId: task.id,
          revision: task.revision,
          sequence: 0,
          occurredAt: task.updatedAt,
          kind: "paused",
          summary: "Task paused",
        }]}
        onRecover={vi.fn()}
        onResume={onResume}
        onCancel={onCancel}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    expect(screen.getByLabelText("Task status").textContent).toContain("Apply the verified change");
    expect(screen.getByLabelText("Remaining mission budget").textContent).toContain("6 actions left");
    expect(screen.getByLabelText("Remaining mission budget").textContent).toContain("7,000 tokens left");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "change-summary" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact-1");
    expect(screen.getByText("Timeline (1)")).toBeDefined();
  });

  it("labels blocker recovery and suppresses unsafe resume", () => {
    const onRecover = vi.fn();
    const task = taskSnapshot("blocked");
    task.blocker = {
      kind: "verification",
      summary: "Tests failed",
      resumable: true,
      createdAt: task.updatedAt,
    };

    render(
      <MissionMonitor
        task={task}
        history={[]}
        onRecover={onRecover}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit verification" }));
    expect(onRecover).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(blockerRecovery("credential")).toEqual({ label: "Configure credentials", action: "settings" });
  });

  it("warns when a budget reaches 80 percent while the mission can still act", () => {
    const task = taskSnapshot("executing");
    task.attempts[0].actionCount = 9;
    expect(budgetWarnings(task)).toEqual(["90% of the actions budget used"]);
    expect(budgetWarnings({ ...task, state: "completed" })).toEqual([]);

    render(
      <MissionMonitor task={task} history={[]} onRecover={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onOpenArtifact={vi.fn()} />,
    );
    expect(screen.getByLabelText("Budget warning").textContent).toContain("90% of the actions budget used");
  });
});
