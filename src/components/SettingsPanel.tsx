// src/components/SettingsPanel.tsx
//
// Settings overlay: provider connection, model, tool permissions, MCP server
// status (read-only), and the tool workspace. Opened from the sidebar/header.
// All provider/model/permission values are persisted via the settings store, so
// switching here takes effect on the next turn and survives a reload.

import { useCallback, useEffect, useState } from "react";

import type { InjectionMode, McpServerStatus, MemoryEntry } from "@common/types";import { PERSONALITY_PRESETS } from "@common/personalities";

import { createAvatarDataUrl } from "../lib/avatar";
import {
  PROVIDER_PRESETS,
  applyPreset,
  mcpAddFormTypeStore,
  modelsStore,
  saveProviderCredential,
  setModelRate,
  toEmbedConfig,
  toProviderConfig,
  updateSettings,
  useSettings,
} from "../lib/settings";
import { MossFace } from "./MossFace";
import { JevSettings } from "./JevSettings";

export function SettingsPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const settings = useSettings();
  const models = modelsStore.use();
  const [status, setStatus] = useState("");
  const [mcp, setMcp] = useState<McpServerStatus[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [configs, setConfigs] = useState<MossMcpServerInput[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newType, setNewType] = useState<"stdio" | "http">(() => mcpAddFormTypeStore.get());
  const [newId, setNewId] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const [indexing, setIndexing] = useState(false);
  const [indexMsg, setIndexMsg] = useState("");

  const [pendingMemory, setPendingMemory] = useState<MemoryEntry[]>([]);

  const currentModelRate = settings.modelRates?.[settings.model.trim().toLowerCase()];

  async function chooseAvatar(file: File): Promise<void> {
    setStatus("Preparing Moss avatar...");
    try {
      updateSettings({ avatarDataUrl: await createAvatarDataUrl(file) });
      setStatus("Moss avatar updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not use that image");
    }
  }

  const refreshPendingMemory = useCallback(async () => {
    try {
      setPendingMemory(await window.moss.memory.reviewList());
    } catch {
      setPendingMemory([]);
    }
  }, []);

  useEffect(() => {
    void refreshPendingMemory();
  }, [refreshPendingMemory]);

  const refreshMcp = useCallback(async () => {
    try {
      const [statuses, servers] = await Promise.all([
        window.moss.mcp.status(),
        window.moss.mcp.servers(),
      ]);
      setMcp(statuses);
      setConfigs(servers);
    } catch {
      setMcp([]);
      setConfigs([]);
    }
  }, []);

  useEffect(() => {
    void refreshMcp();
  }, [refreshMcp]);

  useEffect(() => {
    const api = window.moss.codebase;
    const root = settings.workspaceRoot;
    if (!api || !root) return;
    void api
      .status(root)
      .then((s) => {
        if (s.indexed) setIndexMsg(`Indexed ${s.files} files, ${s.chunks} chunks${s.model ? ` (${s.model})` : ""}.`);
      })
      .catch(() => {});
  }, [settings.workspaceRoot]);

  async function runIndex(): Promise<void> {
    const root = settings.workspaceRoot;
    if (!root) {
      setIndexMsg("Select a workspace folder first.");
      return;
    }
    setIndexing(true);
    setIndexMsg("Indexing…");
    try {
      const res = await window.moss.codebase.reindex(root, toEmbedConfig(settings));
      setIndexMsg(
        res.ok
          ? `Indexed ${res.files} files, ${res.chunks} chunks (${res.skipped} unchanged).`
          : `Index failed: ${res.error ?? "unknown error"}`,
      );
    } catch (err) {
      setIndexMsg(`Index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIndexing(false);
    }
  }

  async function loadModels(): Promise<void> {
    setStatus("Loading models…");
    try {
      const list = await window.moss.provider.listModels(toProviderConfig(settings));
      modelsStore.set(list);
      if (list.length > 0 && !settings.model) updateSettings({ model: list[0] });
      setStatus(`${list.length} models`);
    } catch (err) {
      setStatus(`Models error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    void loadModels();
  }, []);

  async function persistApiKey(apiKey: string): Promise<void> {
    setStatus("Saving API key...");
    try {
      await saveProviderCredential(apiKey);
      setStatus(apiKey.trim() ? "API key saved securely" : "API key removed");
    } catch (error) {
      setStatus(`API key error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function pickWorkspace(): Promise<void> {
    const dir = await window.moss.workspace.pick();
    if (dir) updateSettings({ workspaceRoot: dir });
  }

  async function openMcpConfig(): Promise<void> {
    const path = await window.moss.mcp.openConfig();
    setStatus(path ? `Opened ${path}` : "Could not open MCP config");
  }

  async function toggleMcp(id: string, enabled: boolean): Promise<void> {
    setPendingId(id);
    setStatus(enabled ? `Starting ${id}\u2026` : `Stopping ${id}\u2026`);
    try {
      setMcp(await window.moss.mcp.setEnabled(id, enabled));
      setStatus(enabled ? `Enabled ${id}` : `Disabled ${id}`);
    } catch {
      setStatus(`Could not update ${id}`);
      void refreshMcp();
    } finally {
      setPendingId(null);
    }
  }

  function resetForm(): void {
    setEditingId(null);
    setNewType(mcpAddFormTypeStore.get());
    setNewId("");
    setNewCommand("");
    setNewArgs("");
    setNewUrl("");
  }

  function editServer(id: string): void {
    const cfg = configs.find((c) => c.id === id);
    if (!cfg) {
      setStatus(`No saved config for ${id}`);
      return;
    }
    setEditingId(id);
    setNewId(cfg.id);
    setNewType(cfg.type);
    if (cfg.type === "stdio") {
      setNewCommand(cfg.command);
      setNewArgs((cfg.args ?? []).join(" "));
      setNewUrl("");
    } else {
      setNewUrl(cfg.url);
      setNewCommand("");
      setNewArgs("");
    }
  }

  async function submitServer(): Promise<void> {
    const id = newId.trim();
    // Validate before any write so the user sees why, not a generic failure.
    if (!id) {
      setStatus("Server id is required");
      return;
    }
    if (newType === "stdio" && !newCommand.trim()) {
      setStatus("Command is required for a stdio server");
      return;
    }
    if (newType === "http" && !newUrl.trim()) {
      setStatus("URL is required for an http server");
      return;
    }
    if (!editingId && mcp.some((s) => s.id === id)) {
      setStatus(`A server named ${id} already exists`);
      return;
    }

    // Editing preserves the server's current enabled state (the form does not
    // expose it); adding starts disabled so it does not connect unexpectedly.
    const enabled = editingId ? (mcp.find((s) => s.id === editingId)?.enabled ?? false) : false;
    const config: MossMcpServerInput =
      newType === "stdio"
        ? {
            type: "stdio",
            id,
            command: newCommand.trim(),
            args: newArgs.trim().split(/\s+/).filter(Boolean),
            enabled,
          }
        : { type: "http", id, url: newUrl.trim(), enabled };

    setStatus(editingId ? `Saving ${id}\u2026` : `Adding ${id}\u2026`);
    try {
      setMcp(editingId ? await window.moss.mcp.update(config) : await window.moss.mcp.add(config));
      setStatus(editingId ? `Saved ${id}` : `Added ${id}`);
      resetForm();
      // Keep the edit-form source of truth current without clobbering the fresh
      // status the mutation just returned.
      window.moss.mcp
        .servers()
        .then(setConfigs)
        .catch(() => undefined);
    } catch {
      setStatus(editingId ? `Could not save ${id}` : `Could not add ${id}`);
      void refreshMcp();
    }
  }

  async function removeServer(id: string): Promise<void> {
    setPendingId(id);
    setStatus(`Removing ${id}\u2026`);
    try {
      setMcp(await window.moss.mcp.remove(id));
      setStatus(`Removed ${id}`);
    } catch {
      setStatus(`Could not remove ${id}`);
      void refreshMcp();
    } finally {
      setPendingId(null);
    }
  }

  async function reconnectServer(id: string): Promise<void> {
    setPendingId(id);
    setStatus(`Reconnecting ${id}\u2026`);
    try {
      setMcp(await window.moss.mcp.reconnect(id));
      setStatus(`Reconnected ${id}`);
    } catch {
      setStatus(`Could not reconnect ${id}`);
      void refreshMcp();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/50">
      <div className="flex h-full w-[28rem] max-w-full flex-col border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
        <header className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Settings</h2>
          <button className="text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Appearance</h3>
            <div className="flex items-center gap-3 rounded border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <MossFace className="h-14 w-14" label="Current Moss avatar" />
              <div className="min-w-0 flex-1">
                <span className="mb-2 block text-neutral-600 dark:text-neutral-400">Moss avatar</span>
                <div className="flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded bg-neutral-200 px-2 py-1 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700">
                    Choose image
                    <input
                      className="sr-only"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label="Choose Moss avatar"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void chooseAvatar(file);
                      }}
                    />
                  </label>
                  {settings.avatarDataUrl ? (
                    <button
                      className="rounded bg-neutral-200 px-2 py-1 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                      onClick={() => {
                        updateSettings({ avatarDataUrl: null });
                        setStatus("Default Moss avatar restored");
                      }}
                    >
                      Use default
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Theme</span>
              <select
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                value={settings.theme}
                onChange={(e) =>
                  updateSettings({
                    theme: e.target.value === "light" ? "light" : e.target.value === "auto" ? "auto" : "dark",
                  })
                }
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="auto">Auto (system)</option>
              </select>
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Provider</h3>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Preset</span>
              <select
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                value={settings.presetIndex}
                onChange={(e) => void applyPreset(Number(e.target.value))}
              >
                {PROVIDER_PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Base URL</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="Base URL"
                value={settings.baseUrl}
                onChange={(e) => updateSettings({ baseUrl: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">API key (optional)</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                type="password"
                placeholder="API key"
                value={settings.apiKey}
                onChange={(e) => updateSettings({ apiKey: e.target.value })}
                onBlur={(e) => void persistApiKey(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Model</span>
              <div className="flex gap-2">
                {models.length > 0 ? (
                  <select
                    className="flex-1 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                    value={settings.model}
                    onChange={(e) => updateSettings({ model: e.target.value })}
                  >
                    <option value="">Select model…</option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="flex-1 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                    placeholder="Model"
                    value={settings.model}
                    onChange={(e) => updateSettings({ model: e.target.value })}
                  />
                )}
                <button
                  className="rounded bg-neutral-300 dark:bg-neutral-700 px-2 py-1 hover:bg-neutral-400 dark:hover:bg-neutral-600"
                  onClick={() => void loadModels()}
                >
                  Load
                </button>
              </div>
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Tools</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.enableTools}
                onChange={(e) => updateSettings({ enableTools: e.target.checked })}
              />
              Enable tools and skills
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.autoApproveTools}
                disabled={!settings.enableTools}
                onChange={(e) => updateSettings({ autoApproveTools: e.target.checked })}
              />
              Auto-approve all tool calls
            </label>
            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap">Tool rounds per turn</span>
              <input
                type="number"
                min={1}
                max={64}
                className="w-20 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                value={settings.maxToolRounds ?? 8}
                disabled={!settings.enableTools}
                onChange={(e) => updateSettings({
                  maxToolRounds: Math.min(64, Math.max(1, Math.floor(Number(e.target.value) || 8))),
                })}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Read-only tools always run automatically. When auto-approve is off, tools that write
              files or run commands pause for your approval before each call. Turn it on to skip those
              prompts — the workspace sandbox still confines file access either way. Increase tool
              rounds for long-running tasks; higher values can use more time and tokens.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Browser automation</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.browserEnabled === true}
                disabled={!settings.enableTools}
                onChange={(e) => updateSettings({ browserEnabled: e.target.checked })}
              />
              Enable isolated browser sessions
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed domains</span>
              <textarea
                className="h-20 w-full resize-y rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 font-mono text-xs"
                placeholder={"example.com\ndocs.example.com"}
                value={settings.browserAllowedDomains ?? ""}
                onChange={(e) => updateSettings({ browserAllowedDomains: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.browserHeadless !== false}
                onChange={(e) => updateSettings({ browserHeadless: e.target.checked })}
              />
              Run browser headlessly
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Windows desktop automation</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.desktopEnabled === true}
                disabled={!settings.enableTools}
                onChange={(e) => updateSettings({ desktopEnabled: e.target.checked })}
              />
              Enable semantic UI Automation
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed process names</span>
              <textarea
                className="h-16 w-full resize-y rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 font-mono text-xs"
                placeholder={"notepad.exe\nCode.exe"}
                value={settings.desktopAllowedProcesses ?? ""}
                onChange={(e) => updateSettings({ desktopAllowedProcesses: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed exact window titles</span>
              <textarea
                className="h-16 w-full resize-y rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 font-mono text-xs"
                value={settings.desktopAllowedWindows ?? ""}
                onChange={(e) => updateSettings({ desktopAllowedWindows: e.target.value })}
              />
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Custom instructions</h3>
            <textarea
              className="h-24 w-full resize-y rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
              placeholder="e.g. Always answer in British English and prefer functional style."
              maxLength={2000}
              value={settings.customInstructions ?? ""}
              onChange={(e) => updateSettings({ customInstructions: e.target.value })}
            />
            <p className="text-right text-xs text-neutral-500 dark:text-neutral-400">
              {(settings.customInstructions ?? "").length} / 2000 chars {"\u00b7"} ~
              {Math.ceil((settings.customInstructions ?? "").length / 4)} tokens
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Appended to Moss&apos;s base system prompt every turn, so you can set a persona or
              standing preferences. Because it is sent on every turn it costs context, so keep it
              short. The built-in safety rules are always kept and cannot be removed by this text.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Personality</h3>
            <select
              className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
              aria-label="Personality"
              value={settings.personalityId}
              onChange={(e) => updateSettings({ personalityId: e.target.value })}
            >
              {PERSONALITY_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {PERSONALITY_PRESETS.find((p) => p.id === settings.personalityId)?.description}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.adaptiveTone}
                onChange={(e) => updateSettings({ adaptiveTone: e.target.checked })}
              />
              Adaptive tone
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              When on, Moss adapts its tone to what it remembers about your preferences, so the
              persona shifts as your durable memory grows. The selected personality is the starting
              point; remembered preferences win when they conflict.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Speech-to-text</h3>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Transcription base URL (optional)</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="Falls back to the provider Base URL"
                value={settings.sttBaseUrl ?? ""}
                onChange={(e) => updateSettings({ sttBaseUrl: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Transcription model</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="whisper-1"
                value={settings.sttModel ?? "whisper-1"}
                onChange={(e) => updateSettings({ sttModel: e.target.value })}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              The mic button records audio and sends it to an OpenAI-compatible
              /audio/transcriptions endpoint (OpenAI, whisper.cpp, faster-whisper, LocalAI, …). The
              API key above is reused.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Email</h3>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Resend API key</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                type="password"
                placeholder="re_..."
                value={settings.emailApiKey ?? ""}
                onChange={(e) => updateSettings({ emailApiKey: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">From address</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="Moss &lt;noreply@yourdomain.com&gt;"
                value={settings.emailFrom ?? ""}
                onChange={(e) => updateSettings({ emailFrom: e.target.value })}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              The send_email tool delivers mail through Resend over HTTPS. Use a verified sender
              domain; sends are still approval-gated before they go out.
            </p>
          </section>

          <JevSettings />

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Memory review</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.gatedMemory ?? false}
                onChange={(e) => updateSettings({ gatedMemory: e.target.checked })}
              />
              Review the assistant's memory writes before saving
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              When on, the m_remember tool queues proposals here instead of saving them. Approve to
              commit a fact to durable memory, or reject to discard it.
            </p>
            {pendingMemory.length > 0 && (
              <ul className="space-y-1">
                {pendingMemory.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                  >
                    <span className="flex-1">
                      <span className="text-neutral-500">[{m.category}]</span> {m.fact}
                    </span>
                    <button
                      className="rounded bg-emerald-600 px-2 py-0.5 text-white"
                      onClick={async () => {
                        await window.moss.memory.reviewApprove(m.id);
                        void refreshPendingMemory();
                      }}
                    >
                      Approve
                    </button>
                    <button
                      className="rounded bg-neutral-500 px-2 py-0.5 text-white"
                      onClick={async () => {
                        await window.moss.memory.reviewReject(m.id);
                        void refreshPendingMemory();
                      }}
                    >
                      Reject
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pendingMemory.length === 0 && (settings.gatedMemory ?? false) && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">No proposals waiting.</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">External content</h3>
            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap">Injection scanning</span>
              <select
                className="rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                value={settings.injectionMode ?? "flag"}
                onChange={(e) => updateSettings({ injectionMode: e.target.value as InjectionMode })}
              >
                <option value="off">Off</option>
                <option value="flag">Flag (default)</option>
                <option value="block">Block high-confidence</option>
              </select>
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Scans output from web, fetch, and MCP tools for prompt-injection phrasing. Flag warns
              and keeps the content; block withholds high-confidence hits from the model. Content is
              always wrapped as untrusted regardless of this setting.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Confidence</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.showConfidence ?? false}
                onChange={(e) => updateSettings({ showConfidence: e.target.checked })}
              />
              Show a confidence chip after each reply
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              A shadow label derived from what happened in the turn (tools run, failures, external
              content). It never changes the answer and makes no extra model calls.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Budget</h3>
            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap">Daily cap (USD)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                className="w-24 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                value={settings.dailyBudgetUsd || 0}
                onChange={(e) => updateSettings({ dailyBudgetUsd: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Soft cap on estimated spend per UTC day across cloud models. 0 disables it. Once the
              day's estimated cost reaches the cap, new requests are paused until tomorrow. Uses the
              same rates as the cost readout.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Verification</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={settings.verifyEnabled}
                disabled={!settings.enableTools}
                onChange={(e) => updateSettings({ verifyEnabled: e.target.checked })}
              />
              Verify edits with commands
            </label>
            <textarea
              className="h-20 w-full resize-y rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 font-mono text-xs"
              placeholder={"npm run typecheck\nnpm test"}
              value={settings.verifyCommands ?? ""}
              onChange={(e) => updateSettings({ verifyCommands: e.target.value })}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              One command per line, run in the workspace after Moss edits files. The pass/fail output
              is fed back so Moss can correct its own changes. Commands run fail-fast and only when a
              workspace is selected.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Codebase index</h3>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Embeddings base URL (optional)</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="Falls back to the provider Base URL"
                value={settings.embedBaseUrl ?? ""}
                onChange={(e) => updateSettings({ embedBaseUrl: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Embeddings model</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                placeholder="nomic-embed-text"
                value={settings.embedModel ?? "nomic-embed-text"}
                onChange={(e) => updateSettings({ embedModel: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50"
              disabled={indexing || !settings.workspaceRoot}
              onClick={() => void runIndex()}
            >
              {indexing ? "Indexing…" : "Index workspace"}
            </button>
            {indexMsg ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{indexMsg}</p> : null}
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Builds a semantic index of the workspace's text files via an OpenAI-compatible
              /embeddings endpoint (Ollama's nomic-embed-text, OpenAI, …). The search_codebase tool
              then finds relevant code by meaning. Re-indexing only re-embeds changed files; binaries,
              build output, and .gitignore'd paths are skipped.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Context window</h3>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Token limit (optional)</span>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                type="number"
                min={0}
                placeholder="0 = off"
                value={settings.contextLimit || ""}
                onChange={(e) => updateSettings({ contextLimit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Set your model&apos;s context size to show a used/limit meter and summarize old turns before
              the limit is reached. Saved history stays unchanged. Left at 0, proactive compaction and
              the meter stay off; if the provider reports an overflow, Moss still compacts the
              model-facing history and retries once.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Model pricing</h3>
            {settings.model ? (
              <>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  USD per 1,000,000 tokens for <span className="text-neutral-700 dark:text-neutral-300">{settings.model}</span>.
                  Overrides the built-in estimate so the header cost is exact. Leave both at 0 to use the
                  built-in rate.
                </p>
                <div className="flex gap-2">
                  <label className="block flex-1">
                    <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Input $ / 1M</span>
                    <input
                      className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="0 = built-in"
                      value={currentModelRate?.inputPer1M || ""}
                      onChange={(e) =>
                        setModelRate(settings.model, {
                          inputPer1M: Math.max(0, Number(e.target.value) || 0),
                          outputPer1M: currentModelRate?.outputPer1M ?? 0,
                        })
                      }
                    />
                  </label>
                  <label className="block flex-1">
                    <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Output $ / 1M</span>
                    <input
                      className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="0 = built-in"
                      value={currentModelRate?.outputPer1M || ""}
                      onChange={(e) =>
                        setModelRate(settings.model, {
                          inputPer1M: currentModelRate?.inputPer1M ?? 0,
                          outputPer1M: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                  </label>
                </div>
              </>
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Pick a model above to set its pricing.</p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">MCP servers</h3>
              <button className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" onClick={() => void refreshMcp()}>
                Refresh
              </button>
            </div>
            {mcp.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">No MCP servers configured or connected.</p>
            ) : (
              <ul className="space-y-1">
                {mcp.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded bg-white dark:bg-neutral-900 px-2 py-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={pendingId === s.id}
                        onChange={(e) => void toggleMcp(s.id, e.target.checked)}
                      />
                      <span className="font-mono text-xs">{s.id}</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs ${s.connected ? "text-green-400" : "text-neutral-500 dark:text-neutral-400"}`}
                        title={s.connected && s.tools && s.tools.length > 0 ? s.tools.join(", ") : undefined}
                      >
                        {pendingId === s.id
                          ? "working\u2026"
                          : !s.enabled
                            ? "disabled"
                            : s.connected
                              ? `connected \u00b7 ${s.toolCount} tools`
                              : s.error
                                ? `error: ${s.error}`
                                : "disconnected"}
                      </span>
                      {s.enabled && !s.connected && s.error && pendingId !== s.id ? (
                        <button
                          className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                          aria-label={`Retry ${s.id}`}
                          onClick={() => void reconnectServer(s.id)}
                        >
                          Retry
                        </button>
                      ) : null}
                      <button
                        className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                        aria-label={`Edit ${s.id}`}
                        disabled={pendingId === s.id}
                        onClick={() => editServer(s.id)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-red-400"
                        aria-label={`Remove ${s.id}`}
                        disabled={pendingId === s.id}
                        onClick={() => void removeServer(s.id)}
                      >
                        {"\u2715"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1 rounded bg-white dark:bg-neutral-900 px-2 py-2">
              <select
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                aria-label="New server type"
                value={newType}
                disabled={editingId !== null}
                onChange={(e) => {
                  const t = e.target.value === "http" ? "http" : "stdio";
                  setNewType(t);
                  mcpAddFormTypeStore.set(t);
                }}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
              <input
                className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs disabled:opacity-50"
                placeholder="server id"
                aria-label="New server id"
                value={newId}
                disabled={editingId !== null}
                onChange={(e) => setNewId(e.target.value)}
              />
              {newType === "stdio" ? (
                <>
                  <input
                    className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                    placeholder="command (e.g. npx)"
                    aria-label="New server command"
                    value={newCommand}
                    onChange={(e) => setNewCommand(e.target.value)}
                  />
                  <input
                    className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                    placeholder="args (space-separated)"
                    aria-label="New server args"
                    value={newArgs}
                    onChange={(e) => setNewArgs(e.target.value)}
                  />
                </>
              ) : (
                <input
                  className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs"
                  placeholder="url (e.g. https://host/mcp)"
                  aria-label="New server url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
              )}
              <div className="flex gap-1">
                <button
                  className="flex-1 rounded bg-neutral-300 dark:bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-400 dark:hover:bg-neutral-600 disabled:opacity-50"
                  disabled={
                    !newId.trim() ||
                    (newType === "stdio" ? !newCommand.trim() : !newUrl.trim())
                  }
                  onClick={() => void submitServer()}
                >
                  {editingId ? "Save changes" : `Add ${newType} server`}
                </button>
                {editingId ? (
                  <button
                    className="rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-300 dark:hover:bg-neutral-700"
                    aria-label="Cancel edit"
                    onClick={() => resetForm()}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
            <button
              className="rounded bg-neutral-300 dark:bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-400 dark:hover:bg-neutral-600"
              onClick={() => void openMcpConfig()}
            >
              Open config file
            </button>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Workspace</h3>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-xs text-neutral-600 dark:text-neutral-400">
                {settings.workspaceRoot ?? "No workspace selected"}
              </span>
              <button
                className="rounded bg-neutral-300 dark:bg-neutral-700 px-2 py-1 hover:bg-neutral-400 dark:hover:bg-neutral-600"
                onClick={() => void pickWorkspace()}
              >
                {settings.workspaceRoot ? "Change" : "Pick folder"}
              </button>
            </div>
          </section>
        </div>

        {status ? (
          <footer className="border-t border-neutral-200 dark:border-neutral-800 px-4 py-2 text-xs text-neutral-600 dark:text-neutral-400">{status}</footer>
        ) : null}
      </div>
    </div>
  );
}
