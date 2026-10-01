// electron/backend/moss/tools/delegate-tool.ts
//
// Hands a self-contained piece of work to a subagent that runs in its own
// conversation and reports back a summary.
//
// The point is context isolation. Reading twenty files to answer one question
// costs twenty files' worth of context in the main thread, and every later round
// keeps paying for it. A subagent absorbs that cost in a conversation that is
// discarded, and the parent only pays for the answer.
//
// The subagent is deliberately read-only. It cannot be granted approval for a
// mutating tool, so no amount of prompt injection in the material it reads can
// turn it into a way around the approval gate the user sees.

import type { Tool, ToolContext, ToolResult } from "./types";

const MAX_TASK_CHARS = 4_000;

export const delegateTool: Tool = {
  name: "delegate",
  description:
    "Hand a self-contained research question to a subagent that explores in its own context and reports back. Use it for work that needs to read a lot to produce a short answer. The subagent is read-only and cannot change anything, so do not ask it to.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: 1,
        description: "The question to answer, stated in full. The subagent sees none of this conversation.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, content: "task is required" };
    if (task.length > MAX_TASK_CHARS) {
      return { ok: false, content: `task is too long (${task.length} chars, limit ${MAX_TASK_CHARS})` };
    }
    if (!ctx.delegate) {
      // Either the host never wired delegation, or this is already a subagent
      // and the depth cap has stopped it spawning another.
      return { ok: false, content: "Delegation is not available here; do this work yourself" };
    }

    try {
      const { report, untrustedSources } = await ctx.delegate(task, ctx.signal);
      const trimmed = report.trim();
      return trimmed
        ? { ok: true, content: trimmed, ...(untrustedSources.length > 0 ? { untrustedSources } : {}) }
        : { ok: false, content: "The subagent finished without reporting anything" };
    } catch (err) {
      return { ok: false, content: `Subagent failed: ${(err as Error).message}` };
    }
  },
};

export const DELEGATE_TOOLS: Tool[] = [delegateTool];
