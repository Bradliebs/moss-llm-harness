import type { ProductDiagnosticEntry, ProductDiagnosticsConfig } from "@common/types";
import { useCallback, useEffect, useState } from "react";

interface ProductDiagnosticsSettingsProps {
  onStatus: (message: string) => void;
}

export function ProductDiagnosticsSettings({ onStatus }: ProductDiagnosticsSettingsProps): React.ReactElement {
  const [config, setConfig] = useState<ProductDiagnosticsConfig>({ enabled: false, retentionDays: 30 });
  const [entries, setEntries] = useState<ProductDiagnosticEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!window.moss.diagnostics) return;
    try {
      const result = await window.moss.diagnostics.list();
      setConfig(result.config);
      setEntries(result.entries);
    } catch (error) {
      onStatus(`Diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function configure(update: Partial<ProductDiagnosticsConfig>): Promise<void> {
    const previous = config;
    const requested = { ...config, ...update };
    setConfig(requested);
    try {
      const next = await window.moss.diagnostics.configure(requested);
      setConfig(next);
      await refresh();
      onStatus(next.enabled ? "Local diagnostics enabled" : "Local diagnostics disabled");
    } catch (error) {
      setConfig(previous);
      onStatus(`Diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function clear(): Promise<void> {
    try {
      await window.moss.diagnostics.clear();
      setEntries([]);
      onStatus("Local diagnostics cleared");
    } catch (error) {
      onStatus(`Diagnostics error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function exportEntries(): void {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      privacy: "Content-free local product diagnostics",
      config,
      entries,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `moss-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    onStatus("Redacted diagnostics exported");
  }

  return (
    <>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
        Product diagnostics
      </h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Optional, local-only product signals. Moss never records prompts, responses, file contents, API keys,
        workspace paths, or raw tool arguments.
      </p>
      <label className="flex items-start gap-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => void configure({ enabled: event.target.checked })}
        />
        <span>
          <span className="block text-xs font-medium text-neutral-800 dark:text-neutral-200">
            Collect local product diagnostics
          </span>
          <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
            Stores bounded timing, outcome, blocker, approval, and verification categories on this device.
          </span>
        </span>
      </label>
      <label className="block text-xs text-neutral-600 dark:text-neutral-300">
        Retention
        <select
          className="ml-2 rounded border border-neutral-300 bg-neutral-100 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
          value={config.retentionDays}
          onChange={(event) => void configure({ retentionDays: Number(event.target.value) })}
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </label>
      <div className="rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800">
        <p className="font-medium text-neutral-800 dark:text-neutral-200">
          {entries.length} retained {entries.length === 1 ? "event" : "events"}
        </p>
        {entries.length > 0 ? (
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-[11px] text-neutral-500 dark:text-neutral-400">
            {entries.slice(0, 20).map((entry) => (
              <li key={entry.id} className="flex justify-between gap-3">
                <span>{entry.kind.replaceAll("-", " ")}</span>
                <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-800 dark:hover:bg-neutral-700"
          onClick={exportEntries}
          disabled={entries.length === 0}
        >
          Export redacted JSON
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950"
          onClick={() => void clear()}
          disabled={entries.length === 0}
        >
          Clear diagnostics
        </button>
      </div>
    </>
  );
}
