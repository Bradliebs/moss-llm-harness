// src/components/WorkingStatePanel.tsx
//
// The conversation's governed working state: invariants and protected paths the
// user sets, plus decisions, facts, and open questions the model records. It is
// kept outside the transcript, so compaction never removes it.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import type { WorkingState, WorkingStateKind } from "@common/types";

import { addWorkingStateEntry, removeWorkingStateEntry } from "../lib/sessions";

const KINDS: ReadonlyArray<{ kind: WorkingStateKind; label: string; help: string }> = [
  { kind: "invariant", label: "Invariants", help: "Rules the model must never break, for example \"Keep the public API unchanged\"." },
  { kind: "protected", label: "Protected paths", help: "Files, folders, or globs Moss refuses to create, change, move, or delete, for example config/secrets.json or migrations/**." },
  { kind: "decision", label: "Decisions", help: "Choices already made, with the reason." },
  { kind: "question", label: "Open questions", help: "Unresolved questions to come back to." },
  { kind: "fact", label: "Facts", help: "Things established during the work." },
];

export function WorkingStatePanel({
  sessionId,
  state,
  onClose,
}: {
  sessionId: string;
  state: WorkingState | undefined;
  onClose: () => void;
}): React.ReactElement {
  const [kind, setKind] = useState<WorkingStateKind>("invariant");
  const [text, setText] = useState("");
  const [rationale, setRationale] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const entries = state?.entries ?? [];

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onClose]);

  function add(): void {
    if (!text.trim()) return;
    addWorkingStateEntry(sessionId, kind, text, kind === "decision" ? rationale : undefined);
    setText("");
    setRationale("");
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="presentation" onMouseDown={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="working-state-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div>
            <h2 id="working-state-title" className="font-semibold text-neutral-900 dark:text-white">Working state</h2>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">Kept outside the transcript and sent with every model request.</p>
          </div>
          <button ref={closeRef} type="button" className="ml-auto rounded p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" aria-label="Close working state" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {KINDS.map((section) => {
            const items = entries.filter((entry) => entry.kind === section.kind);
            return (
              <section key={section.kind} aria-label={section.label}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300">{section.label} ({items.length})</h3>
                {items.length === 0 ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{section.help}</p> : (
                  <ul className="mt-1 space-y-1">
                    {items.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-2 rounded border border-neutral-200 px-2 py-1 dark:border-neutral-800">
                        <div className="min-w-0 flex-1">
                          <p className={section.kind === "protected" ? "font-mono text-xs text-neutral-900 dark:text-neutral-100" : "text-neutral-900 dark:text-neutral-100"}>{entry.text}</p>
                          {entry.rationale ? <p className="text-xs text-neutral-600 dark:text-neutral-400">Because {entry.rationale}</p> : null}
                          <p className="text-[11px] text-neutral-600 dark:text-neutral-400">{entry.id} · {entry.source === "user" ? "you" : "model"}</p>
                        </div>
                        <button
                          type="button"
                          className="text-xs text-red-700 underline dark:text-red-300"
                          aria-label={`Remove ${entry.text}`}
                          onClick={() => removeWorkingStateEntry(sessionId, entry.id)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <form
          className="space-y-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="working-state-kind">Entry type</label>
            <select id="working-state-kind" className="rounded bg-neutral-200 px-2 py-1 text-sm dark:bg-neutral-800" value={kind} onChange={(event) => setKind(event.target.value as WorkingStateKind)}>
              {KINDS.map((section) => <option key={section.kind} value={section.kind}>{section.label.replace(/s$/, "")}</option>)}
            </select>
            <input
              className="min-w-0 flex-1 rounded bg-neutral-200 px-2 py-1 text-sm dark:bg-neutral-800"
              aria-label="Entry text"
              placeholder={kind === "protected" ? "path/to/file or folder/**" : "Add an entry"}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          {kind === "decision" ? (
            <input
              className="w-full rounded bg-neutral-200 px-2 py-1 text-sm dark:bg-neutral-800"
              aria-label="Reason"
              placeholder="Why (optional)"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          ) : null}
          <button type="submit" className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50" disabled={!text.trim()}>
            Add
          </button>
        </form>
      </aside>
    </div>
  );
}
