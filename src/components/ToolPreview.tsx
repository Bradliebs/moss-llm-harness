// src/components/ToolPreview.tsx
//
// Reviewable rendering of a tool call's arguments. Pending file writes show a
// diff against the file's current content, edits show the replaced snippet,
// and commands show where they will run.

import { useEffect, useState } from "react";

import type { WorkspaceFilePreview } from "@common/types";

import { compactDiff, describeToolCall, diffStats, lineDiff, type DiffLine } from "../lib/toolPreview";

const RISK_EXPLANATION: Record<"readonly" | "mutating" | "destructive", string> = {
  readonly: "Reads information without changing anything.",
  mutating: "Can change files or state inside the workspace.",
  destructive: "Can delete data or change your system. Review carefully.",
};

function DiffView({ lines, label }: { lines: DiffLine[]; label: string }): React.ReactElement {
  const stats = diffStats(lines);
  return (
    <figure className="mt-1" aria-label={label}>
      <figcaption className="text-[11px] text-neutral-600 dark:text-neutral-300">
        <span className="text-emerald-700 dark:text-emerald-300">+{stats.added}</span>{" "}
        <span className="text-red-700 dark:text-red-300">-{stats.removed}</span> lines
      </figcaption>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-neutral-50 p-2 text-xs dark:bg-neutral-950">
        {compactDiff(lines).map((line, index) =>
          line.type === "gap" ? (
            <div key={index} className="text-neutral-500 dark:text-neutral-400">… {line.count} unchanged line{line.count === 1 ? "" : "s"}</div>
          ) : (
            <div
              key={index}
              className={line.type === "add"
                ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200"
                : line.type === "remove"
                  ? "bg-red-500/15 text-red-900 dark:text-red-200"
                  : "text-neutral-700 dark:text-neutral-300"}
            >
              <span aria-hidden="true">{line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}</span>
              <span className="sr-only">{line.type === "add" ? "Added: " : line.type === "remove" ? "Removed: " : ""}</span>
              {line.text}
            </div>
          ))}
      </pre>
    </figure>
  );
}

function WritePreview({ path, content, workspaceRoot }: { path: string; content: string; workspaceRoot?: string | null }): React.ReactElement {
  const [current, setCurrent] = useState<WorkspaceFilePreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    const preview = window.moss?.workspace?.preview;
    if (!workspaceRoot || !preview) {
      setCurrent({ exists: false, error: "Current file unavailable" });
      return;
    }
    void preview(workspaceRoot, path)
      .then((result) => { if (!cancelled) setCurrent(result); })
      .catch(() => { if (!cancelled) setCurrent({ exists: false, error: "Current file unavailable" }); });
    return () => { cancelled = true; };
  }, [path, workspaceRoot]);

  if (!current) return <p className="text-xs text-neutral-600 dark:text-neutral-300">Loading current file…</p>;
  const heading = <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200">{current.exists ? "Overwrite" : current.error ? "Write" : "Create"} <code>{path}</code></p>;
  if (current.exists && (current.truncated || current.binary)) {
    return <>{heading}<p className="text-xs text-amber-700 dark:text-amber-300">The existing file is {current.binary ? "binary" : "too large to compare"}; it will be replaced entirely.</p></>;
  }
  const diff = lineDiff(current.content ?? "", content);
  return (
    <>
      {heading}
      {current.error && !current.exists ? <p className="text-[11px] text-neutral-600 dark:text-neutral-300">{current.error}; showing the new content only.</p> : null}
      {diff ? <DiffView lines={diff} label={`Changes to ${path}`} /> : <p className="text-xs text-neutral-600 dark:text-neutral-300">The change is too large to diff ({content.length.toLocaleString()} characters).</p>}
    </>
  );
}

export function ToolPreview({
  name,
  args,
  risk,
  workspaceRoot,
}: {
  name: string;
  args: string;
  risk?: "readonly" | "mutating" | "destructive";
  workspaceRoot?: string | null;
}): React.ReactElement {
  const model = describeToolCall(name, args);
  return (
    <div className="space-y-1">
      {risk ? <p className="text-[11px] text-neutral-600 dark:text-neutral-300">{RISK_EXPLANATION[risk]}</p> : null}
      {model.kind === "write" ? <WritePreview path={model.path} content={model.content} workspaceRoot={workspaceRoot} /> : null}
      {model.kind === "edit" ? (
        <>
          <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
            Edit <code>{model.path}</code>{model.replaceAll ? " (every occurrence)" : ""}
          </p>
          {(() => {
            const diff = lineDiff(model.oldText, model.newText);
            return diff ? <DiffView lines={diff} label={`Edit to ${model.path}`} /> : <p className="text-xs">The edit is too large to diff.</p>;
          })()}
        </>
      ) : null}
      {model.kind === "move" ? (
        <p className="text-xs text-neutral-800 dark:text-neutral-200">Move <code>{model.from}</code> to <code>{model.to}</code></p>
      ) : null}
      {model.kind === "command" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs text-neutral-800 dark:text-neutral-200">
          <dt className="font-medium">Command</dt>
          <dd><pre className="whitespace-pre-wrap rounded bg-neutral-50 px-1.5 py-1 dark:bg-neutral-950">{model.command}</pre></dd>
          <dt className="font-medium">Runs in</dt>
          <dd className="break-all">{workspaceRoot ?? "No workspace selected"}</dd>
          <dt className="font-medium">Time limit</dt>
          <dd>60 seconds</dd>
        </dl>
      ) : null}
      {model.kind === "generic" ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">{model.formatted}</pre>
      ) : null}
    </div>
  );
}
