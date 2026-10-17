// electron/backend/moss/tools/goal-tool.ts
//
// "Keep going until done": in goal mode a chat turn does not end when the model
// stops. It ends when the model says the goal is done or that it is blocked,
// through finish_goal, or after a few reminders, so a model that never calls
// the tool still stops.

import type { CompletionContext, CompletionDecision } from "../agent-runner";
import type { Tool } from "./types";

export const FINISH_GOAL_TOOL = "finish_goal";

/** How many times a model that stops without finish_goal is sent back to work. */
export const MAX_GOAL_CONTINUATIONS = 3;

export const GOAL_MODE_NOTE = [
  "Goal mode is on: keep working until the user's request is fully done and checked, without stopping to ask whether to continue.",
  `When it is done, call ${FINISH_GOAL_TOOL} with status "done", then tell the user what you did and how you checked it.`,
  `If you cannot go on without the user (a decision, access, or information only they have), call ${FINISH_GOAL_TOOL} with status "blocked" and say what you need.`,
].join("\n");

const CONTINUE = `You stopped, but goal mode is on and you have not called ${FINISH_GOAL_TOOL}. If the request is fully done and checked, call ${FINISH_GOAL_TOOL} with status "done". If you cannot go on without the user, call it with status "blocked" and say what you need. Otherwise continue with the next step now.`;

export type GoalStatus = "done" | "blocked";

export interface GoalTracker {
  tool: Tool;
  /** completion guard for runTurn: sends the model back until it finishes the goal */
  guard: (context: CompletionContext) => CompletionDecision;
  status(): GoalStatus | undefined;
  continuations(): number;
}

export function createGoalTracker(maxContinuations = MAX_GOAL_CONTINUATIONS): GoalTracker {
  let status: GoalStatus | undefined;
  let continuations = 0;
  const tool: Tool = {
    name: FINISH_GOAL_TOOL,
    description: `Goal mode: say the user's request is finished. status "done" when it is complete and checked; "blocked" when you cannot go on without the user. Then write your final message to the user.`,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked"] },
        summary: { type: "string", description: "One or two sentences: what was done, or what you need from the user." },
      },
      required: ["status"],
    },
    async execute(args) {
      if (args.status !== "done" && args.status !== "blocked") {
        return { ok: false, content: `status must be "done" or "blocked".` };
      }
      status = args.status;
      return {
        ok: true,
        content: status === "done"
          ? "Recorded: done. Now tell the user what you did and how you checked it."
          : "Recorded: blocked. Now tell the user what you need from them to continue.",
      };
    },
  };
  return {
    tool,
    guard: () => {
      if (status || continuations >= maxContinuations) return { accept: true };
      continuations += 1;
      return { accept: false, feedback: CONTINUE };
    },
    status: () => status,
    continuations: () => continuations,
  };
}
