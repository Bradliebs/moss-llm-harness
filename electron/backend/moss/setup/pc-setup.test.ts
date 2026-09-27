import { describe, expect, it, vi } from "vitest";

import { detectSetup, pickEscalationModel, pullOllamaModel } from "./pc-setup";
import type { Fetcher } from "../models/ollama-context";

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("pickEscalationModel", () => {
  it("prefers the strongest known model per provider and gives up otherwise", () => {
    expect(pickEscalationModel("anthropic", ["claude-3-5-haiku", "claude-sonnet-4-5", "claude-sonnet-4-0"])).toBe("claude-sonnet-4-5");
    expect(pickEscalationModel("openai", ["gpt-4o-mini", "gpt-4.1", "gpt-5-mini"])).toBe("gpt-4.1");
    expect(pickEscalationModel("openai", ["whisper-1"])).toBeUndefined();
    expect(pickEscalationModel("unknown", ["x"])).toBeUndefined();
  });
});

describe("detectSetup", () => {
  it("reads Ollama models, the GPU, and cloud providers with a saved key", async () => {
    const fetcher: Fetcher = async (url) => new URL(url).pathname === "/api/version"
      ? reply({ version: "0.34.4" })
      : reply({ models: [{ name: "qwen2.5:7b", size: 4_700_000_000, details: { parameter_size: "7.6B", family: "qwen2" } }, { name: "nomic-embed-text:latest", size: 274_000_000 }] });
    const listModels = vi.fn(async () => ["claude-sonnet-4-5", "claude-3-5-haiku"]);
    const detection = await detectSetup({
      ollamaBaseUrl: "http://localhost:11434/v1",
      cloud: [
        { presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
        { presetId: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
      ],
    }, { fetcher, gpu: async () => ({ totalMiB: 8192, usedMiB: 1_000, name: "RTX" }), credential: (id) => id === "anthropic" ? "sk" : "", listModels });
    expect(detection).toEqual({
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        version: "0.34.4",
        models: [
          { name: "qwen2.5:7b", sizeBytes: 4_700_000_000, parameterSize: "7.6B", family: "qwen2" },
          { name: "nomic-embed-text:latest", sizeBytes: 274_000_000 },
        ],
      },
      gpu: { name: "RTX", totalMiB: 8192, freeMiB: 7192 },
      cloud: [{ presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" }],
    });
    expect(listModels).toHaveBeenCalledWith({ kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk" });
  });

  it("reports no Ollama when the server is down and no GPU without nvidia-smi", async () => {
    const detection = await detectSetup({ ollamaBaseUrl: "http://localhost:11434/v1", cloud: [] }, {
      fetcher: async () => { throw new Error("ECONNREFUSED"); },
      gpu: async () => null,
      credential: () => "",
      listModels: async () => [],
    });
    expect(detection).toEqual({ cloud: [] });
  });
});

describe("pullOllamaModel", () => {
  it("pulls without streaming and surfaces server errors", async () => {
    const fetcher = vi.fn(async () => reply({ status: "success" }));
    await pullOllamaModel("http://localhost:11434/v1", "nomic-embed-text", fetcher);
    expect(fetcher).toHaveBeenCalledWith("http://localhost:11434/api/pull", expect.objectContaining({ body: JSON.stringify({ model: "nomic-embed-text", stream: false }) }));
    await expect(pullOllamaModel("http://localhost:11434/v1", "missing", async () => reply({ error: "pull model manifest: file does not exist" }, 500))).rejects.toThrow(/does not exist/);
    await expect(pullOllamaModel("http://localhost:11434/v1", "bad name; rm", fetcher)).rejects.toThrow(/Invalid/);
  });
});
