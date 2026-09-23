// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskSnapshot } from "@common/types";

import { RunCenter } from "./RunCenter";

const selectSession = vi.fn();
const refreshTaskRuns = vi.fn();
const run = vi.hoisted(() => ({
  value: null as TaskSnapshot | null,
}));

vi.mock("../lib/sessions", () => ({
  useSessions: () => ({
    currentId: "session-2",
    sessions: [{
      id: "session-1",
      title: "Background mission",
      messages: [],
      taskId: "task-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }),
  selectSession: (...args: unknown[]) => selectSession(...args),
}));

vi.mock("../lib/taskRuns", () => ({
  useTaskRuns: () => run.value ? [run.value] : [],
  refreshTaskRuns: (...args: unknown[]) => refreshTaskRuns(...args),
  isRunActive: (snapshot: TaskSnapshot | undefined) =>
    !!snapshot && !["completed", "failed", "cancelled"].includes(snapshot.state),
}));

function task(state: TaskSnapshot["state"]): TaskSnapshot {
  return {
    id: "task-1",
    state,
    revision: 1,
    spec: {
      objective: "Complete the durable mission",
      acceptanceCriteria: [],
      constraints: [],
      assumptions: [],
    },
    steps: [],
    evidence: [],
    attempts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
  };
}

beforeEach(() => {
  run.value = task("executing");
  selectSession.mockReset();
  refreshTaskRuns.mockReset();
  refreshTaskRuns.mockResolvedValue(undefined);
  Object.assign(window, {
    moss: {
      task: {
        cancel: vi.fn(async () => task("cancelled")),
        pause: vi.fn(async () => task("paused")),
      },
    },
  });
  URL.createObjectURL = vi.fn(() => "blob:run-diagnostics");
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(cleanup);

describe("RunCenter", () => {
  it("inspects the owning conversation without mutating the run", () => {
    const onClose = vi.fn();
    render(<RunCenter onClose={onClose} />);

    expect(screen.getByText("Background mission")).toBeDefined();
    expect(screen.getByText("executing")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));

    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts focused and closes on Escape", () => {
    const onClose = vi.fn();
    render(<RunCenter onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close run center" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels active runs through the durable task API", async () => {
    render(<RunCenter onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(window.moss.task.cancel).toHaveBeenCalledWith("task-1"));
    expect(refreshTaskRuns).toHaveBeenCalledOnce();
  });

  it("pauses executing runs through the durable task API", async () => {
    render(<RunCenter onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(window.moss.task.pause).toHaveBeenCalledWith("task-1", "Paused from Run center"));
    expect(refreshTaskRuns).toHaveBeenCalledOnce();
  });

  it("shows progress, budget, evidence, and artifact details", () => {
    const snapshot = task("executing");
    snapshot.spec.budget = { maxActions: 5, maxTokens: 1_000, maxCostUsd: 1 };
    snapshot.attempts = [{
      id: "attempt-1",
      startedAt: snapshot.createdAt,
      actionCount: 2,
      usage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.25,
    }];
    snapshot.steps = [{
      id: "step-1",
      description: "Verify the result",
      state: "executing",
      dependsOn: [],
      requiredCapabilities: [],
    }];
    snapshot.evidence = [{
      id: "evidence-1",
      criterionId: "criterion-1",
      kind: "command",
      passed: true,
      summary: "Passed",
      capturedAt: snapshot.updatedAt,
    }];
    snapshot.artifacts = [{
      id: "artifact-1",
      taskId: snapshot.id,
      planRevision: snapshot.revision,
      stepId: "step-1",
      attemptId: "attempt-1",
      name: "report",
      summary: "Report",
      sha256: "abc",
      byteLength: 3,
      createdAt: snapshot.updatedAt,
    }];
    run.value = snapshot;
    render(<RunCenter onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Run details"));
    expect(screen.getByText(/2\/5 actions/)).toBeDefined();
    expect(screen.getByText("1/1 passed")).toBeDefined();
    expect(screen.getByText("Verify the result")).toBeDefined();
  });

  it("routes blocked runs to their owning conversation for recovery", () => {
    run.value = task("blocked");
    const onClose = vi.fn();
    render(<RunCenter onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Review and resume" }));
    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("exports a sanitized run diagnostics file", () => {
    render(<RunCenter onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:run-diagnostics");
  });
});
