// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCapabilityProfile, ModelPerformanceEntry, OllamaContextReport } from "@common/types";

import { ContextFitSettings } from "./ContextFitSettings";
import { LiveScoreSummary } from "./LiveScoreSummary";

const updateSettings = vi.fn();
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../lib/settings", () => ({
  useSettings: () => settings.value,
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

const ENDPOINT = "http://localhost:11434/v1";
function entry(kind: ModelPerformanceEntry["kind"], recent: string, model = "small"): ModelPerformanceEntry {
  return {
    schemaVersion: 1, providerKind: "openai-compatible", endpoint: ENDPOINT, model, kind, runs: recent.length,
    recent: [...recent] as Array<"s" | "f">, practice: [], rejections: 0, stalls: 0, escalatedAway: 0, repairs: 0, updatedAt: "x",
  };
}
const PROFILE = { model: "small", tier: "limited" } as ModelCapabilityProfile;

beforeEach(() => {
  settings.value = { kind: "openai-compatible", baseUrl: ENDPOINT, model: "small", contextLimit: 0 };
});
afterEach(() => {
  cleanup();
  updateSettings.mockReset();
  Reflect.deleteProperty(window, "moss");
});

describe("LiveScoreSummary", () => {
  it("shows verified results per task kind and the adjusted tier", async () => {
    const clearPerformance = vi.fn(async () => undefined);
    Object.assign(window, { moss: { model: { performance: async () => [entry("coding", "s".repeat(20)), entry("research", "sf"), entry("coding", "ffff", "other")], clearPerformance } } });
    render(<LiveScoreSummary kind="openai-compatible" baseUrl={ENDPOINT} model="small" profile={PROFILE} />);
    const panel = await screen.findByLabelText("Live results on your work");
    expect(panel.textContent).toContain("95% verified success over 22 graded runs");
    expect(panel.textContent).toContain("Coding2020100%");
    expect(panel.textContent).toContain("treats this model as capable rather than its probe tier (limited)");
    fireEvent.click(screen.getByRole("button", { name: "Forget results" }));
    await waitFor(() => expect(clearPerformance).toHaveBeenCalledWith("openai-compatible", ENDPOINT, "small"));
    await waitFor(() => expect(screen.getByText(/No graded work yet/)).toBeDefined());
  });
});

describe("ContextFitSettings", () => {
  const tooSmall: OllamaContextReport = {
    model: "small", status: "too-small", reason: "The server serves 4,096 tokens, so longer prompts are cut off.",
    servedContext: 4096, trainedContext: 32_768, recommendedContext: 32_768, variant: "small:latest-ctx32k",
    gpu: { name: "RTX", totalMiB: 8192, freeMiB: 6144 }, spilledToCpu: false,
  };

  it("checks the context window and creates a variant on request", async () => {
    const inspectContext = vi.fn(async () => tooSmall);
    const createContextVariant = vi.fn(async () => "small:latest-ctx32k");
    Object.assign(window, { moss: { model: { inspectContext, createContextVariant } } });
    render(<ContextFitSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check context window" }));
    const report = await screen.findByLabelText("Context window report");
    expect(report.textContent).toContain("longer prompts are cut off");
    expect(report.textContent).toContain("Served 4,096 tokens · trained 32,768 tokens");
    expect(report.textContent).toContain("RTX 6.0 of 8.0 GB free");
    fireEvent.click(screen.getByRole("button", { name: "Create variant and switch" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ model: "small:latest-ctx32k", contextLimit: 32_768 }));
    expect(createContextVariant).toHaveBeenCalledWith(ENDPOINT, "small", 32_768);
    expect(screen.getByRole("status").textContent).toContain("Created small:latest-ctx32k");
  });

  it("offers nothing to fix when the context suits the model, and hides for other providers", async () => {
    Object.assign(window, { moss: { model: { inspectContext: async () => ({ model: "small", status: "ok", reason: "Fine.", servedContext: 32_768 }) } } });
    render(<ContextFitSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check context window" }));
    await screen.findByText("Fine.");
    expect(screen.queryByRole("button", { name: "Create variant and switch" })).toBeNull();
    cleanup();
    settings.value = { ...settings.value, baseUrl: "https://api.openai.com/v1" };
    const { container } = render(<ContextFitSettings />);
    expect(container.textContent).toBe("");
  });
});
