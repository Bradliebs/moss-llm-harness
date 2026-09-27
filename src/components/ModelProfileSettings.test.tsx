// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCapabilityProfile, ModelProbeProgress } from "@common/types";

import { ModelProfileSettings } from "./ModelProfileSettings";

const updateSettings = vi.fn();
vi.mock("../lib/settings", () => ({
  useSettings: () => ({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b", apiKey: "" }),
  toProviderConfig: (s: { kind: string; baseUrl: string; model: string }) => ({ kind: s.kind, baseUrl: s.baseUrl, model: s.model }),
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

const profile: ModelCapabilityProfile = {
  schemaVersion: 1,
  suiteVersion: "1",
  providerKind: "openai-compatible",
  endpoint: "http://localhost:11434/v1",
  model: "llama3.1:8b",
  probedAt: "2026-09-26T10:00:00.000Z",
  durationMs: 42_000,
  maxContextTested: 32_768,
  results: [
    { dimension: "tool-calling", score: 0.667, passed: 2, total: 3, summary: "2/3 native tool calls with correct arguments", durationMs: 1, trials: [{ id: "a", passed: false, score: 0, durationMs: 1, note: "Wrote the tool call as text instead of calling it" }] },
    { dimension: "usable-context", score: 0.333, passed: 2, total: 6, summary: "Recalled a buried fact at up to ~1,843 tokens", durationMs: 1, trials: [] },
  ],
  overall: 0.55,
  tier: "limited",
  usage: { inputTokens: 1000, outputTokens: 200 },
  latency: { medianMs: 2_400, p90Ms: 5_000 },
  failedRequests: 1,
  recommendation: {
    scaffolding: "heavy",
    toolUse: "supervised",
    structuredOutput: "repair",
    usableContextTokens: 1_843,
    settings: { maxToolRounds: 8, contextLimit: 1_024 },
    notes: ["Ollama uses its default context length unless you raise it, for example with OLLAMA_CONTEXT_LENGTH or num_ctx in a Modelfile."],
  },
};

let progressHandler: ((progress: ModelProbeProgress) => void) | null = null;

beforeEach(() => {
  progressHandler = null;
  Object.assign(window, {
    moss: {
      model: {
        profile: vi.fn(async () => null),
        probe: vi.fn(async () => {
          progressHandler?.({ dimension: "tool-calling", completedDimensions: 0, totalDimensions: 7, message: "Tool calling" });
          return profile;
        }),
        cancelProbe: vi.fn(async () => undefined),
        profiles: vi.fn(async () => []),
        onProbeProgress: vi.fn((handler: (progress: ModelProbeProgress) => void) => {
          progressHandler = handler;
          return () => { progressHandler = null; };
        }),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  updateSettings.mockReset();
  Reflect.deleteProperty(window, "moss");
});

describe("ModelProfileSettings", () => {
  it("runs the probe for the selected model and shows results, notes, and failures", async () => {
    render(<ModelProfileSettings className="" />);
    expect(await screen.findByText(/has not been profiled/)).toBeDefined();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "Run capability probe" }));
    await waitFor(() => expect(screen.getByLabelText("Capability profile results")).toBeDefined());
    expect(window.moss.model!.probe).toHaveBeenCalledWith({
      config: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b" },
      options: { maxContextTokens: 8192 },
    });
    expect(screen.getByText("limited")).toBeDefined();
    expect(screen.getByLabelText("Profile notes").textContent).toContain("OLLAMA_CONTEXT_LENGTH");
    expect(screen.getByText("Wrote the tool call as text instead of calling it")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Profiled llama3.1:8b: limited, 55% overall.");
    expect(screen.getByLabelText("Capability profile results").textContent).toContain("median 2.4s per reply · 1 failed or timed out");
  });

  it("applies only the suggested settings", async () => {
    vi.mocked(window.moss.model!.profile).mockResolvedValue(profile);
    render(<ModelProfileSettings className="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply suggested settings" }));
    expect(updateSettings).toHaveBeenCalledWith({ maxToolRounds: 8, contextLimit: 1_024 });
    expect(screen.getByRole("button", { name: "Re-run capability probe" })).toBeDefined();
  });

  it("reports cancellation and failures without a profile", async () => {
    vi.mocked(window.moss.model!.probe).mockRejectedValueOnce(new Error("Capability probe cancelled"));
    render(<ModelProfileSettings className="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Run capability probe" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Capability probe cancelled."));
    vi.mocked(window.moss.model!.probe).mockRejectedValueOnce(new Error("HTTP 404"));
    fireEvent.click(screen.getByRole("button", { name: "Run capability probe" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Capability probe failed: HTTP 404"));
  });
});
