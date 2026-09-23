import { useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";

import { updateSettings, useSettings } from "../lib/settings";

export function JevSettings(): React.ReactElement {
  const settings = useSettings();
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let active = true;
    void window.moss.provider.getCredential("typesafe").then((key) => {
      if (active) setSaved(!!key);
    }).catch(() => {
      if (active) setStatus("Could not read secure credential storage.");
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, []);

  async function save(remove: boolean): Promise<void> {
    setBusy(true);
    setStatus("");
    try {
      await window.moss.provider.setCredential("typesafe", remove ? "" : apiKey.trim());
      setSaved(!remove);
      setApiKey("");
      if (remove) updateSettings({ jevEnabled: false });
      setStatus(remove ? "TypeSafe API key removed." : "TypeSafe API key saved securely.");
    } catch {
      setStatus("Could not save the TypeSafe API key. Check secure credential storage.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2" aria-labelledby="jev-heading">
      <h3 id="jev-heading" className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">TypeSafe / Jev</h3>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-emerald-500" checked={settings.jevEnabled === true}
          disabled={busy || !saved} onChange={(event) => updateSettings({ jevEnabled: event.target.checked })} />
        Use Jev
      </label>
      <label className="block">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-400">TypeSafe API key</span>
        <input type="password" autoComplete="off" spellCheck={false}
          className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1"
          placeholder={saved ? "Key saved" : "No key saved"} value={apiKey}
          disabled={busy} onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <button type="button" title="Save TypeSafe API key" aria-label="Save TypeSafe API key"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-emerald-700 text-white disabled:opacity-40"
          disabled={busy || !apiKey.trim()} onClick={() => void save(false)}><Save size={16} /></button>
        <button type="button" title="Remove TypeSafe API key" aria-label="Remove TypeSafe API key"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-neutral-200 dark:bg-neutral-800 disabled:opacity-40"
          disabled={busy || !saved} onClick={() => void save(true)}><Trash2 size={16} /></button>
        <span className="text-xs text-neutral-500">{saved ? "Key saved securely" : "No key saved"}</span>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Approved context is sent to TypeSafe. Separate API charges apply outside Moss&apos;s model budget.
        Ordinary chat only; tools must be enabled. Changes apply to the next turn.
      </p>
      {status && <p role="status" className="text-xs text-neutral-600 dark:text-neutral-400">{status}</p>}
    </section>
  );
}