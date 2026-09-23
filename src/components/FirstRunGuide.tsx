// src/components/FirstRunGuide.tsx
//
// Three-step first-run walkthrough: connect a model, optionally choose a
// workspace, then try a safe read-only request. Dismissal is remembered.

import { Check } from "lucide-react";

export interface FirstRunGuideProps {
  providerReady: boolean;
  workspaceRoot: string | null;
  onOpenSettings: () => void;
  onPickWorkspace: () => void;
  onTry: (prompt: string) => void;
  onDismiss: () => void;
}

function Step({ index, done, title, children }: { index: number; done: boolean; title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          done ? "bg-emerald-700 text-white" : "border border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-200"
        }`}
        aria-hidden="true"
      >
        {done ? <Check size={14} /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {title}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </p>
        <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">{children}</div>
      </div>
    </li>
  );
}

export function FirstRunGuide({ providerReady, workspaceRoot, onOpenSettings, onPickWorkspace, onTry, onDismiss }: FirstRunGuideProps): React.ReactElement {
  const samplePrompt = workspaceRoot ? "Summarize the files in my workspace without changing anything." : "Explain what you can help me with and which tools you can use.";
  const button = "rounded-md border border-neutral-300 px-2 py-1 font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-800";
  return (
    <section className="w-full max-w-xl rounded-xl border border-neutral-200 bg-white/80 p-4 text-left shadow-sm dark:border-neutral-800 dark:bg-neutral-900/80" aria-labelledby="first-run-title">
      <div className="flex items-center gap-2">
        <h2 id="first-run-title" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Get started in three steps</h2>
        <button type="button" className="ml-auto text-xs text-neutral-600 underline dark:text-neutral-300" onClick={onDismiss}>
          Hide guide
        </button>
      </div>
      <ol className="mt-3 space-y-3">
        <Step index={1} done={providerReady} title="Connect a model">
          {providerReady ? "A provider and model are selected." : "Run Ollama locally or add an API key, then pick a model."}
          {!providerReady ? <div className="mt-1"><button type="button" className={button} onClick={onOpenSettings}>Open Settings</button></div> : null}
        </Step>
        <Step index={2} done={!!workspaceRoot} title="Choose a workspace (optional)">
          {workspaceRoot ? <span className="break-all">Using {workspaceRoot}</span> : "File and command tools only work inside a folder you choose. Pick a dedicated or version-controlled folder."}
          {!workspaceRoot ? <div className="mt-1"><button type="button" className={button} onClick={onPickWorkspace}>Choose folder</button></div> : null}
        </Step>
        <Step index={3} done={false} title="Try a safe, read-only request">
          Moss asks before changing files or running commands unless you turn on auto-approve.
          <div className="mt-1">
            <button type="button" className={button} disabled={!providerReady} onClick={() => onTry(samplePrompt)}>
              Try: {workspaceRoot ? "Summarize my workspace" : "What can you do?"}
            </button>
          </div>
        </Step>
      </ol>
    </section>
  );
}
