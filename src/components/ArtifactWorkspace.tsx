import { Copy, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { TaskArtifactContent, TaskArtifactReference } from "@common/types";
import { ResultTable } from "./ResultTable";

interface ArtifactWorkspaceProps {
  artifacts: TaskArtifactReference[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  loadArtifact: (taskId: string, id: string) => Promise<TaskArtifactContent | null>;
  onCopy: (content: string) => Promise<void>;
}

export function ArtifactWorkspace({ artifacts, selectedId, onSelect, onClose, loadArtifact, onCopy }: ArtifactWorkspaceProps): React.ReactElement {
  const [result, setResult] = useState<{ id: string; content?: string; error?: string } | null>(null);
  const [mode, setMode] = useState("preview");
  const [retry, setRetry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const selected = artifacts.find((artifact) => artifact.id === selectedId);
  const taskId = selected?.taskId;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    setResult(null);
    setCopyStatus("");
    if (!taskId) return;
    void loadArtifact(taskId, selectedId).then((record) => {
      if (!active) return;
      setResult(record
        ? { id: selectedId, content: record.content }
        : { id: selectedId, error: "Artifact unavailable or its integrity check failed." });
    }).catch((error: unknown) => {
      if (active) setResult({ id: selectedId, error: error instanceof Error ? error.message : "Unable to load artifact." });
    });
    return () => { active = false; };
  }, [taskId, selectedId, loadArtifact, retry]);

  const current = result?.id === selectedId ? result : null;
  const content = current?.content;
  const markdown = !selected?.name.includes(".") || /\.(md|markdown)$/i.test(selected.name);

  return (
    <aside aria-label="Artifact workspace" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }} className="flex h-full min-h-0 min-w-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Artifacts</h2>
        <button ref={closeRef} type="button" className="response-icon-button" onClick={onClose} aria-label="Close artifact workspace" title="Close artifact workspace"><X size={16} /></button>
      </header>
      <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <select aria-label="Select artifact" className="w-full min-w-0 rounded border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={selectedId} onChange={(event) => onSelect(event.target.value)}>
          {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name} (r{artifact.planRevision})</option>)}
        </select>
        <p className="break-words text-xs text-neutral-500">{selected?.summary}</p>
        <p className="break-words text-xs text-neutral-500">Revision {selected?.planRevision} · {selected?.byteLength.toLocaleString()} bytes · {selected?.stepId}</p>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Artifact view" className="flex gap-1 text-xs">
            {["preview", "source"].map((view) => <button key={view} type="button" aria-pressed={mode === view} onClick={() => setMode(view)} className={`rounded px-3 py-1.5 ${mode === view ? "bg-neutral-200 dark:bg-neutral-700" : "text-neutral-500"}`}>{view === "preview" ? "Preview" : "Source"}</button>)}
          </div>
          <button type="button" className="response-icon-button ml-auto" title="Copy artifact" aria-label="Copy artifact" disabled={content === undefined} onClick={() => {
            if (content !== undefined) void onCopy(content).then(() => setCopyStatus("Copied")).catch(() => setCopyStatus("Copy failed"));
          }}><Copy size={16} /></button>
        </div>
        <span role="status" className="text-xs text-neutral-500">{copyStatus}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 [overflow-wrap:anywhere]">
        {!current ? <p role="status" className="text-sm text-neutral-500">Loading artifact...</p> : current.error ? (
          <div role="alert" className="space-y-2 text-sm text-red-600 dark:text-red-400">
            <p>{current.error}</p>
            <button type="button" className="response-icon-button" title="Retry loading artifact" aria-label="Retry loading artifact" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} /></button>
          </div>
        ) : content === "" ? <p className="text-sm text-neutral-500">Empty artifact.</p> : mode === "preview" && markdown ? (
          <div className="rich-response">
            <ReactMarkdown key={selectedId} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ table: ResultTable, img: () => null, a: ({ children }) => <span>{children}</span> }}>{content}</ReactMarkdown>
          </div>
        ) : <pre className="whitespace-pre-wrap break-words font-mono text-xs">{content}</pre>}
      </div>
    </aside>
  );
}