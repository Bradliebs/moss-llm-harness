// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplayReport } from "@common/types";

import { RoutingSettings } from "./RoutingSettings";

const updateSettings = vi.fn();
const settings = vi.hoisted(() => ({
  value: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "small", apiKey: "" } as Record<string, unknown>,
}));

vi.mock("../lib/settings", () => ({
  useSettings: () => settings.value,
  modelsStore: { use: () => ["small", "fast", "big"] },
  toProviderConfig: (s: { kind: string; baseUrl: string; model: string }) => ({ kind: s.kind, baseUrl: s.baseUrl, model: s.model }),
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

const report: ReplayReport = {
  schemaVersion: 1,
  traceId: "trace-1",
  baselineModel: "small",
  candidateModel: "big",
  replayedAt: "2026-09-26T10:00:00.000Z",
  calls: [
    { index: 0, baseline: { toolNames: ["read_file"], answered: false }, candidate: { toolNames: ["read_file"], answered: false, validArguments: true, unknownArguments: [], text: "", durationMs: 900 }, agreement: "same-action" },
    { index: 1, baseline: { toolNames: [], answered: true }, candidate: { toolNames: ["run_command"], answered: false, validArguments: false, unknownArguments: ["run_command.cmd"], text: "", durationMs: 1_100 }, agreement: "called-tool-instead" },
  ],
  summary: { calls: 2, sameAction: 1, agreementRate: 0.5, validArgumentRate: 0.5, errors: 0, medianLatencyMs: 1_100, baselineMedianLatencyMs: 2_000, inputTokens: 10, outputTokens: 4 },
};

beforeEach(() => {
  settings.value = { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "small", apiKey: "" };
  Object.assign(window, {
    moss: {
      model: {
        profiles: vi.fn(async () => [{ model: "fast", providerKind: "openai-compatible", endpoint: "http://localhost:11434/v1", tier: "capable", overall: 0.7, latency: { medianMs: 800, p90Ms: 1_000 } }]),
      },
      traces: {
        list: vi.fn(async () => ({ count: 1, dir: "C:\\traces", traces: [{ id: "trace-1", createdAt: "2026-09-26T09:00:00.000Z", primaryModel: "small", callCount: 2, toolCallCount: 1, outcome: "completed", preview: "read the file" }] })),
        clear: vi.fn(async () => undefined),
        openFolder: vi.fn(async () => "C:\\traces"),
        replay: vi.fn(async () => report),
        cancelReplay: vi.fn(async () => undefined),
        onReplayProgress: vi.fn(() => () => undefined),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  updateSettings.mockReset();
  Reflect.deleteProperty(window, "moss");
});

describe("RoutingSettings", () => {
  it("offers other models with their measured profiles and saves routing choices", async () => {
    render(<RoutingSettings className="" />);
    const fast = screen.getByLabelText("Fast model for summaries and read-only subagents");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "fast (capable, 70%, 0.8s)" })).toHaveLength(2));
    expect([...fast.querySelectorAll("option")].map((option) => option.value)).toEqual(["", "fast", "big"]);
    fireEvent.change(fast, { target: { value: "fast" } });
    fireEvent.change(screen.getByLabelText("Escalation model"), { target: { value: "big" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Adapt to the measured capability profile/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Record turn traces for replay/ }));
    expect(updateSettings).toHaveBeenCalledWith({ fastModel: "fast" });
    expect(updateSettings).toHaveBeenCalledWith({ escalationModel: "big" });
    expect(updateSettings).toHaveBeenCalledWith({ adaptiveScaffolding: false });
    expect(updateSettings).toHaveBeenCalledWith({ recordTraces: true });
    expect((screen.getByLabelText("After rejections") as HTMLInputElement).disabled).toBe(true);
  });

  it("replays a recorded trace against a chosen model and shows the comparison", async () => {
    render(<RoutingSettings className="" />);
    await screen.findByText("1 recorded trace");
    fireEvent.change(screen.getByLabelText("Replay against"), { target: { value: "big" } });
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(screen.getByLabelText("Replay results")).toBeDefined());
    expect(window.moss.traces!.replay).toHaveBeenCalledWith({ traceId: "trace-1", config: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "big" } });
    expect(screen.getByRole("status").textContent).toBe("big made the same decision as small on 1 of 2 calls.");
    expect(screen.getByLabelText("Replay results").textContent).toContain("unknown arguments: run_command.cmd");
    expect(screen.getByLabelText("Replay results").textContent).toContain("(original 2.0s)");
  });

  it("opens and deletes the trace folder", async () => {
    render(<RoutingSettings className="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Deleted all recorded traces."));
    expect(window.moss.traces!.openFolder).toHaveBeenCalledOnce();
    expect(window.moss.traces!.clear).toHaveBeenCalledOnce();
  });
});
