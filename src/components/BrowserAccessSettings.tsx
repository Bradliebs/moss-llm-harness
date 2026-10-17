// src/components/BrowserAccessSettings.tsx
//
// Turn on Moss in a web browser on this PC, and get the link that opens it.

import { useEffect, useState } from "react";

interface Status {
  enabled: boolean;
  url?: string;
  error?: string;
}

const BUTTON = "rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function BrowserAccessSettings({ className }: { className?: string }): React.ReactElement | null {
  const api = typeof window !== "undefined" ? window.moss?.webAccess : undefined;
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void api?.get().then((value) => { if (live) setStatus(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  if (!api) return null;

  async function change(enabled: boolean): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      // A browser opening Moss for the first time starts from these settings
      // (API keys stay in Moss's encrypted store and are read from there).
      setStatus(await api.set(enabled, enabled ? localStorage.getItem("moss.settings") ?? undefined : undefined));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string): Promise<void> {
    await window.moss.clipboard?.write(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <section className={className}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Browser access</h3>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={status?.enabled === true}
          disabled={busy || status === null}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>Use Moss from a web browser on this PC</span>
      </label>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        Serves this interface at a private link on 127.0.0.1, so other devices cannot reach it. Anyone with the link on this
        PC can use Moss as you, with your tools and keys: keep it to yourself. Each browser keeps its own conversations;
        settings start from this window&apos;s. Turning this off and on makes a new link.
      </p>
      {status?.enabled && status.url ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 max-w-full truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800" title="The link includes its key">
            {status.url.replace(/#token=.*/, "#token=…")}
          </code>
          <button type="button" className={BUTTON} onClick={() => void copy(status.url!)}>{copied ? "Copied" : "Copy link"}</button>
          <button type="button" className={BUTTON} onClick={() => void window.moss.shell?.openExternal(status.url!)}>Open in browser</button>
        </div>
      ) : null}
      {status?.error ? <p className="mt-2 text-xs text-red-700 dark:text-red-400" role="alert">{status.error}</p> : null}
    </section>
  );
}
