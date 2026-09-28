import { describe, expect, it } from "vitest";

import type { TurnTrace } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { createReplayJudge, renderContext } from "./replay-judge";
import { replayTrace } from "./trace-replay";

/** Answers per step: `verdicts` maps a substring of the proposed step to reasonable or not. */
function judgeProvider(verdicts: Record<string, boolean> | string): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    kind: "anthropic",
    requests,
    async *streamChat(req) {
      requests.push(req);
      if (typeof verdicts === "string") { yield { type: "text-delta", text: verdicts }; return; }
      const step = req.messages[1].content.split("Proposed next step: ")[1] ?? "";
      const match = Object.entries(verdicts).find(([key]) => step.includes(key));
      const ok = match?.[1] ?? true;
      yield { type: "text-delta", text: `Thinking out loud first. {"draft":1} ${JSON.stringify({ serves_request: ok, needs_unknown_facts: false, irrelevant_or_premature: !ok, reason: ok ? "Sensible." : "Irrelevant." })}` };
    },
    async listModels() { return []; },
  };
}

const input = {
  messages: [
    { role: "system" as const, content: "You are Moss." },
    { role: "user" as const, content: "What changed in the last commit?" },
  ],
  tools: [
    { name: "git_diff", description: "Show changes", parameters: { type: "object", properties: {} } },
    { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
  ],
  baseline: { toolCalls: [{ name: "read_file", arguments: "{\"path\":\"CHANGELOG.md\"}" }], text: "" },
  candidate: { toolCalls: [{ name: "git_diff", arguments: "{}" }], text: "" },
};

describe("createReplayJudge", () => {
  it("judges each step on its own and compares the two judgements", async () => {
    const provider = judgeProvider({ git_diff: true, read_file: false });
    expect(await createReplayJudge({ provider, model: "judge", judgeModel: "claude-x" })(input, new AbortController().signal))
      .toEqual({ candidateReasonable: true, comparison: "better", reason: "Sensible.", judgeModel: "claude-x" });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].messages[1].content).toMatch(/Tools already called in this conversation: none[\s\S]*Proposed next step: call git_diff/);
    expect(provider.requests[0]).toMatchObject({ temperature: 0, reasoning: "none" });
    expect(provider.requests[0].tools).toBeUndefined();
    expect(await createReplayJudge({ provider: judgeProvider({ git_diff: false }), model: "j", judgeModel: "j" })(input, new AbortController().signal))
      .toMatchObject({ candidateReasonable: false, comparison: "worse" });
    expect(await createReplayJudge({ provider: judgeProvider({}), model: "j", judgeModel: "j" })(input, new AbortController().signal))
      .toMatchObject({ candidateReasonable: true, comparison: "equal" });
  });

  it("returns nothing for unreadable answers", async () => {
    expect(await createReplayJudge({ provider: judgeProvider("no idea"), model: "j", judgeModel: "j" })(input, new AbortController().signal)).toBeUndefined();
    expect(await createReplayJudge({ provider: judgeProvider('{"reason":"x"}'), model: "j", judgeModel: "j" })(input, new AbortController().signal)).toBeUndefined();
  });
  it("renders recent context within a budget, newest kept", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({ role: "user" as const, content: `message ${index} ${"x".repeat(900)}` }));
    const context = renderContext([{ role: "system", content: "Rules" }, ...long], input.tools);
    expect(context).toContain("Assistant instructions (excerpt): Rules");
    expect(context).toContain("message 39");
    expect(context).not.toContain("message 0 ");
    expect(context).toContain("Tools available: git_diff: Show changes; read_file: Read a file");
  });
});

describe("replayTrace with a judge", () => {
  const trace: TurnTrace = {
    schemaVersion: 1, id: "t1", createdAt: "x", providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1",
    primaryModel: "qwen2.5:7b", tools: input.tools,
    calls: [
      { index: 0, startedAt: "x", durationMs: 1, model: "qwen2.5:7b", request: { messages: input.messages, toolNames: ["git_diff", "read_file"] }, response: { text: "", toolCalls: [{ id: "a", name: "read_file", arguments: "{\"path\":\"CHANGELOG.md\"}" }] } },
      { index: 1, startedAt: "x", durationMs: 1, model: "qwen2.5:7b", request: { messages: input.messages, toolNames: ["git_diff", "read_file"] }, response: { text: "", toolCalls: [{ id: "b", name: "git_diff", arguments: "{}" }] } },
    ],
  };
  const candidate: ChatProvider = {
    kind: "openai-compatible",
    async *streamChat(req): AsyncIterable<ProviderStreamEvent> {
      if (!req.tools?.length) { yield { type: "text-delta", text: "ok" }; return; }
      yield { type: "tool-call", toolCall: { id: "c", name: "git_diff", arguments: "{}" } };
    },
    async listModels() { return []; },
  };

  it("judges only differing steps and reports how many were acceptable", async () => {
    const judge = judgeProvider({});
    const report = await replayTrace(trace, candidate, "gemma3", {
      signal: new AbortController().signal,
      judge: { model: "claude-sonnet-4-5", judge: createReplayJudge({ provider: judge, model: "j", judgeModel: "claude-sonnet-4-5" }) },
    });
    expect(report.calls.map((call) => [call.agreement, call.judgement?.candidateReasonable])).toEqual([["different-tool", true], ["same-action", undefined]]);
    expect(report.summary).toMatchObject({ sameAction: 1, judged: 1, acceptable: 2, acceptableRate: 1, better: 0 });
    expect(report.judgeModel).toBe("claude-sonnet-4-5");
    expect(judge.requests).toHaveLength(2);
  });

  it("skips judging when the judge shares a family with the candidate or original model", async () => {
    const judge = judgeProvider({});
    const report = await replayTrace(trace, candidate, "gemma3", {
      signal: new AbortController().signal,
      judge: { model: "qwen3.5:4b", judge: createReplayJudge({ provider: judge, model: "j", judgeModel: "qwen3.5:4b" }) },
    });
    expect(report.judgeSkipped).toMatch(/same model family as qwen2.5:7b/);
    expect(report.summary.acceptable).toBeUndefined();
    expect(judge.requests).toHaveLength(0);
  });
});
