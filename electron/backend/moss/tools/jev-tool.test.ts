import { afterEach, describe, expect, it, vi } from "vitest";

import { createJevTool } from "./jev-tool";

const args = { state: "A customer needs help.", question: "Is help requested?", type: "noul" };
const context = () => ({ workspaceRoot: "", signal: new AbortController().signal, approvalGranted: true });
const response = (answer: unknown = { type: "noul", noul: 0.9 }) => new Response(JSON.stringify({
  model: "jev-test", answers: { evaluation: answer }, usage: { input_tokens: 10, output_tokens: 5 },
}), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Jev tool", () => {
  it("sends a bounded authenticated request through the official SDK", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const result = await createJevTool(() => "test-secret").execute(args, context());
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ advisory: true, answer: { noul: 0.9 } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-secret");
    expect(JSON.parse(init.body)).toEqual({ model: "jev-latest", state: args.state, questions: { evaluation: { type: "noul", instructions: args.question } } });
    expect(result.content).not.toContain("test-secret");
  });

  it.each([
    ["choice", ["yes", "no"], { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } }],
    ["score", ["low", "high"], { type: "score", score: 0.8, confidence: 0.7, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "low", "1": "high" } }],
  ])("supports %s questions", async (type, criteria, answer) => {
    const fetch = vi.fn().mockResolvedValue(response(answer));
    vi.stubGlobal("fetch", fetch);
    expect((await createJevTool(() => "secret").execute({ ...args, type, criteria }, context())).ok).toBe(true);
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.questions.evaluation.criteria).toEqual(type === "choice" ? { yes: null, no: null } : criteria);
  });

  it.each([
    { state: "" }, { state: "x".repeat(32_001) }, { question: "" }, { type: "other" },
    { type: "choice" }, { type: "score", criteria: ["one"] }, { type: "choice", criteria: ["same", "same"] },
    { criteria: ["yes", "no"] },
  ])("rejects invalid input without reading a credential or sending data: %j", async (patch) => {
    const key = vi.fn(() => "secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await createJevTool(key).execute({ ...args, ...patch }, context())).ok).toBe(false);
    expect(key).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses unapproved, pre-cancelled, missing-key, and locked-key calls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const tool = createJevTool(() => "secret");
    expect((await tool.execute(args, { ...context(), approvalGranted: false })).ok).toBe(false);
    expect((await tool.execute(args, { ...context(), signal: AbortSignal.abort() })).ok).toBe(false);
    expect((await createJevTool(() => "").execute(args, context())).content).toContain("No TypeSafe API key");
    expect((await createJevTool(() => { throw new Error("secret"); }).execute(args, context())).content).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports HTTP failures without echoing remote content or retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("test-secret private content", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const result = await createJevTool(() => "test-secret").execute(args, context());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("429");
    expect(result.content).not.toContain("test-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ type: "noul", noul: 2 })));
    expect((await createJevTool(() => "secret").execute(args, context())).ok).toBe(false);
  });

  it.each(["cancel", "timeout"])("settles an in-flight %s without retry", async (mode) => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = createJevTool(() => "secret").execute(args, { ...context(), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(15_001);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.content).toContain(mode === "cancel" ? "cancelled" : "timed out");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});