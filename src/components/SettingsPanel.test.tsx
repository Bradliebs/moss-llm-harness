// @vitest-environment jsdom
//
// src/components/SettingsPanel.test.tsx
//
// The settings store logic is covered by settings.test.ts; here the store is
// mocked so the component is tested in isolation: it renders the provider
// presets and routes form edits to applyPreset / updateSettings. window.moss is
// stubbed for the read-only MCP status effect that runs on mount.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as settings from "../lib/settings";
import * as avatar from "../lib/avatar";
import { SettingsPanel } from "./SettingsPanel";

const settingsValue: Record<string, unknown> & { avatarDataUrl: string | null } = {
  presetIndex: 0,
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "",
  avatarDataUrl: null,
  enableTools: true,
  maxToolRounds: 8,
  workspaceRoot: null,
  sttBaseUrl: "",
  sttModel: "whisper-1",
  emailApiKey: "",
  emailFrom: "",
  embedBaseUrl: "",
  embedModel: "nomic-embed-text",
  verifyEnabled: false,
  verifyCommands: "",
};

vi.mock("../lib/avatar", () => ({
  createAvatarDataUrl: vi.fn(() => Promise.resolve("data:image/webp;base64,custom-avatar")),
}));

vi.mock("../lib/settings", () => ({
  PROVIDER_PRESETS: [
    { id: "ollama", label: "Ollama" },
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "mistral", label: "Mistral" },
    { id: "xai", label: "xAI (Grok)" },
    { id: "custom", label: "Custom" },
  ],
  READINESS_PROFILES: [
    { id: "chat", label: "Chat only", description: "Model conversation without workspace tools" },
    { id: "coding", label: "Coding", description: "Workspace tools with explicit approval and verification" },
    { id: "research", label: "Research", description: "Browser-capable tools with explicit approval" },
    { id: "desktop", label: "Desktop automation", description: "Windows automation with explicit approval" },
    { id: "custom", label: "Custom", description: "Keep full control of every setting" },
  ],
  readinessItems: vi.fn(() => [
    { id: "provider", label: "Provider and model", detail: "Choose a provider and model.", status: "attention" },
    { id: "workspace", label: "Workspace", detail: "No workspace selected.", status: "attention" },
  ]),
  readinessProfilePatch: vi.fn((profile: string) => ({ readinessProfile: profile })),
  applyPreset: vi.fn(),
  saveProviderCredential: vi.fn(() => Promise.resolve()),
  updateSettings: vi.fn(),
  toProviderConfig: vi.fn(() => ({})),
  toEmbedConfig: vi.fn(() => ({ baseUrl: "http://x", model: "nomic-embed-text" })),
  modelsStore: { use: vi.fn(() => []), set: vi.fn() },
  mcpAddFormTypeStore: { get: vi.fn(() => "stdio"), set: vi.fn() },
  useSettings: vi.fn(() => settingsValue),
}));

beforeEach(() => {
  settingsValue.avatarDataUrl = null;
  Object.assign(window, {
    moss: {
      mcp: {
        status: vi.fn(() => Promise.resolve([])),
        openConfig: vi.fn(),
        setEnabled: vi.fn(() => Promise.resolve([])),
        add: vi.fn(() => Promise.resolve([])),
        update: vi.fn(() => Promise.resolve([])),
        remove: vi.fn(() => Promise.resolve([])),
        servers: vi.fn(() => Promise.resolve([])),
        reconnect: vi.fn(() => Promise.resolve([])),
      },
      provider: {
        listModels: vi.fn(() => Promise.resolve([])),
        getCredential: vi.fn(() => Promise.resolve("")),
        setCredential: vi.fn(() => Promise.resolve()),
      },
      workspace: { pick: vi.fn(() => Promise.resolve(null)) },
      codebase: {
        status: vi.fn(() => Promise.resolve({ indexed: false, files: 0, chunks: 0, model: "" })),
        reindex: vi.fn(() => Promise.resolve({ ok: true, files: 0, chunks: 0, skipped: 0 })),
      },
      clipboard: { write: vi.fn(() => Promise.resolve()) },
      diagnostics: {
        list: vi.fn(() => Promise.resolve({
          config: { enabled: false, retentionDays: 30 },
          entries: [{
            id: "event-1",
            occurredAt: "2026-01-01T00:00:00.000Z",
            kind: "turn-settled",
            outcome: "completed",
          }],
        })),
        configure: vi.fn((config) => Promise.resolve(config)),
        clear: vi.fn(() => Promise.resolve()),
        record: vi.fn(() => Promise.resolve()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { moss?: unknown }).moss;
});

describe("SettingsPanel", () => {
  it("navigates categorized routes and applies a readiness profile", () => {
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByText("Provider").closest("section")?.className).not.toContain("hidden");
    expect(screen.getByRole("heading", { name: "Readiness" }).closest("section")?.className).toContain("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Readiness" }));
    fireEvent.click(screen.getByRole("button", { name: /^Coding/ }));
    expect(settings.readinessProfilePatch).toHaveBeenCalledWith("coding", settingsValue);
    expect(settings.updateSettings).toHaveBeenCalledWith({ readinessProfile: "coding" });
  });

  it("filters category navigation and copies redacted readiness diagnostics", async () => {
    settingsValue.workspaceRoot = "C:\\secret\\project";
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "provider" } });
    expect(screen.getByRole("button", { name: "Models" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Automation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));

    await waitFor(() => expect(window.moss.clipboard.write).toHaveBeenCalled());
    const payload = String(vi.mocked(window.moss.clipboard.write).mock.calls[0][0]);
    expect(payload).not.toContain("C:\\secret\\project");
    expect(payload).toContain("Workspace selected.");
    settingsValue.workspaceRoot = null;
  });

  it("manages opt-in local product diagnostics", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(await screen.findByText("1 retained event")).toBeDefined();

    fireEvent.click(screen.getByRole("checkbox", { name: /Collect local product diagnostics/ }));
    await waitFor(() => expect(window.moss.diagnostics.configure).toHaveBeenCalledWith({
      enabled: true,
      retentionDays: 30,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Clear diagnostics" }));
    await waitFor(() => expect(window.moss.diagnostics.clear).toHaveBeenCalledOnce());
  });

  it("exposes modal semantics, closes on Escape, and restores focus", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(<SettingsPanel onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("announces provider failures as an alert", async () => {
    window.moss.provider.listModels = vi.fn(() => Promise.reject(new Error("offline")));

    render(<SettingsPanel onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Models error: offline");
  });

  it("renders every provider preset as an option", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    expect(screen.getByRole("option", { name: "Ollama" })).toBeDefined();
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeDefined();
    expect(screen.getByRole("option", { name: "OpenRouter" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Mistral" })).toBeDefined();
    expect(screen.getByRole("option", { name: "xAI (Grok)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Custom" })).toBeDefined();
  });

  it("refreshes the provider model list when settings opens", async () => {
    window.moss.provider.listModels = vi.fn(() => Promise.resolve(["glm-5.3-flash:cloud"]));

    render(<SettingsPanel onClose={() => {}} />);

    await waitFor(() => expect(settings.modelsStore.set).toHaveBeenCalledWith(["glm-5.3-flash:cloud"]));
    expect(window.moss.provider.listModels).toHaveBeenCalledWith({});
  });

  it("applies a preset when the select changes", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.change(screen.getByDisplayValue("Ollama"), { target: { value: "2" } });
    expect(settings.applyPreset).toHaveBeenCalledWith(2);
  });

  it("updates the base URL on input", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.change(screen.getByDisplayValue("http://localhost:11434/v1"), {
      target: { value: "http://localhost:9999/v1" },
    });
    expect(settings.updateSettings).toHaveBeenCalledWith({ baseUrl: "http://localhost:9999/v1" });
  });

  it("saves the active provider API key when the field loses focus", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const input = screen.getByPlaceholderText("API key");
    fireEvent.change(input, { target: { value: "provider-secret" } });
    fireEvent.blur(input, { target: { value: "provider-secret" } });
    await waitFor(() => expect(settings.saveProviderCredential).toHaveBeenCalledWith("provider-secret"));
  });

  it("stores a selected Moss avatar", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const file = new File(["image"], "moss.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Choose Moss avatar"), { target: { files: [file] } });

    await waitFor(() => expect(avatar.createAvatarDataUrl).toHaveBeenCalledWith(file));
    expect(settings.updateSettings).toHaveBeenCalledWith({
      avatarDataUrl: "data:image/webp;base64,custom-avatar",
    });
  });

  it("restores the default Moss avatar", () => {
    settingsValue.avatarDataUrl = "data:image/webp;base64,custom-avatar";
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Use default" }));

    expect(settings.updateSettings).toHaveBeenCalledWith({ avatarDataUrl: null });
  });

  it("toggles tools via the checkbox", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Enable tools and skills"));
    expect(settings.updateSettings).toHaveBeenCalledWith({ enableTools: false });
  });

  it("updates and clamps the tool-round limit", () => {
    render(<SettingsPanel onClose={() => {}} />);
    const input = screen.getByLabelText("Tool rounds per turn");

    fireEvent.change(input, { target: { value: "32" } });
    expect(settings.updateSettings).toHaveBeenCalledWith({ maxToolRounds: 32 });

    fireEvent.change(input, { target: { value: "100" } });
    expect(settings.updateSettings).toHaveBeenCalledWith({ maxToolRounds: 64 });
  });

  it("updates the proactive context limit and explains semantic compaction", () => {
    render(<SettingsPanel onClose={() => {}} />);
    const input = screen.getByLabelText("Token limit (optional)");

    fireEvent.change(input, { target: { value: "8192" } });

    expect(settings.updateSettings).toHaveBeenCalledWith({ contextLimit: 8192 });
    expect(screen.getByText(/summarize old turns/)).toBeDefined();
    expect(screen.getByText(/Saved history stays unchanged/)).toBeDefined();
    expect(screen.getByText(/Moss still compacts the model-facing history and retries once/)).toBeDefined();
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles a disabled MCP server on via its checkbox", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: false, connected: false, toolCount: 0 }]),
    );
    window.moss.mcp.setEnabled = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: true, connected: true, toolCount: 1 }]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("disabled")).toBeDefined());
    fireEvent.click(screen.getByLabelText("playwright"));
    expect(window.moss.mcp.setEnabled).toHaveBeenCalledWith("playwright", true);
    await waitFor(() => expect(screen.getByText("connected \u00b7 1 tools")).toBeDefined());
  });

  it("shows a working state and disables the checkbox while a toggle is in flight", async () => {
    let resolveToggle!: (value: unknown) => void;
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: false, connected: false, toolCount: 0 }]),
    );
    window.moss.mcp.setEnabled = vi.fn(() => new Promise((resolve) => {
      resolveToggle = resolve;
    }));
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("disabled")).toBeDefined());
    fireEvent.click(screen.getByLabelText("playwright"));
    await waitFor(() => expect(screen.getByText("working\u2026")).toBeDefined());
    expect((screen.getByLabelText("playwright") as HTMLInputElement).disabled).toBe(true);
    resolveToggle([{ id: "playwright", enabled: true, connected: true, toolCount: 1 }]);
    await waitFor(() => expect(screen.getByText("connected \u00b7 1 tools")).toBeDefined());
  });

  it("adds a stdio server from the form", async () => {
    window.moss.mcp.add = vi.fn(() =>
      Promise.resolve([{ id: "echo", enabled: false, connected: false, toolCount: 0 }]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.change(screen.getByLabelText("New server id"), { target: { value: "echo" } });
    fireEvent.change(screen.getByLabelText("New server command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("New server args"), { target: { value: "-y echo-mcp" } });
    fireEvent.click(screen.getByText("Add stdio server"));
    expect(window.moss.mcp.add).toHaveBeenCalledWith({
      type: "stdio",
      id: "echo",
      command: "npx",
      args: ["-y", "echo-mcp"],
      enabled: false,
    });
    await waitFor(() => expect(screen.getByLabelText("echo")).toBeDefined());
  });

  it("adds an http server when the type is switched", async () => {
    window.moss.mcp.add = vi.fn(() =>
      Promise.resolve([{ id: "remote", enabled: false, connected: false, toolCount: 0 }]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    fireEvent.change(screen.getByLabelText("New server type"), { target: { value: "http" } });
    fireEvent.change(screen.getByLabelText("New server id"), { target: { value: "remote" } });
    fireEvent.change(screen.getByLabelText("New server url"), { target: { value: "https://host/mcp" } });
    fireEvent.click(screen.getByText("Add http server"));
    expect(window.moss.mcp.add).toHaveBeenCalledWith({
      type: "http",
      id: "remote",
      url: "https://host/mcp",
      enabled: false,
    });
    expect(settings.mcpAddFormTypeStore.set).toHaveBeenCalledWith("http");
    await waitFor(() => expect(screen.getByLabelText("remote")).toBeDefined());
  });

  it("shows the tool names as a tooltip on a connected server", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([
        {
          id: "playwright",
          enabled: true,
          connected: true,
          toolCount: 2,
          tools: ["browser_navigate", "browser_click"],
        },
      ]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    const label = await screen.findByText("connected \u00b7 2 tools");
    expect(label.getAttribute("title")).toBe("browser_navigate, browser_click");
  });

  it("rejects a duplicate server id without calling add", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: false, connected: false, toolCount: 0 }]),
    );
    window.moss.mcp.add = vi.fn(() => Promise.resolve([]));
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("disabled")).toBeDefined());
    fireEvent.change(screen.getByLabelText("New server id"), { target: { value: "playwright" } });
    fireEvent.change(screen.getByLabelText("New server command"), { target: { value: "npx" } });
    fireEvent.click(screen.getByText("Add stdio server"));
    expect(window.moss.mcp.add).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("A server named playwright already exists")).toBeDefined());
  });

  it("edits a server: populates the form from its config and saves changes", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: true, connected: true, toolCount: 1 }]),
    );
    window.moss.mcp.servers = vi.fn(() =>
      Promise.resolve([{ type: "stdio", id: "playwright", command: "npx", args: ["-y", "playwright-mcp"] }]),
    );
    window.moss.mcp.update = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: true, connected: true, toolCount: 1 }]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("connected \u00b7 1 tools")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Edit playwright"));
    expect((screen.getByLabelText("New server command") as HTMLInputElement).value).toBe("npx");
    expect((screen.getByLabelText("New server args") as HTMLInputElement).value).toBe("-y playwright-mcp");
    fireEvent.change(screen.getByLabelText("New server command"), { target: { value: "node" } });
    fireEvent.click(screen.getByText("Save changes"));
    expect(window.moss.mcp.update).toHaveBeenCalledWith({
      type: "stdio",
      id: "playwright",
      command: "node",
      args: ["-y", "playwright-mcp"],
      enabled: true,
    });
  });

  it("removes a server via its remove button", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: false, connected: false, toolCount: 0 }]),
    );
    window.moss.mcp.remove = vi.fn(() => Promise.resolve([]));
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("disabled")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Remove playwright"));
    expect(window.moss.mcp.remove).toHaveBeenCalledWith("playwright");
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
  });

  it("shows a retry button on an errored server and reconnects on click", async () => {
    window.moss.mcp.status = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: true, connected: false, toolCount: 0, error: "boom" }]),
    );
    window.moss.mcp.reconnect = vi.fn(() =>
      Promise.resolve([{ id: "playwright", enabled: true, connected: true, toolCount: 2 }]),
    );
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("error: boom")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Retry playwright"));
    expect(window.moss.mcp.reconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("connected \u00b7 2 tools")).toBeDefined());
  });

  it("shows an approximate token count for custom instructions", async () => {
    vi.mocked(settings.useSettings).mockReturnValue({ ...settingsValue, customInstructions: "abcdefgh" });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No MCP servers configured or connected.")).toBeDefined());
    // 8 chars / 4 = 2 tokens.
    expect(screen.getByText(/8 \/ 2000 chars .* ~2 tokens/)).toBeDefined();
  });
});
