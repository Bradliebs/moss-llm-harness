// src/lib/settings.test.ts
//
// Unit tests for settings derivation. toProviderConfig is pure; applyPreset and
// updateSettings mutate the exported singletons, which are reset to a known
// baseline before each test. localStorage is absent in node, so the stores run
// purely in memory (their access is try/catch-guarded).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPreset,
  modelsStore,
  PROVIDER_PRESETS,
  readinessItems,
  readinessProfilePatch,
  setModelRate,
  settingsStore,
  toEmbedConfig,
  toProviderConfig,
  updateSettings,
  type MossSettings,
} from "./settings";

const baseline: MossSettings = {
  presetIndex: 0,
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "",
  avatarDataUrl: null,
  enableTools: true,
  workspaceRoot: null,
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  jevEnabled: false,
  embedBaseUrl: "",
  embedModel: "nomic-embed-text",
  verifyEnabled: false,
  verifyCommands: "",
};

beforeEach(() => {
  settingsStore.set({ ...baseline });
  modelsStore.set([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toProviderConfig", () => {
  it("omits the apiKey when it is empty", () => {
    expect(toProviderConfig({ ...baseline, apiKey: "" }).apiKey).toBeUndefined();
  });

  it("includes the apiKey when it is set", () => {
    expect(toProviderConfig({ ...baseline, apiKey: "sk-1" }).apiKey).toBe("sk-1");
  });

  it("carries kind, baseUrl, and model", () => {
    const cfg = toProviderConfig({ ...baseline, kind: "anthropic", baseUrl: "https://x", model: "m" });
    expect(cfg).toMatchObject({ kind: "anthropic", baseUrl: "https://x", model: "m" });
  });
});

describe("toEmbedConfig", () => {
  it("falls back to the provider baseUrl and default model", () => {
    const cfg = toEmbedConfig({ ...baseline, baseUrl: "http://localhost:11434/v1", embedBaseUrl: "", embedModel: "" });
    expect(cfg).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: undefined, model: "nomic-embed-text" });
  });

  it("prefers an explicit embed base URL and model and reuses the api key", () => {
    const cfg = toEmbedConfig({
      ...baseline,
      apiKey: "sk-1",
      baseUrl: "http://provider",
      embedBaseUrl: "http://embed",
      embedModel: "text-embedding-3-small",
    });
    expect(cfg).toEqual({ baseUrl: "http://embed", apiKey: "sk-1", model: "text-embedding-3-small" });
  });
});

describe("applyPreset", () => {
  it.each([
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["Mistral", "https://api.mistral.ai/v1"],
    ["xAI (Grok)", "https://api.x.ai/v1"],
  ])("applies the %s OpenAI-compatible preset", (label, baseUrl) => {
    const idx = PROVIDER_PRESETS.findIndex((p) => p.label === label);
    applyPreset(idx);
    expect(settingsStore.get()).toMatchObject({ presetIndex: idx, kind: "openai-compatible", baseUrl });
  });

  it("applies the Anthropic preset and clears the cached model list", () => {
    modelsStore.set(["old-model"]);
    const idx = PROVIDER_PRESETS.findIndex((p) => p.label === "Anthropic");
    applyPreset(idx);
    const s = settingsStore.get();
    expect(s.presetIndex).toBe(idx);
    expect(s.kind).toBe("anthropic");
    expect(s.baseUrl).toBe("https://api.anthropic.com");
    expect(modelsStore.get()).toEqual([]);
  });

  it("ignores an out-of-range index", () => {
    const before = settingsStore.get();
    applyPreset(999);
    expect(settingsStore.get()).toEqual(before);
  });

  it("restores each provider's saved model and credential", async () => {
    const getCredential = vi.fn((providerId: string) => Promise.resolve(`${providerId}-key`));
    vi.stubGlobal("window", { moss: { provider: { getCredential, setCredential: vi.fn() } } });
    const openAi = PROVIDER_PRESETS.findIndex((preset) => preset.id === "openai");
    const anthropic = PROVIDER_PRESETS.findIndex((preset) => preset.id === "anthropic");

    await applyPreset(openAi);
    updateSettings({ model: "gpt-model" });
    await applyPreset(anthropic);
    updateSettings({ model: "claude-model" });
    await applyPreset(openAi);

    expect(settingsStore.get()).toMatchObject({ model: "gpt-model", apiKey: "openai-key" });
    expect(getCredential).toHaveBeenCalledWith("openai");
  });

  it("preserves the current model on the first switch after upgrading", async () => {
    settingsStore.set({ ...baseline, model: "legacy-ollama-model" });
    const anthropic = PROVIDER_PRESETS.findIndex((preset) => preset.id === "anthropic");
    await applyPreset(anthropic);
    await applyPreset(0);
    expect(settingsStore.get().model).toBe("legacy-ollama-model");
  });
});

describe("updateSettings", () => {
  it("persists the optional Jev switch without storing a credential", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    expect(settingsStore.get().jevEnabled).toBe(false);
    updateSettings({ jevEnabled: true });
    expect(settingsStore.get().jevEnabled).toBe(true);
    expect(JSON.parse(setItem.mock.calls.at(-1)![1])).toMatchObject({ jevEnabled: true });
    expect(settingsStore.get()).not.toHaveProperty("jevApiKey");
    updateSettings({ jevEnabled: false });
    expect(settingsStore.get().jevEnabled).toBe(false);
  });

  it("merges a partial patch and leaves other fields intact", () => {
    updateSettings({ model: "llama3", enableTools: false });
    const s = settingsStore.get();
    expect(s.model).toBe("llama3");
    expect(s.enableTools).toBe(false);
    expect(s.baseUrl).toBe(baseline.baseUrl);
  });
});

describe("setModelRate", () => {
  it("stores a rate under a normalized lowercased model key", () => {
    setModelRate("GPT-4o", { inputPer1M: 1, outputPer1M: 2 });
    expect(settingsStore.get().modelRates).toEqual({ "gpt-4o": { inputPer1M: 1, outputPer1M: 2 } });
  });

  describe("readiness profiles", () => {
    it("derives setup attention without hiding optional capabilities", () => {
      const items = readinessItems({ ...baseline, enableTools: true }, false);
      expect(items.find((item) => item.id === "provider")).toMatchObject({
        status: "attention",
        detail: "Connection failed. Run the provider diagnostic.",
      });
      expect(items.find((item) => item.id === "workspace")?.status).toBe("attention");
      expect(items.find((item) => item.id === "automation")?.status).toBe("optional");
    });

    it("applies safe profile defaults without inventing verification commands or auto-approval", () => {
      expect(readinessProfilePatch("coding", { ...baseline, verifyCommands: "" })).toMatchObject({
        readinessProfile: "coding",
        enableTools: true,
        autoApproveTools: false,
        verifyEnabled: false,
      });
      expect(readinessProfilePatch("research", baseline)).toMatchObject({
        browserEnabled: true,
        desktopEnabled: false,
        autoApproveTools: false,
      });
      expect(readinessProfilePatch("desktop", baseline)).toMatchObject({
        browserEnabled: false,
        desktopEnabled: true,
        autoApproveTools: false,
      });
    });

    it("flags enabled automation until its allowlist is complete", () => {
      const items = readinessItems({
        ...baseline,
        browserEnabled: true,
        browserAllowedDomains: "",
      });
      expect(items.find((item) => item.id === "automation")).toMatchObject({
        status: "attention",
        detail: "Automation is enabled but its allowlist is incomplete.",
      });
    });
  });

  it("removes the override when both rates are zero", () => {
    setModelRate("gpt-4o", { inputPer1M: 1, outputPer1M: 2 });
    setModelRate("gpt-4o", { inputPer1M: 0, outputPer1M: 0 });
    expect(settingsStore.get().modelRates).toEqual({});
  });

  it("removes the override when passed null and ignores an empty model", () => {
    setModelRate("gpt-4o", { inputPer1M: 1, outputPer1M: 2 });
    setModelRate("gpt-4o", null);
    expect(settingsStore.get().modelRates).toEqual({});
    setModelRate("  ", { inputPer1M: 5, outputPer1M: 5 });
    expect(settingsStore.get().modelRates).toEqual({});
  });
});
