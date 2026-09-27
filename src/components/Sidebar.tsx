// src/components/Sidebar.tsx
//
// Left navigation: conversation list, new-chat action, pinning, bulk selection,
// a collapsible rail, and entry points to Run center, Library, and Settings.
// Browsing other conversations is allowed while a turn runs; rename and delete
// stay disabled for a conversation whose run is still active.

import { useState } from "react";
import { CheckSquare, Copy, Download, PanelLeftClose, PanelLeftOpen, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";

import {
  createSession,
  deleteSession,
  deleteSessions,
  renameSession,
  selectSession,
  sessionToMarkdown,
  setSessionPinned,
  sortSessionsForDisplay,
  useSessions,
  type Session,
} from "../lib/sessions";
import { updateSettings, useSettings } from "../lib/settings";
import { isRunActive, useTaskRuns } from "../lib/taskRuns";
import { MossFace } from "./MossFace";

interface SidebarProps {
  busy: boolean;
  open?: boolean;
  onClose?: () => void;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  onOpenRuns?: () => void;
}

// Trigger a client-side file download for a text payload. Guards on
// createObjectURL so non-browser environments (tests) are a no-op instead of a
// throw; the Markdown serializer is unit-tested independently.
function downloadTextFile(name: string, text: string): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fileNameFor(session: Session): string {
  const slug = session.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "conversation"}.md`;
}

// Copy text to the clipboard, guarding on the async clipboard API so non-browser
// environments (tests) are a no-op instead of a throw.
function copyToClipboard(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text);
}

export function Sidebar({ busy, open = false, onClose, onOpenSettings, onOpenLibrary, onOpenRuns }: SidebarProps): React.ReactElement {
  const { sessions, currentId } = useSessions();
  const runs = useTaskRuns();
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const exportOptions = { includeTools: true, model: settings.model, modelRates: settings.modelRates };
  const runsByTask = new Map(runs.map((run) => [run.id, run]));
  const collapsed = settings.sidebarCollapsed === true && !open;

  const filter = query.trim().toLowerCase();
  const visible = sortSessionsForDisplay(filter ? sessions.filter((s) => s.title.toLowerCase().includes(filter)) : sessions);
  const selectedSessions = sessions.filter((s) => selected.has(s.id));
  const selectedHasActiveRun = selectedSessions.some((s) => busy && isRunActive(s.taskId ? runsByTask.get(s.taskId) : undefined));

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBulkDelete(false);
  }

  function exitSelection(): void {
    setSelecting(false);
    setSelected(new Set());
    setConfirmBulkDelete(false);
  }

  function exportSelected(): void {
    const text = selectedSessions.map((s) => sessionToMarkdown(s, exportOptions)).join("\n\n---\n\n");
    downloadTextFile(`moss-conversations-${selectedSessions.length}.md`, text);
  }

  function beginRename(s: Session): void {
    setEditingId(s.id);
    setDraft(s.title);
  }

  function commitRename(): void {
    if (editingId) renameSession(editingId, draft);
    setEditingId(null);
    setDraft("");
  }

  function cancelRename(): void {
    setEditingId(null);
    setDraft("");
  }

  function createAndClose(): void {
    createSession();
    onClose?.();
  }

  function selectAndClose(id: string): void {
    selectSession(id);
    onClose?.();
  }

  const railButton = "inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white";
  if (collapsed) {
    return (
      <aside
        className="hidden h-screen w-14 shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-white/70 py-3 dark:border-neutral-800 dark:bg-neutral-900/70 md:flex"
        aria-label="Conversations"
      >
        <MossFace className="h-7 w-7" label="Moss portrait" />
        <button type="button" className={railButton} onClick={() => updateSettings({ sidebarCollapsed: false })} title="Expand sidebar" aria-label="Expand sidebar">
          <PanelLeftOpen size={18} aria-hidden="true" />
        </button>
        <button type="button" className={railButton} onClick={createAndClose} title="New chat (Ctrl+N)" aria-label="New chat">
          <Plus size={18} aria-hidden="true" />
        </button>
        <div className="mt-auto flex flex-col items-center gap-1 text-[10px]">
          <button type="button" className={`${railButton} relative`} onClick={onOpenRuns} title="Run center (Ctrl+Shift+R)" aria-label="Run center">
            Runs
            {runs.some(isRunActive) ? <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" /> : null}
          </button>
          <button type="button" className={railButton} onClick={onOpenLibrary} title="Library" aria-label="Library">Lib</button>
          <button type="button" className={railButton} onClick={onOpenSettings} title="Settings (Ctrl+,)" aria-label="Settings">Set</button>
        </div>
      </aside>
    );
  }

  return (
    <>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/35 md:hidden"
          onClick={onClose}
          aria-label="Close conversations"
        />
      ) : null}
      <aside
        className={`${open ? "flex" : "hidden"} fixed inset-y-0 left-0 z-40 h-screen w-72 max-w-[85vw] shrink-0 flex-col border-r border-neutral-200 bg-white/95 shadow-xl backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/95 md:static md:z-auto md:flex md:w-60 md:bg-white/70 md:shadow-none dark:md:bg-neutral-900/70`}
        aria-label="Conversations"
      >
      <div className="flex items-center gap-2 px-3 py-3">
        <MossFace className="h-7 w-7" label="Moss portrait" />
        <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">Moss</span>
        <button
          type="button"
          className="ml-auto hidden h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white md:inline-flex"
          onClick={() => updateSettings({ sidebarCollapsed: true })}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white md:hidden"
          onClick={onClose}
          title="Close conversations"
          aria-label="Close conversations"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="border-b border-neutral-200 dark:border-neutral-800 p-2">
        <button
          className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white shadow transition hover:bg-emerald-600 disabled:opacity-50"
          onClick={createAndClose}
        >
          + New chat
        </button>
        {sessions.length > 0 ? (
          <input
            className="mt-2 w-full rounded-md border border-neutral-300/60 dark:border-neutral-700/60 bg-neutral-200 dark:bg-neutral-800 px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-500 dark:placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        ) : null}
        {sessions.length > 1 && !selecting ? (
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
            onClick={() => setSelecting(true)}
          >
            <CheckSquare size={13} aria-hidden="true" /> Select conversations
          </button>
        ) : null}
        {selecting ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" role="toolbar" aria-label="Selected conversations">
            <span className="text-neutral-700 dark:text-neutral-200">{selected.size} selected</span>
            <button type="button" className="underline disabled:opacity-40" disabled={selected.size === 0} onClick={exportSelected}>Export</button>
            {confirmBulkDelete ? (
              <>
                <button
                  type="button"
                  className="rounded bg-red-700 px-1.5 py-0.5 text-white"
                  onClick={() => {
                    deleteSessions([...selected]);
                    exitSelection();
                  }}
                >
                  Delete {selected.size}
                </button>
                <button type="button" className="underline" onClick={() => setConfirmBulkDelete(false)}>Keep</button>
              </>
            ) : (
              <button
                type="button"
                className="text-red-700 underline disabled:opacity-40 dark:text-red-300"
                disabled={selected.size === 0 || selectedHasActiveRun}
                title={selectedHasActiveRun ? "A selected conversation has an active run" : undefined}
                onClick={() => setConfirmBulkDelete(true)}
              >
                Delete
              </button>
            )}
            <button type="button" className="ml-auto underline" onClick={exitSelection}>Done</button>
          </div>
        ) : null}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">No conversations yet.</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">No matching conversations.</p>
        ) : (
          <ul className="space-y-1">
            {visible.map((s) => {
                const run = s.taskId ? runsByTask.get(s.taskId) : undefined;
                const active = isRunActive(run);
                return (
              <li
                key={s.id}
                className={`group relative flex items-center rounded-md px-2 py-1.5 text-sm transition ${
                  s.id === currentId
                    ? "border-l-2 border-emerald-500 bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                    : "border-l-2 border-transparent text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
                }`}
              >
                {editingId === s.id ? (
                  <input
                    className="min-w-0 flex-1 rounded border border-neutral-400 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-1 py-0.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    aria-label="Rename conversation"
                  />
                ) : (
                  <>
                    {selecting ? (
                      <input
                        type="checkbox"
                        className="mr-2 accent-emerald-600"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                        aria-label={`Select ${s.title}`}
                      />
                    ) : null}
                    {s.pinned ? <Pin size={12} className="mr-1 shrink-0 text-emerald-700 dark:text-emerald-300" aria-label="Pinned" /> : null}
                    <button
                      className="min-w-0 flex-1 truncate text-left group-hover:pr-32 group-focus-within:pr-32 disabled:cursor-not-allowed"
                      onClick={() => selectAndClose(s.id)}
                      onDoubleClick={() => beginRename(s)}
                      title={s.title}
                    >
                      {s.title}
                      {run ? (
                        <span
                          className={`ml-2 inline-block h-2 w-2 rounded-full ${
                            active ? "bg-emerald-500" : run.state === "failed" ? "bg-red-500" : "bg-neutral-400"
                          }`}
                          title={`Mission ${run.state.replaceAll("_", " ")}`}
                          aria-label={`Mission ${run.state.replaceAll("_", " ")}`}
                        />
                      ) : null}
                    </button>
                    <div className="invisible absolute right-1 flex items-center rounded bg-neutral-200 dark:bg-neutral-800 opacity-0 shadow-sm transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                      <button
                        className="p-1 text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                        onClick={() => setSessionPinned(s.id, !s.pinned)}
                        title={s.pinned ? "Unpin conversation" : "Pin conversation"}
                        aria-label={s.pinned ? "Unpin conversation" : "Pin conversation"}
                      >
                        {s.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                      </button>
                      <button
                        className="p-1 text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-40"
                        onClick={() => beginRename(s)}
                        disabled={busy && active}
                        title="Rename conversation"
                        aria-label="Rename conversation"
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button
                        className="p-1 text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                        onClick={() => downloadTextFile(fileNameFor(s), sessionToMarkdown(s, exportOptions))}
                        title="Export conversation as Markdown"
                        aria-label="Export conversation as Markdown"
                      >
                        <Download size={14} aria-hidden="true" />
                      </button>
                      <button
                        className="p-1 text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                        onClick={() => copyToClipboard(sessionToMarkdown(s, exportOptions))}
                        title="Copy conversation as Markdown"
                        aria-label="Copy conversation as Markdown"
                      >
                        <Copy size={14} aria-hidden="true" />
                      </button>
                      <button
                        className="p-1 text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
                        onClick={() => deleteSession(s.id)}
                        disabled={busy && active}
                        title="Delete conversation"
                        aria-label="Delete conversation"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </li>
                );
            })}
          </ul>
        )}
      </nav>

      <div className="space-y-1 border-t border-neutral-200 dark:border-neutral-800 p-2">
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-300 transition hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={onOpenRuns}
        >
          Run center
          {runs.some(isRunActive) ? (
            <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              {runs.filter(isRunActive).length}
            </span>
          ) : null}
        </button>
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-300 transition hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={onOpenLibrary}
        >
          Library
        </button>
        <button
          className="w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 dark:text-neutral-300 transition hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>
      </aside>
    </>
  );
}
