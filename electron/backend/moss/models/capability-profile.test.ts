import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityProbeResult } from "../../../../common/types";
import { buildCapabilityProfile, capabilityTier, endpointLabel, overallScore, profileKey, recommendScaffolding } from "./capability-profile";
import { ModelProfileStore } from "./model-profile-store";

function result(dimension: CapabilityProbeResult["dimension"], score: number, metrics?: Record<string, number>, trials: CapabilityProbeResult["trials"] = []): CapabilityProbeResult {
  return { dimension, score, passed: 0, total: trials.length, summary: "", trials, durationMs: 10, ...(metrics ? { metrics } : {}) };
}

const strong = [
  result("tool-calling", 1),
  result("tool-selection", 1),
  result("tool-restraint", 1),
  result("structured-output", 1),
  result("instruction-following", 1),
  result("usable-context", 1, { usableContextTokens: 30_000, allPassed: 1 }),
  result("plan-coherence", 1, { maxCoherentSteps: 7 }),
];

describe("capability profile", () => {
  it("normalizes endpoints without credentials and keys profiles per model", () => {
    expect(endpointLabel("https://user:secret@api.example.com/v1/?key=1")).toBe("https://api.example.com/v1");
    expect(profileKey("openai-compatible", "http://LOCALHOST:11434/v1/", "llama")).toBe("openai-compatible|http://localhost:11434/v1|llama");
  });

  it("recommends light scaffolding for a strong model", () => {
    expect(overallScore(strong)).toBe(1);
    expect(capabilityTier(strong)).toBe("strong");
    const recommendation = recommendScaffolding(strong, "https://api.example.com", 32_768);
    expect(recommendation).toMatchObject({
      scaffolding: "light",
      toolUse: "reliable",
      structuredOutput: "direct",
      usableContextTokens: 30_000,
      settings: { maxToolRounds: 24 },
    });
    expect(recommendation.settings.enableTools).toBeUndefined();
    expect(recommendation.settings.contextLimit).toBeUndefined();
    expect(recommendation.notes.join(" ")).toMatch(/real window may be larger/);
  });

  it("recommends heavy scaffolding, chat only, and Ollama context guidance for a weak local model", () => {
    const weak = [
      result("tool-calling", 0, { textToolCalls: 3 }),
      result("tool-selection", 0.25),
      result("tool-restraint", 0.5),
      result("structured-output", 0.5, { lenientOnly: 3 }),
      result("instruction-following", 0.25, undefined, [{ id: "system-suffix", passed: false, score: 0, durationMs: 1 }]),
      result("usable-context", 0.33, { usableContextTokens: 1_800, truncatedAt: 4_096 }),
      result("plan-coherence", 0, { maxCoherentSteps: 0 }),
    ];
    expect(capabilityTier(weak)).toBe("unreliable");
    const recommendation = recommendScaffolding(weak, "http://localhost:11434/v1", 32_768);
    expect(recommendation).toMatchObject({ scaffolding: "heavy", toolUse: "avoid", structuredOutput: "repair", settings: { enableTools: false, maxToolRounds: 4, contextLimit: 1_024 } });
    const notes = recommendation.notes.join("\n");
    expect(notes).toMatch(/as text/);
    expect(notes).toMatch(/code fences/);
    expect(notes).toMatch(/system-prompt rule/);
    expect(notes).toMatch(/truncated prompts near 4,096/);
    expect(notes).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(notes).toMatch(/one or two tool calls/);
  });

  it("scores only measured dimensions and reports failed requests", () => {
    const partial = [
      result("tool-calling", 1, { completed: 3 }),
      result("structured-output", 0, { completed: 0, errors: 3 }),
    ];
    expect(overallScore(partial)).toBe(1);
    expect(capabilityTier(partial)).toBe("capable");
    const notes = recommendScaffolding(partial, "https://api.example.com", 8_192).notes.join(" ");
    expect(notes).toMatch(/3 of 3 probe requests failed or timed out/);
    expect(notes).toMatch(/structured-output could not be measured/);
    expect(notes).not.toMatch(/invalid or incomplete/);
  });

  it("explains server-side tool rejection", () => {
    const noTools = [
      result("tool-calling", 0, { completed: 3, toolsUnsupported: 3 }),
      result("tool-restraint", 0, { completed: 2, toolsUnsupported: 2 }),
      result("plan-coherence", 0, { completed: 3, toolsUnsupported: 3, maxCoherentSteps: 0 }),
    ];
    const recommendation = recommendScaffolding(noTools, "http://localhost:11434/v1", 1_024);
    expect(recommendation.settings.enableTools).toBe(false);
    expect(recommendation.notes).toEqual([expect.stringMatching(/does not support tools/)]);
  });

  it("does not blame Ollama context length for a timeout", () => {
    const timedOut = [result("usable-context", 0.5, { usableContextTokens: 3_000, errors: 1, completed: 2 })];
    expect(recommendScaffolding(timedOut, "http://localhost:11434/v1", 8_192).notes.join(" ")).not.toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it("summarizes latency and adds a slow-model note", () => {
    const slow = [result("tool-calling", 1, { completed: 2 }, [
      { id: "a", passed: true, score: 1, durationMs: 30_000 },
      { id: "b", passed: true, score: 1, durationMs: 40_000 },
      { id: "c", passed: false, score: 0, durationMs: 90_000, errored: true },
    ])];
    const profile = buildCapabilityProfile({ providerKind: "openai-compatible", baseUrl: "http://x", model: "m", results: slow, startedAt: 0, finishedAt: 1, maxContextTested: 1_024, warmupMs: 12_000 });
    expect(profile.latency).toEqual({ medianMs: 40_000, p90Ms: 40_000 });
    expect(profile.warmupMs).toBe(12_000);
    expect(profile.recommendation.notes.join(" ")).toMatch(/median response took 40s/);
  });

  it("builds a profile with usage totals", () => {
    const profile = buildCapabilityProfile({
      providerKind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude",
      results: [result("tool-calling", 1, undefined, [{ id: "a", passed: true, score: 1, durationMs: 5, inputTokens: 100, outputTokens: 20 }])],
      startedAt: 1_000,
      finishedAt: 4_000,
      maxContextTested: 8_192,
    });
    expect(profile).toMatchObject({ schemaVersion: 1, endpoint: "https://api.anthropic.com", durationMs: 3_000, usage: { inputTokens: 100, outputTokens: 20 }, overall: 1, failedRequests: 0 });
  });
});

describe("ModelProfileStore", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "moss-profiles-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the latest profile per endpoint and model", async () => {
    const store = new ModelProfileStore(dir);
    const base = buildCapabilityProfile({ providerKind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama", results: strong, startedAt: 0, finishedAt: 1_000, maxContextTested: 8_192 });
    await store.save(base);
    await store.save({ ...base, probedAt: "2030-01-01T00:00:00.000Z", overall: 0.5 });
    await store.save({ ...base, model: "qwen" });
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect((await store.get("openai-compatible", "http://localhost:11434/v1/", "llama"))?.overall).toBe(0.5);
    expect(await store.get("anthropic", "http://localhost:11434/v1", "llama")).toBeNull();
  });

  it("returns an empty list when nothing has been stored", async () => {
    expect(await new ModelProfileStore(dir).list()).toEqual([]);
  });
});
