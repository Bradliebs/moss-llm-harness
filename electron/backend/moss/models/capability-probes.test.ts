import { describe, expect, it } from "vitest";

import type { ChatProvider } from "../providers/types";
import { idealReply, lastUser, scriptedProvider } from "./__fixtures__/probe-fakes";
import {
  buildHaystack,
  extractJsonObject,
  looksLikeTextToolCall,
  ProbeCancelledError,
  ProbeUnavailableError,
  TOOLS_UNSUPPORTED_NOTE,
  registerValues,
  runCapabilityProbes,
  visibleText,
} from "./capability-probes";

const run = async (provider: ChatProvider, maxContextTokens = 8_192) =>
  (await runCapabilityProbes({ provider, model: "fake", signal: new AbortController().signal }, { maxContextTokens })).results;

describe("grading helpers", () => {
  it("strips reasoning and parses JSON strictly or leniently", () => {
    expect(visibleText("<think>hmm</think> answer")).toBe("answer");
    expect(visibleText("<think>never closed")).toBe("");
    expect(extractJsonObject("{\"a\":1}")).toEqual({ strict: { a: 1 }, lenient: { a: 1 } });
    expect(extractJsonObject("Here you go:\n```json\n{\"a\":1}\n```")).toEqual({ lenient: { a: 1 } });
    expect(extractJsonObject("no json")).toEqual({});
  });

  it("detects tool calls written as text", () => {
    expect(looksLikeTextToolCall("{\"name\": \"get_weather\", \"arguments\": {}}", ["get_weather"])).toBe(true);
    expect(looksLikeTextToolCall("<tool_call>{}</tool_call>", ["x"])).toBe(true);
    expect(looksLikeTextToolCall("get_weather(city='Paris')", ["get_weather"])).toBe(true);
    expect(looksLikeTextToolCall("It is sunny in Paris.", ["get_weather"])).toBe(false);
  });

  it("builds deterministic haystacks near the requested size", () => {
    const first = buildHaystack(4_096, 3, 0.5);
    expect(buildHaystack(4_096, 3, 0.5)).toEqual(first);
    expect(first.prompt).toContain(`vault passcode is ${first.code}.`);
    expect(first.prompt.length).toBeGreaterThan(4_096 * 3);
    expect(first.prompt.length).toBeLessThan(4_096 * 4);
    expect(registerValues(4)).toHaveLength(4);
  });
});

describe("runCapabilityProbes", () => {
  it("scores an ideal model at 100% on every dimension", async () => {
    const provider = scriptedProvider(idealReply);
    const progress: string[] = [];
    const { results, warmupMs } = await runCapabilityProbes(
      { provider, model: "fake", signal: new AbortController().signal },
      { maxContextTokens: 8_192, onProgress: (item) => progress.push(item.message) },
    );
    expect(warmupMs).toBeGreaterThanOrEqual(0);
    expect(progress[0]).toBe("Loading the model");
    expect(results.find((result) => result.dimension === "usable-context")?.metrics?.allPassed).toBe(1);
    expect(results.map((result) => [result.dimension, result.score])).toEqual([
      ["tool-calling", 1],
      ["tool-selection", 1],
      ["tool-restraint", 1],
      ["structured-output", 1],
      ["instruction-following", 1],
      ["usable-context", 1],
      ["plan-coherence", 1],
    ]);
    expect(results.find((result) => result.dimension === "plan-coherence")?.metrics?.maxCoherentSteps).toBe(7);
    expect(results.find((result) => result.dimension === "usable-context")?.metrics?.usableContextTokens).toBeGreaterThan(6_000);
    expect(progress).toContain("Usable context: 8K tokens");
  });

  it("records text-format tool calls, wrapped JSON, and ignored rules for a weak model", async () => {
    const provider = scriptedProvider((req) => {
      const user = lastUser(req.messages);
      if (req.tools?.length) return { text: "{\"name\": \"get_weather\", \"arguments\": {\"city\": \"Paris\"}}" };
      if (/JSON object/.test(user)) return { text: `Sure! \`\`\`json\n${idealReply(req).text}\n\`\`\`` };
      return { text: "I am not sure." };
    });
    const results = await run(provider, 2_048);
    const byDimension = Object.fromEntries(results.map((result) => [result.dimension, result]));
    expect(byDimension["tool-calling"].score).toBe(0);
    expect(byDimension["tool-calling"].metrics?.textToolCalls).toBe(3);
    expect(byDimension["tool-calling"].trials[0].note).toMatch(/as text/);
    expect(byDimension["structured-output"].score).toBe(0.5);
    expect(byDimension["structured-output"].metrics?.lenientOnly).toBe(3);
    expect(byDimension["instruction-following"].score).toBe(0);
    expect(byDimension["plan-coherence"].metrics?.maxCoherentSteps).toBe(0);
  });

  it("detects server-side context truncation and stops at the first failed size", async () => {
    const provider = scriptedProvider((req) => {
      const user = lastUser(req.messages);
      if (!user.includes("vault passcode")) return idealReply(req);
      if (user.length > 10_000) return { text: "I could not find it.", inputTokens: 2_048 };
      return idealReply(req);
    });
    const results = await run(provider, 32_768);
    const context = results.find((result) => result.dimension === "usable-context")!;
    expect(context.trials.map((item) => item.passed)).toEqual([true, true, false]);
    expect(context.metrics).toMatchObject({ truncatedAt: 4_096, maxContextTested: 32_768 });
    expect(context.trials[2].note).toMatch(/truncated/);
    expect(context.score).toBeCloseTo(2 / 6, 2);
  });

  it("reports an unreachable model as unavailable instead of scoring it", async () => {
    await expect(run(scriptedProvider(() => new Error("HTTP 404 model not found")), 1_024)).rejects.toBeInstanceOf(ProbeUnavailableError);
  });

  it("excludes failed requests from scores and marks all-failed dimensions unmeasured", async () => {
    const provider = scriptedProvider((req) => /JSON object/.test(lastUser(req.messages)) ? new Error("Timed out") : idealReply(req));
    const results = await run(provider, 1_024);
    const structured = results.find((result) => result.dimension === "structured-output")!;
    expect(structured).toMatchObject({ score: 0, summary: "No completed requests: 3 failed or timed out", metrics: { completed: 0, errors: 3 } });
    expect(structured.trials.every((item) => item.errored)).toBe(true);
    expect(results.find((result) => result.dimension === "tool-calling")?.metrics).toMatchObject({ completed: 3 });
  });

  it("explains schema mistakes in tool arguments", async () => {
    const provider = scriptedProvider((req) => {
      const user = lastUser(req.messages);
      if (req.tools?.length === 1 && /Paris/.test(user)) return { toolCalls: [{ name: "get_weather", arguments: { location: "Paris" } }] };
      if (req.tools?.length === 1 && /Tokyo/.test(user)) return { toolCalls: [{ name: "get_weather", arguments: { city: { type: "string", value: "Tokyo" } } }] };
      return idealReply(req);
    });
    const results = await runCapabilityProbes({ provider, model: "fake", signal: new AbortController().signal }, { dimensions: ["tool-calling"] });
    expect(results.results[0].trials.map((item) => item.note)).toEqual([
      "Used argument names outside the schema: location (Moss can repair it)",
      // Unwrapping the echoed schema still misses the requested unit.
      "Echoed the parameter schema instead of filling in values",
      undefined,
    ]);
    expect(results.results[0].metrics).toMatchObject({ repairable: 1 });
    expect(results.results[0].score).toBeCloseTo(1 / 3);
  });

  it("counts a server-side no-tools rejection as a measured failure and samples at temperature 0", async () => {
    const provider = scriptedProvider((req) => req.tools?.length
      ? new Error("OpenAI-compatible request failed: HTTP 400 {\"error\":\"registry.ollama.ai/library/gemma3:latest does not support tools\"}")
      : idealReply(req));
    const results = await run(provider, 1_024);
    const toolCalling = results.find((result) => result.dimension === "tool-calling")!;
    expect(toolCalling).toMatchObject({ score: 0, metrics: { completed: 3, toolsUnsupported: 3 } });
    expect(toolCalling.trials[0]).toMatchObject({ note: TOOLS_UNSUPPORTED_NOTE });
    expect(toolCalling.trials[0].errored).toBeUndefined();
    expect(results.find((result) => result.dimension === "plan-coherence")?.metrics).toMatchObject({ completed: 3 });
    expect(provider.calls.every((call) => call.temperature === 0)).toBe(true);
  });

  it("stops on cancellation", async () => {
    const controller = new AbortController();
    const cancelling = scriptedProvider((req) => {
      controller.abort();
      return idealReply(req);
    });
    await expect(runCapabilityProbes({ provider: cancelling, model: "fake", signal: controller.signal })).rejects.toBeInstanceOf(ProbeCancelledError);
  });

  it("fails plan chains that guess values or submit early", async () => {
    const provider = scriptedProvider((req) => {
      if (!req.tools?.some((tool) => tool.name === "read_register")) return idealReply(req);
      return { toolCalls: [{ name: "submit_answer", arguments: { value: 100 } }] };
    });
    const { results } = await runCapabilityProbes({ provider, model: "fake", signal: new AbortController().signal }, { dimensions: ["plan-coherence"] });
    expect(results).toHaveLength(1);
    expect(results[0].trials[0].note).toBe("Submitted after reading only 0/2 registers");
  });
});
