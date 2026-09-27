// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PracticeConfig, PracticeReport } from "@common/types";

import { PracticeSettings } from "./PracticeSettings";

const updateSettings = vi.fn();
vi.mock("../lib/settings", () => ({
  PROVIDER_PRESETS: [{ id: "ollama", label: "Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" }],
  useSettings: () => ({ providerProfiles: {} }),
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

const CONFIG: PracticeConfig = { enabled: false, baseUrl: "http://localhost:11434/v1", candidates: ["small"], maxTraces: 8, idleMinutes: 20 };
const REPORT: PracticeReport = {
  startedAt: "2026-09-27T00:00:00.000Z", finishedAt: "2026-09-27T00:10:00.000Z", tracesUsed: 6, outcomeTraces: 3,
  baseline: { models: ["big"], medianLatencyMs: 4_000, outcome: { runs: 3, passed: 1 } },
  candidates: [{ model: "small", decision: { calls: 10, sameAction: 9, validArgumentRate: 1, errors: 0, medianLatencyMs: 900 }, outcome: { runs: 3, passed: 3 } }],
  recommendation: { model: "small", role: "chat", reason: "small passed verification on 3 of 3 of your tasks, against 1 of 3." },
};

let configure: ReturnType<typeof vi.fn>;
let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  configure = vi.fn(async (config: PracticeConfig) => config);
  run = vi.fn(async () => REPORT);
  Object.assign(window, {
    moss: {
      practice: { get: async () => ({ config: CONFIG, latest: null, running: false }), configure, run, cancel: vi.fn(), onProgress: () => () => undefined },
      provider: { listModels: async () => ["small", "big", "glm-5.3:cloud", "nomic-embed-text:latest"] },
    },
  });
});
afterEach(() => {
  cleanup();
  updateSettings.mockReset();
  Reflect.deleteProperty(window, "moss");
});

describe("PracticeSettings", () => {
  it("chooses local candidates, schedules idle practice, and applies a recommendation", async () => {
    render(<PracticeSettings className="" />);
    const big = await screen.findByRole("checkbox", { name: "big" });
    expect(screen.queryByRole("checkbox", { name: "glm-5.3:cloud" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "nomic-embed-text:latest" })).toBeNull();
    fireEvent.click(big);
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ ...CONFIG, candidates: ["small", "big"] }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Practice while this PC is idle/ }));
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));

    fireEvent.click(screen.getByRole("button", { name: "Practice now" }));
    const report = await screen.findByLabelText("Latest practice report");
    expect(report.textContent).toContain("6 recorded turns, 3 re-run in a disposable copy · original models passed 1 of 3");
    expect(report.textContent).toContain("small90%100%0.9s3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Use small for chat" }));
    expect(updateSettings).toHaveBeenCalledWith({ model: "small" });
  });

  it("shows why a run failed", async () => {
    run.mockRejectedValueOnce(new Error("No recorded traces yet."));
    render(<PracticeSettings className="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Practice now" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Practice run failed: No recorded traces yet."));
  });
});
