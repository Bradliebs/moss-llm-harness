// src/components/TurnUndo.tsx
//
// Lists the workspace files a completed turn changed and lets the user undo
// them after an explicit confirmation. A turn's checkpoint is consumed by the
// revert, so the control is removed once it succeeds.

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";

import type { CheckpointFile } from "@common/types";

type UndoState = "idle" | "confirming" | "reverting" | "reverted" | "error";

export function TurnUndo({ turnId }: { turnId: string }): React.ReactElement | null {
  const [files, setFiles] = useState<CheckpointFile[] | null>(null);
  const [state, setState] = useState<UndoState>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const bridge = window.moss?.checkpoint;
    if (!bridge) {
      setFiles([]);
      return;
    }
    void bridge.list(turnId)
      .then((listed) => { if (!cancelled) setFiles(listed); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [turnId]);

  if (state === "reverted") {
    return <p className="mt-1.5 text-[11px] text-neutral-600 dark:text-neutral-300" role="status">{message}</p>;
  }
  if (!files || files.length === 0) return null;

  async function revert(): Promise<void> {
    const bridge = window.moss?.checkpoint;
    if (!bridge) return;
    setState("reverting");
    try {
      const result = await bridge.revert(turnId);
      const undone = `Undid changes to ${result.reverted} file${result.reverted === 1 ? "" : "s"}`;
      if (result.errors.length > 0) {
        setState("error");
        setMessage(`${undone}; ${result.errors.length} could not be restored: ${result.errors.join("; ")}`);
      } else {
        setState("reverted");
        setMessage(undone);
      }
    } catch (error) {
      setState("error");
      setMessage(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const label = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  return (
    <div className="mt-1.5 text-[11px] text-neutral-600 dark:text-neutral-300">
      <details>
        <summary className="inline cursor-pointer" title="Files this turn created or modified in the workspace.">{label}</summary>
        <ul className="mt-1 space-y-0.5 pl-3" aria-label="Changed files">
          {files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>{" "}
              <span className="text-neutral-500 dark:text-neutral-400">{file.existed ? "modified" : "created (undo deletes it)"}</span>
            </li>
          ))}
        </ul>
      </details>
      {state === "confirming" ? (
        <span className="ml-2 inline-flex flex-wrap items-center gap-2" role="group" aria-label="Confirm undo">
          <span>Restore {files.length === 1 ? "this file" : `these ${files.length} files`} to their state before the turn?</span>
          <button type="button" className="rounded-md bg-amber-700 px-1.5 py-0.5 font-medium text-white hover:bg-amber-600" onClick={() => void revert()}>
            Undo changes
          </button>
          <button type="button" className="rounded-md border border-neutral-300 px-1.5 py-0.5 dark:border-neutral-700" onClick={() => setState("idle")}>
            Keep changes
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="ml-2 inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-800 transition hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
          disabled={state === "reverting"}
          title="Undo this turn's file changes, restoring each file to its state before the turn."
          onClick={() => setState("confirming")}
        >
          <Undo2 size={12} aria-hidden="true" />
          {state === "reverting" ? "Undoing…" : "Undo turn"}
        </button>
      )}
      {state === "error" ? <p className="mt-1 text-red-700 dark:text-red-300" role="alert">{message}</p> : null}
    </div>
  );
}
