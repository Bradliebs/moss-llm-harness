import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolDefinition, TurnTrace } from "../../../../common/types";
import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { RecordingProvider, summarizeTrace, TraceRecorder, TraceStore, MAX_TRACES } from "./trace-recorder";
import { replayTrace } from "./trace-replay";
import { formatReplayTable, parseReplayArgs, runReplayCli } from "./replay-cli";

const WEATHER: ToolDefinition = { name: "get_weather", description: "", parameters: { type: "object", properties: { city: { type: "string" } } } };

function provider(respond: (req: ChatRequest) => ProviderStreamEvent[] | Error): ChatProvider {
  return {
    kind: "test",
    async *streamChat(req: ChatRequest): AsyncIterable<ProviderStreamEvent> {
      const events = respond(req);
      if (events instanceof Error) throw events;
      for (const event of events) yield event;
    },
    listModels: async () => [],
  };
}

async function drain(source: ChatProvider, req: ChatRequest): Promise<void> {
  for await (const _ of source.streamChat(req, new AbortController().signal)) void _;
}

function sampleTrace(): TurnTrace {
  const recorder = new TraceRecorder({ id: "trace-1", providerKind: "openai-compatible", baseUrl: "http://user:pw@localhost:11434/v1/", model: "small", now: () => new Date("2026-09-26T10:00:00Z") });
  recorder.record({
    startedAt: "2026-09-26T10:00:00Z",
    durationMs: 1_000,
    model: "small",
    request: { messages: [{ role: "user", content: "Weather in Paris?" }], toolNames: ["get_weather"] },
    response: { text: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" }] },
  }, [WEATHER]);
  recorder.record({
    startedAt: "2026-09-26T10:00:01Z",
    durationMs: 2_000,
    model: "small",
    request: { messages: [{ role: "user", content: "Weather in Paris?" }, { role: "tool", toolCallId: "c1", content: "Sunny" }], toolNames: ["get_weather"] },
    response: { text: "It is sunny.", toolCalls: [] },
  }, [WEATHER]);
  recorder.record({
    startedAt: "2026-09-26T10:00:03Z",
    durationMs: 5,
    model: "small",
    request: { messages: [], toolNames: [] },
    response: { text: "", toolCalls: [] },
    error: "HTTP 500",
  });
  return recorder.finish({ outcome: "completed" });
}

describe("TraceRecorder and RecordingProvider", () => {
  it("records requests, responses, usage, and errors without altering the stream", async () => {
    const recorder = new TraceRecorder({ providerKind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" });
    const inner = provider((req) => req.model === "boom" ? new Error("HTTP 500") : [
      { type: "text-delta", text: "hi" },
      { type: "tool-call", toolCall: { id: "1", name: "get_weather", arguments: "{}" } },
      { type: "usage", usage: { inputTokens: 10 } },
      { type: "usage", usage: { outputTokens: 3 } },
    ]);
    const recording = new RecordingProvider(inner, recorder, () => 0);
    const seen: string[] = [];
    for await (const event of recording.streamChat({ model: "m", messages: [{ role: "user", content: "x", images: ["data:image/png;base64,AAA"] }], tools: [WEATHER] }, new AbortController().signal)) {
      seen.push(event.type);
    }
    await expect(drain(recording, { model: "boom", messages: [] })).rejects.toThrow("HTTP 500");
    const trace = recorder.finish({ outcome: "failed", escalatedTo: "big", verification: { passed: 1, failed: 0 } });
    expect(seen).toEqual(["text-delta", "tool-call", "usage", "usage"]);
    expect(trace.calls[0]).toMatchObject({ index: 0, model: "m", response: { text: "hi", usage: { inputTokens: 10, outputTokens: 3 } }, request: { toolNames: ["get_weather"] } });
    expect(trace.calls[0].request.messages[0]).toEqual({ role: "user", content: "x\n[1 image omitted from trace]" });
    expect(trace.calls[1]).toMatchObject({ index: 1, error: "HTTP 500" });
    expect(trace).toMatchObject({ outcome: "failed", escalatedTo: "big", verification: { passed: 1, failed: 0 }, tools: [WEATHER] });
  });

  it("summarizes a trace without credentials in the endpoint", () => {
    const trace = sampleTrace();
    expect(trace.endpoint).toBe("http://localhost:11434/v1");
    expect(summarizeTrace(trace)).toMatchObject({ id: "trace-1", callCount: 3, toolCallCount: 1, outcome: "completed", preview: "Weather in Paris?" });
  });
});

describe("TraceStore", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "moss-traces-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves, lists, reads, prunes expired traces, and clears", async () => {
    const store = new TraceStore(dir);
    await store.save(sampleTrace());
    expect(await store.count()).toBe(1);
    expect((await store.list())[0].id).toBe("trace-1");
    expect((await store.get("trace-1"))?.calls).toHaveLength(3);
    expect(await store.get("missing")).toBeNull();
    await expect(store.get("../escape")).resolves.toBeNull();

    const old = join(store.dir(), "old-trace.json");
    await writeFile(old, JSON.stringify({ ...sampleTrace(), id: "old-trace" }));
    const past = new Date(Date.now() - 30 * 86_400_000);
    await utimes(old, past, past);
    await store.save({ ...sampleTrace(), id: "trace-2" });
    expect((await store.list()).map((item) => item.id).sort()).toEqual(["trace-1", "trace-2"]);
    expect(MAX_TRACES).toBe(200);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});

describe("replayTrace", () => {
  it("compares each recorded decision with the candidate's decision", async () => {
    const candidate = provider((req) => {
      if (req.messages.some((message) => message.role === "tool")) return [{ type: "tool-call", toolCall: { id: "x", name: "get_weather", arguments: "{\"location\":\"Paris\"}" } }];
      return [{ type: "tool-call", toolCall: { id: "y", name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }, { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } }];
    });
    const progress: string[] = [];
    const report = await replayTrace(sampleTrace(), candidate, "big", { signal: new AbortController().signal, onProgress: (done, total) => progress.push(`${done}/${total}`) });
    expect(report.calls.map((call) => call.agreement)).toEqual(["same-action", "called-tool-instead"]);
    expect(report.calls[1].candidate).toMatchObject({ validArguments: false, unknownArguments: ["get_weather.location"] });
    expect(report.summary).toMatchObject({ calls: 2, sameAction: 1, agreementRate: 0.5, validArgumentRate: 0.5, errors: 0, baselineMedianLatencyMs: 2_000, inputTokens: 7 });
    expect(report.baselineOutcome).toBe("completed");
    expect(progress.at(-1)).toBe("2/2");
  });

  it("records candidate errors and answers-instead", async () => {
    const warm = (req: ChatRequest): boolean => req.messages.some((message) => message.content === "Reply with the single word OK.");
    const report = await replayTrace(sampleTrace(), provider((req) => warm(req) || req.messages.length === 1 ? [{ type: "text-delta", text: "Probably sunny" }] : new Error("HTTP 404")), "other", { signal: new AbortController().signal });
    expect(report.calls.map((call) => call.agreement)).toEqual(["answered-instead", "error"]);
    expect(report.summary).toMatchObject({ errors: 1, agreementRate: 0 });
  });

  it("fails fast when the candidate model cannot load", async () => {
    await expect(replayTrace(sampleTrace(), provider(() => new Error("HTTP 404 model not found")), "missing", { signal: new AbortController().signal }))
      .rejects.toThrow(/missing did not respond to a warm-up request/);
  });
});

describe("replay CLI", () => {
  it("parses arguments and rejects incomplete ones", () => {
    expect(parseReplayArgs(["--trace", "a.json", "--model", "m", "--timeout", "30"], {})).toMatchObject({ traces: ["a.json"], models: ["m"], timeoutSeconds: 30, last: 5 });
    expect(() => parseReplayArgs(["--model", "m"], {})).toThrow(/--trace FILE or --dir DIR/);
    expect(() => parseReplayArgs(["--trace", "a"], {})).toThrow(/--model/);
    expect(() => parseReplayArgs(["--dir", "d", "--last", "0", "--model", "m"], {})).toThrow(/positive integer/);
  });

  it("replays traces against each model and prints a table", async () => {
    const stdout: string[] = [];
    const written: string[] = [];
    const code = await runReplayCli(["--dir", "traces", "--model", "big", "--output", "out.json"], {
      env: {},
      listDir: () => ["t1.json"],
      readTrace: () => sampleTrace(),
      createProvider: () => provider(() => [{ type: "tool-call", toolCall: { id: "1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }]),
      io: { stdout: (message) => stdout.push(message), stderr: () => undefined },
      writeOutput: (_path, text) => written.push(text),
    });
    expect(code).toBe(0);
    expect(stdout[0]).toMatch(/trace-1\s+small\s+big\s+2\s+1 \(50%\)/);
    expect(JSON.parse(written[0]).reports).toHaveLength(1);
    expect(formatReplayTable([])).toBe("");
    expect(await runReplayCli(["--dir", "empty", "--model", "m"], { env: {}, listDir: () => [], io: { stdout: () => undefined, stderr: () => undefined } })).toBe(1);
    expect(await runReplayCli([], { io: { stdout: () => undefined, stderr: () => undefined } })).toBe(2);
  });
});
