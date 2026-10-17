// src/components/PreviewPane.tsx
//
// A page the agent wrote, shown beside the chat. It loads from Moss's loopback
// preview server, a different origin from the app, in a sandboxed frame that
// cannot navigate the app, open windows, or reach the Moss bridge.

import { ExternalLink, RefreshCw, X } from "lucide-react";

const BUTTON = "inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white";

export function PreviewPane({
  url,
  path,
  reloadKey,
  onReload,
  onOpenInBrowser,
  onClose,
}: {
  url: string;
  path: string;
  /** changes whenever the page should load again */
  reloadKey: number;
  onReload: () => void;
  onOpenInBrowser: () => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <section className="flex h-full min-h-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950" aria-label={`Preview of ${path}`}>
      <header className="flex items-center gap-1 border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700 dark:text-neutral-300" title={path}>{path}</span>
        <button type="button" className={BUTTON} onClick={onReload} title="Reload the page" aria-label="Reload preview"><RefreshCw size={16} aria-hidden="true" /></button>
        <button type="button" className={BUTTON} onClick={onOpenInBrowser} title="Open in your web browser" aria-label="Open preview in browser"><ExternalLink size={16} aria-hidden="true" /></button>
        <button type="button" className={BUTTON} onClick={onClose} title="Close the preview" aria-label="Close preview"><X size={16} aria-hidden="true" /></button>
      </header>
      <iframe
        key={reloadKey}
        src={url}
        title={`Preview of ${path}`}
        className="min-h-0 w-full flex-1 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
        referrerPolicy="no-referrer"
      />
      <p className="border-t border-neutral-200 px-3 py-1 text-[11px] text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        Reloads when the agent changes a file. The page&apos;s scripts run here, apart from Moss.
      </p>
    </section>
  );
}
