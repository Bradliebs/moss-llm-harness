import { describe, expect, it, vi } from "vitest";

import { contextSpillWarning, contextThatFits, createContextVariant, inspectOllamaContext, kvBytesPerToken, ollamaRoot, parseShow, variantName, type Fetcher } from "./ollama-context";

const MIB = 1024 * 1024;

function fakeOllama(options: { served?: number; size?: number; sizeVram?: number; weights?: number; trained?: number; createFails?: boolean }) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/api/show") {
      return reply({
        parameters: "",
        model_info: { "qwen2.context_length": options.trained ?? 32_768, "qwen2.block_count": 28, "qwen2.attention.head_count": 12, "qwen2.attention.head_count_kv": 2, "qwen2.embedding_length": 1536 },
        details: { parameter_size: "1.5B", quantization_level: "Q4_0" },
      });
    }
    if (path === "/api/tags") return reply({ models: [{ name: "small:q4", size: options.weights ?? 900 * MIB }] });
    if (path === "/api/generate") return reply({ done: true });
    if (path === "/api/ps") return reply({ models: [{ name: "small:q4", size: options.size, size_vram: options.sizeVram ?? options.size, context_length: options.served }] });
    if (path === "/api/create") return options.createFails && body?.from ? reply({ error: "unknown field" }, 400) : reply({ status: "success" });
    return reply({}, 404);
  };
  return { fetcher, calls };
}

const gpu = async () => ({ totalMiB: 8192, usedMiB: 3_000, name: "Test GPU" });

describe("ollama context helpers", () => {
  it("derives the native root, variant names, and cache size", () => {
    expect(ollamaRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaRoot("http://host:11434/v1/")).toBe("http://host:11434");
    expect(ollamaRoot("nope")).toBeNull();
    expect(variantName("qwen2.5:1.5b-instruct-q4_0", 16_384)).toBe("qwen2.5:1.5b-instruct-q4_0-ctx16k");
    expect(variantName("gemma3", 8_192)).toBe("gemma3:latest-ctx8k");
    expect(variantName("gemma3:latest-ctx8k", 16_384)).toBe("gemma3:latest-ctx16k");
    expect(kvBytesPerToken({ "q.block_count": 28, "q.attention.head_count": 12, "q.attention.head_count_kv": 2, "q.embedding_length": 1536 })).toBe(28 * 2 * 256 * 2);
    expect(kvBytesPerToken({})).toBeUndefined();
    expect(parseShow({ parameters: "stop <x>\nnum_ctx 4096", model_info: {} }).configuredContext).toBe(4096);
    expect(contextThatFits(8192, 900, 28_672)).toBeGreaterThan(200_000);
    expect(contextThatFits(1000, 900, 28_672)).toBe(0);
  });
});

describe("inspectOllamaContext", () => {
  it("proposes a larger variant when a small served context truncates prompts", async () => {
    const { fetcher, calls } = fakeOllama({ served: 4096, size: 900 * MIB + 4096 * 28_672 + 500 * MIB });
    const report = await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "small:q4", fetcher, gpu, usableContext: 3_900 });
    expect(report).toMatchObject({ status: "too-small", servedContext: 4096, trainedContext: 32_768, recommendedContext: 32_768, variant: "small:q4-ctx32k", usableContext: 3_900 });
    // The model is loaded so the server reports what it actually serves.
    expect(calls.map((call) => call.path)).toEqual(["/api/show", "/api/tags", "/api/generate", "/api/ps"]);
  });

  it("proposes a smaller variant only when the model spilled to the CPU", async () => {
    const size = 900 * MIB + 65_536 * 60_000;
    const spilled = await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "small:q4", fetcher: fakeOllama({ served: 65_536, size, sizeVram: size * 0.6, trained: 131_072 }).fetcher, gpu });
    expect(spilled).toMatchObject({ status: "too-large", spilledToCpu: true, variant: expect.stringMatching(/^small:q4-ctx\d+k$/) });
    expect(spilled.recommendedContext!).toBeLessThan(65_536);
    const onGpu = await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "small:q4", fetcher: fakeOllama({ served: 32_768, size: 900 * MIB + 32_768 * 28_672 + 500 * MIB }).fetcher, gpu });
    expect(onGpu.status).toBe("ok");
  });

  it("still offers a smaller context when the weights alone fill the GPU", async () => {
    const weights = 7_000 * MIB;
    const fake = fakeOllama({ served: 65_536, weights, size: weights + 65_536 * 60_000, sizeVram: 500 * MIB, trained: 131_072 });
    const report = await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "small:q4", fetcher: fake.fetcher, gpu });
    expect(report).toMatchObject({ status: "too-large", recommendedContext: 8_192, variant: "small:q4-ctx8k", spilledToCpu: true });
    expect(report.reason).toMatch(/still leaves some on the CPU but is several times faster/);
    // Already at the floor: only a smaller model helps.
    const small = await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "small:q4", fetcher: fakeOllama({ served: 8_192, weights, size: weights + 8_192 * 60_000, sizeVram: 500 * MIB }).fetcher, gpu });
    expect(small).toMatchObject({ status: "too-large" });
    expect(small.variant).toBeUndefined();
  });

  it("does not apply to cloud models", async () => {
    const fetcher = vi.fn();
    expect(await inspectOllamaContext({ baseUrl: "http://localhost:11434/v1", model: "glm-5.3:cloud", fetcher, gpu })).toMatchObject({ status: "not-applicable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("contextSpillWarning", () => {
  it("warns only for a local Ollama model that spilled onto the CPU", async () => {
    const size = 900 * MIB + 65_536 * 60_000;
    const spilled = fakeOllama({ served: 65_536, size, sizeVram: size * 0.6, trained: 131_072 }).fetcher;
    const local = { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "small:q4" };
    expect(await contextSpillWarning(local, { fetcher: spilled, gpu, fixHint: "Fix it in Settings." })).toMatch(/^small:q4 is running partly on the CPU, so replies are several times slower\. .*65,536 tokens.* Fix it in Settings\.$/);
    expect(await contextSpillWarning(local, { fetcher: fakeOllama({ served: 32_768, size: 900 * MIB + 32_768 * 28_672 + 500 * MIB }).fetcher, gpu })).toBeNull();
    const untouched = vi.fn();
    expect(await contextSpillWarning({ ...local, model: "glm-5.3:cloud" }, { fetcher: untouched, gpu })).toBeNull();
    expect(await contextSpillWarning({ ...local, baseUrl: "http://127.0.0.1:8080/v1" }, { fetcher: untouched, gpu })).toBeNull();
    expect(await contextSpillWarning({ ...local, kind: "anthropic" }, { fetcher: untouched, gpu })).toBeNull();
    expect(untouched).not.toHaveBeenCalled();
    // A server that cannot be checked gives no warning rather than an error.
    expect(await contextSpillWarning(local, { fetcher: async () => { throw new Error("down"); }, gpu })).toBeNull();
  });
});

describe("createContextVariant", () => {
  it("creates a named variant, falling back to a Modelfile on older servers", async () => {
    const modern = fakeOllama({});
    expect(await createContextVariant({ baseUrl: "http://localhost:11434/v1", model: "small:q4", numCtx: 16_384, fetcher: modern.fetcher })).toBe("small:q4-ctx16k");
    expect(modern.calls[0].body).toEqual({ model: "small:q4-ctx16k", from: "small:q4", parameters: { num_ctx: 16_384 }, stream: false });
    const legacy = fakeOllama({ createFails: true });
    await createContextVariant({ baseUrl: "http://localhost:11434/v1", model: "small:q4", numCtx: 8_192, fetcher: legacy.fetcher });
    expect(legacy.calls[1].body).toEqual({ model: "small:q4-ctx8k", modelfile: "FROM small:q4\nPARAMETER num_ctx 8192\n", stream: false });
    await expect(createContextVariant({ baseUrl: "http://localhost:11434/v1", model: "small:q4", numCtx: 100, fetcher: modern.fetcher })).rejects.toThrow(/between/);
  });
});
