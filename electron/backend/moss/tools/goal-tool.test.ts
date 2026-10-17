// electron/backend/moss/tools/goal-tool.test.ts

import { describe, expect, it } from "vitest";

import type { CompletionContext } from "../agent-runner";
import { createGoalTracker, FINISH_GOAL_TOOL } from "./goal-tool";

const context = {} as CompletionContext;
const signal = new AbortController().signal;

describe("createGoalTracker", () => {
  it("sends the model back to work until it says the goal is done", async () => {
    const goal = createGoalTracker();
    const first = goal.guard(context);
    expect(first.accept).toBe(false);
    expect(first.feedback).toContain(FINISH_GOAL_TOOL);
    const result = await goal.tool.execute({ status: "done", summary: "Built and tested." }, { workspaceRoot: "", signal });
    expect(result.ok).toBe(true);
    expect(goal.status()).toBe("done");
    expect(goal.guard(context).accept).toBe(true);
  });

  it("stops when the model is blocked", async () => {
    const goal = createGoalTracker();
    await goal.tool.execute({ status: "blocked" }, { workspaceRoot: "", signal });
    expect(goal.guard(context).accept).toBe(true);
    expect(goal.continuations()).toBe(0);
  });

  it("gives up after its reminders, so a model that never calls the tool still stops", () => {
    const goal = createGoalTracker(2);
    expect([goal.guard(context).accept, goal.guard(context).accept, goal.guard(context).accept]).toEqual([false, false, true]);
    expect(goal.status()).toBeUndefined();
  });

  it("refuses a status other than done or blocked", async () => {
    const goal = createGoalTracker();
    expect((await goal.tool.execute({ status: "maybe" }, { workspaceRoot: "", signal })).ok).toBe(false);
    expect(goal.status()).toBeUndefined();
  });
});
