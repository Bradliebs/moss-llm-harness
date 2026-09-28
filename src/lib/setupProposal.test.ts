import { describe, expect, it } from "vitest";

import type { ModelCapabilityProfile, SetupDetection } from "@common/types";

import { buildSetupProposal, isEmbeddingModel, patchForProvider } from "./setupProposal";
import type { MossSettings } from "./settings";

const GB = 1e9;
const BASE = "http://localhost:11434/v1";
const settings = { model: "", presetIndex: 0 } as MossSettings;

function detection(overrides: Partial<SetupDetection> = {}): SetupDetection {
  return {
    ollama: {
      baseUrl: BASE,
      models: [
        { name: "big:14b", sizeBytes: 9 * GB, parameterSize: "14B" },
        { name: "mid:8b", sizeBytes: 4.9 * GB, parameterSize: "8.0B" },
        { name: "small:1.5b", sizeBytes: 1 * GB, parameterSize: "1.5B" },
        { name: "nomic-embed-text:latest", sizeBytes: 0.27 * GB, family: "nomic-bert" },
        { name: "glm-5.3:cloud", sizeBytes: 300 },
      ],
    },
    gpu: { name: "RTX", totalMiB: 8192, freeMiB: 7_600 },
    cloud: [],
    ...overrides,
  };
}

function profile(model: string, tier: ModelCapabilityProfile["tier"]): ModelCapabilityProfile {
  return { model, tier, providerKind: "openai-compatible", endpoint: BASE, overall: 0.5 } as ModelCapabilityProfile;
}

const build = (input: Partial<Parameters<typeof buildSetupProposal>[0]> = {}) => buildSetupProposal({
  detection: detection(), profiles: [], performance: [], settings, ollamaBaseUrl: BASE, currentPresetId: "ollama", ...input,
});

describe("buildSetupProposal", () => {
  it("proposes the largest model that fits, a fast model, cloud escalation, embeddings, profiling, and a context check", () => {
    const proposal = build();
    expect(proposal.items.map((item) => item.id)).toEqual(["chat", "fast", "escalation", "embeddings", "profile", "context"]);
    expect(proposal.items[0]).toMatchObject({ title: "Chat model: mid:8b", recommended: true, useOllamaPreset: true, patch: { model: "mid:8b" } });
    expect(proposal.items[1].patch).toEqual({ fastModel: "small:1.5b", fastRoute: undefined });
    expect(proposal.items[2].patch).toEqual({ escalationModel: "glm-5.3:cloud", escalationRoute: undefined });
    expect(proposal.items[3]).toMatchObject({ patch: { embedModel: "nomic-embed-text", embedBaseUrl: BASE, semanticRanking: true } });
    expect(proposal.items[3].actions).toBeUndefined();
    expect(proposal.items[4].actions).toEqual([{ type: "probe", model: "mid:8b" }, { type: "probe", model: "small:1.5b" }]);
    expect(proposal.items[5].actions).toEqual([{ type: "context", model: "mid:8b" }]);
    expect(proposal.summary).toBe("Found 3 local models (1 too large for your GPU) and RTX with 8 GB.");
  });

  it("prefers measured tiers and a saved cloud key, and downloads embeddings when missing", () => {
    const proposal = build({
      detection: detection({
        ollama: { baseUrl: BASE, models: detection().ollama!.models.filter((model) => !model.name.startsWith("nomic")) },
        cloud: [{ presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" }],
      }),
      profiles: [profile("small:1.5b", "capable"), profile("mid:8b", "limited")],
    });
    expect(proposal.items[0].patch).toEqual({ model: "small:1.5b" });
    expect(proposal.items.find((item) => item.id === "fast")).toBeUndefined();
    expect(proposal.items.find((item) => item.id === "escalation")!.patch).toEqual({
      escalationRoute: { presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
      escalationModel: undefined,
    });
    expect(proposal.items.find((item) => item.id === "embeddings")!.actions).toEqual([{ type: "pull", model: "nomic-embed-text" }]);
    expect(proposal.items.find((item) => item.id === "profile")).toBeUndefined();
  });

  it("does not switch away from a provider already in use by default, and explains a missing Ollama", () => {
    const elsewhere = build({ currentPresetId: "openai", settings: { ...settings, model: "gpt-4.1" } });
    expect(elsewhere.items.filter((item) => !item.recommended).map((item) => item.id)).toEqual(["chat", "profile", "context"]);
    const none = build({ detection: { cloud: [] } });
    expect(none.items).toEqual([]);
    expect(none.summary).toMatch(/Ollama is not running/);
    expect(isEmbeddingModel("bge-m3")).toBe(true);
    expect(isEmbeddingModel("qwen2.5:7b")).toBe(false);
  });
});


describe("patchForProvider", () => {
  it("turns local fast and escalation models into Ollama routes when chat stays elsewhere", () => {
    const patch = { fastModel: "small:1.5b", fastRoute: undefined, escalationModel: "glm-5.3:cloud", escalationRoute: undefined, semanticRanking: true };
    expect(patchForProvider(patch, true, BASE)).toBe(patch);
    expect(patchForProvider(patch, false, BASE)).toEqual({
      fastModel: undefined,
      fastRoute: { presetId: "ollama", kind: "openai-compatible", baseUrl: BASE, model: "small:1.5b" },
      escalationModel: undefined,
      escalationRoute: { presetId: "ollama", kind: "openai-compatible", baseUrl: BASE, model: "glm-5.3:cloud" },
      semanticRanking: true,
    });
  });
});