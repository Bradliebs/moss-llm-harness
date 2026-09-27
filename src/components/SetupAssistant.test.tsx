// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupDetection } from "@common/types";

import { SetupAssistant } from "./SetupAssistant";

const updateSettings = vi.fn();
const applyPreset = vi.fn(async (index: number) => { state.settings = { ...state.settings, presetIndex: index }; });
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("../lib/settings", () => ({
  PROVIDER_PRESETS: [
    { id: "ollama", label: "Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
    { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "custom", label: "Custom", kind: "openai-compatible", baseUrl: "" },
  ],
  useSettings: () => state.settings,
  settingsStore: { get: () => state.settings },
  updateSettings: (patch: Record<string, unknown>) => {
    updateSettings(patch);
    state.settings = { ...state.settings, ...patch };
  },
  applyPreset: (index: number) => applyPreset(index),
}));

const DETECTION: SetupDetection = {
  ollama: { baseUrl: "http://localhost:11434/v1", models: [{ name: "mid:8b", sizeBytes: 4.9e9, parameterSize: "8B" }, { name: "small:1.5b", sizeBytes: 1e9, parameterSize: "1.5B" }] },
  gpu: { name: "RTX", totalMiB: 8192, freeMiB: 7600 },
  cloud: [],
};

beforeEach(() => {
  state.settings = { presetIndex: 1, model: "", kind: "anthropic", baseUrl: "https://api.anthropic.com" };
});
afterEach(() => {
  cleanup();
  updateSettings.mockReset();
  applyPreset.mockClear();
  Reflect.deleteProperty(window, "moss");
});

describe("SetupAssistant", () => {
  it("detects the PC, lets the user untick lines, and applies settings then actions in order", async () => {
    const pull = vi.fn(async () => undefined);
    const probe = vi.fn(async () => ({ tier: "capable", overall: 0.8 }));
    const inspectContext = vi.fn(async () => ({ model: "mid:8b", status: "too-small", reason: "small", recommendedContext: 16_384, variant: "mid:8b-ctx16k" }));
    const createContextVariant = vi.fn(async () => "mid:8b-ctx16k");
    const detect = vi.fn(async () => DETECTION);
    Object.assign(window, { moss: { setup: { detect, pull }, model: { profiles: async () => [], performance: async () => [], probe, inspectContext, createContextVariant } } });
    render(<SetupAssistant className="" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up for this PC" }));
    const proposal = await screen.findByLabelText("Setup proposal");
    expect(detect).toHaveBeenCalledWith({ ollamaBaseUrl: "http://localhost:11434/v1", cloud: [{ presetId: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" }] });
    expect(proposal.textContent).toContain("Chat model: mid:8b");
    // Keep profiling off for this run.
    fireEvent.click(screen.getByRole("checkbox", { name: /Profile mid:8b and small:1.5b/ }));
    fireEvent.click(screen.getByRole("button", { name: /Apply 4 items/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Applied 4 setup items. Approval settings were not changed."));
    expect(applyPreset).toHaveBeenCalledWith(0);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ model: "mid:8b", fastModel: "small:1.5b", embedModel: "nomic-embed-text", semanticRanking: true }));
    expect(pull).toHaveBeenCalledWith("http://localhost:11434/v1", "nomic-embed-text");
    expect(probe).not.toHaveBeenCalled();
    expect(createContextVariant).toHaveBeenCalledWith("http://localhost:11434/v1", "mid:8b", 16_384);
    expect(updateSettings).toHaveBeenLastCalledWith({ model: "mid:8b-ctx16k" });
    expect(screen.getByLabelText("Setup progress").textContent).toContain("✓ Check mid:8b's context window — created mid:8b-ctx16k");
  });

  it("reports failed steps without stopping the rest", async () => {
    Object.assign(window, { moss: {
      setup: { detect: async () => DETECTION, pull: async () => { throw new Error("offline"); } },
      model: { profiles: async () => [], performance: async () => [], probe: vi.fn(), inspectContext: async () => ({ model: "mid:8b", status: "ok", reason: "Fine." }), createContextVariant: vi.fn() },
    } });
    render(<SetupAssistant className="" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up for this PC" }));
    await screen.findByLabelText("Setup proposal");
    for (const name of [/Chat model/, /Fast model/, /Profile/]) fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.click(screen.getByRole("button", { name: /Apply 2 items/ }));
    // A failure is announced as an alert.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Applied 2 setup items; 1 step failed."));
    expect(screen.getByLabelText("Setup progress").textContent).toContain("✗ Download nomic-embed-text — offline");
    expect(screen.getByLabelText("Setup progress").textContent).toContain("✓ Check mid:8b's context window — Fine.");
    expect(applyPreset).not.toHaveBeenCalled();
  });

  it("routes the fast model to Ollama when the chat model stays on another provider", async () => {
    Object.assign(window, { moss: {
      setup: { detect: async () => DETECTION, pull: vi.fn() },
      model: { profiles: async () => [], performance: async () => [], probe: vi.fn(), inspectContext: vi.fn(), createContextVariant: vi.fn() },
    } });
    render(<SetupAssistant className="" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up for this PC" }));
    await screen.findByLabelText("Setup proposal");
    for (const name of [/Chat model/, /Profile/, /Check mid/, /rank tools/i]) fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.click(screen.getByRole("button", { name: /Apply 1 item/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      fastModel: undefined,
      fastRoute: { presetId: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "small:1.5b" },
    }));
  });
});
