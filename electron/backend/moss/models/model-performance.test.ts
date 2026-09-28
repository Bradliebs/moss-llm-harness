import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelCapabilityProfile, ModelPerformanceEntry } from "../../../../common/types";
import { adjustTier, effectiveProfile, gradeTurn, liveScore, ModelPerformanceStore, taskKindFor, wilson } from "./model-performance";

function entry(kind: ModelPerformanceEntry["kind"], recent: string, practice = "", model = "small"): ModelPerformanceEntry {
  return {
    schemaVersion: 1, providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1", model, kind,
    runs: recent.length, recent: [...recent] as Array<"s" | "f">, practice: [...practice] as Array<"s" | "f">,
    rejections: 0, stalls: 0, escalatedAway: 0, repairs: 0, updatedAt: "2026-09-27T00:00:00.000Z",
  };
}

const PROFILE = {
  schemaVersion: 1, suiteVersion: "1", providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1", model: "small",
  probedAt: "x", durationMs: 1, maxContextTested: 1, results: [], overall: 0.4, tier: "limited", usage: {}, failedRequests: 0,
  recommendation: { scaffolding: "heavy", toolUse: "supervised", structuredOutput: "repair", settings: {}, notes: [] },
} as ModelCapabilityProfile;

describe("grading turns from host evidence", () => {
  it("counts verification and task state, and ignores what says nothing about the model", () => {
    expect(gradeTurn({ terminal: "turn-complete", lastVerificationOk: true, supervisorStopped: false })).toBe("s");
    expect(gradeTurn({ terminal: "turn-complete", lastVerificationOk: false, supervisorStopped: false })).toBe("f");
    expect(gradeTurn({ terminal: "turn-complete", taskState: "completed", supervisorStopped: false })).toBe("s");
    expect(gradeTurn({ terminal: "turn-complete", taskState: "blocked", supervisorStopped: false })).toBe("f");
    expect(gradeTurn({ terminal: "turn-complete", supervisorStopped: true })).toBe("f");
    expect(gradeTurn({ terminal: "turn-error", terminalMessage: "Stopped after 8 tool rounds", supervisorStopped: false })).toBe("f");
    expect(gradeTurn({ terminal: "turn-error", terminalMessage: "fetch failed: ECONNREFUSED", supervisorStopped: false })).toBeUndefined();
    expect(gradeTurn({ terminal: "turn-complete", supervisorStopped: false })).toBeUndefined();
    expect(gradeTurn({ terminal: "turn-aborted", lastVerificationOk: false, supervisorStopped: false })).toBeUndefined();
  });

  it("classifies the task by the tools the turn used", () => {
    expect(taskKindFor(["read_file", "edit_file"], false)).toBe("coding");
    expect(taskKindFor(["web_search", "fetch_url"], false)).toBe("research");
    expect(taskKindFor(["desktop_invoke"], false)).toBe("automation");
    expect(taskKindFor(["read_file"], false)).toBe("chat");
    expect(taskKindFor(["edit_file"], true)).toBe("mission");
  });
});

describe("live scores", () => {
  it("computes a Wilson interval and counts practice at half weight", () => {
    const bounds = wilson(9, 10);
    expect(bounds.lower).toBeCloseTo(0.596, 2);
    expect(bounds.upper).toBeCloseTo(0.982, 2);
    const score = liveScore([entry("coding", "sssf", "ss")], "coding");
    expect(score).toMatchObject({ graded: 5, successRate: 4 / 5 });
    expect(liveScore([], "all", "capable")).toEqual({ kind: "all", runs: 0, graded: 0, effectiveTier: "capable" });
  });

  it("moves the tier at most one step, and only with enough clear evidence", () => {
    expect(adjustTier("limited", 9, { lower: 0.9, upper: 1 })).toBe("limited");
    expect(adjustTier("limited", 20, { lower: 0.8, upper: 0.99 })).toBe("capable");
    expect(adjustTier("strong", 20, { lower: 0.8, upper: 0.99 })).toBe("strong");
    expect(adjustTier("capable", 20, { lower: 0.1, upper: 0.4 })).toBe("limited");
    expect(adjustTier("unreliable", 20, { lower: 0, upper: 0.2 })).toBe("unreliable");
    expect(adjustTier("capable", 20, { lower: 0.5, upper: 0.8 })).toBe("capable");
  });

  it("adjusts the profile the harness uses, falling back to all work when a kind has too few runs", () => {
    const strongResults = [entry("coding", "s".repeat(20))];
    const adjusted = effectiveProfile(PROFILE, strongResults, "coding");
    expect(adjusted.profile.tier).toBe("capable");
    expect(adjusted.profile.recommendation.scaffolding).toBe("moderate");
    expect(effectiveProfile(PROFILE, strongResults, "research").profile.tier).toBe("capable");
    expect(effectiveProfile(PROFILE, [entry("coding", "sss")], "coding").profile).toBe(PROFILE);
    // Another model's results never count.
    expect(effectiveProfile(PROFILE, [entry("coding", "s".repeat(20), "", "other")], "coding").profile).toBe(PROFILE);
  });
});

describe("ModelPerformanceStore", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "moss-perf-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("accumulates evidence per model and task kind and survives a reload", async () => {
    const store = new ModelPerformanceStore(dir, () => new Date("2026-09-27T00:00:00.000Z"));
    const base = { providerKind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1/", model: "small" };
    await store.record({ ...base, kind: "coding", outcome: "s", durationMs: 1_000, repairs: 2 });
    await store.record({ ...base, kind: "coding", outcome: "f", rejections: 3, durationMs: 2_000 });
    await store.record({ ...base, kind: "coding", outcome: "s", practice: true });
    await store.record({ ...base, kind: "research" });
    const reloaded = new ModelPerformanceStore(dir);
    const coding = (await reloaded.forModel("openai-compatible", "http://localhost:11434/v1", "small")).find((item) => item.kind === "coding")!;
    expect(coding).toMatchObject({ runs: 2, recent: ["s", "f"], practice: ["s"], rejections: 3, repairs: 2, latencyMs: 1_200, endpoint: "http://localhost:11434/v1" });
    expect(await reloaded.list()).toHaveLength(2);
    await reloaded.clear("openai-compatible", "http://localhost:11434/v1", "small");
    expect(await reloaded.list()).toEqual([]);
  });
});
