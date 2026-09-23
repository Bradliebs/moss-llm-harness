import type { TaskSnapshot } from "@common/types";
import { AlertTriangle, CheckCircle2, CirclePause, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { selectSession, useSessions } from "../lib/sessions";
import { isRunActive, refreshTaskRuns, useTaskRuns } from "../lib/taskRuns";

interface RunCenterProps {
  onClose: () => void;
}

function stateIcon(run: TaskSnapshot): React.ReactElement {
  if (run.state === "blocked" || run.state === "failed") {
    return <AlertTriangle size={16} className="text-amber-500" aria-hidden="true" />;
  }
  if (run.state === "paused" || run.state === "waiting_for_approval") {
    return <CirclePause size={16} className="text-sky-500" aria-hidden="true" />;
  }
  if (run.state === "completed") {
    return <CheckCircle2 size={16} className="text-emerald-500" aria-hidden="true" />;
  }
  return <LoaderCircle size={16} className="animate-spin text-emerald-500" aria-hidden="true" />;
}

function stateLabel(run: TaskSnapshot): string {
  if (run.state === "waiting_for_approval") return "Waiting for approval";
  return run.state.replaceAll("_", " ");
}

function budgetSummary(run: TaskSnapshot): string {
  const usedActions = run.attempts.reduce((total, attempt) => total + attempt.actionCount, 0);
  const usedTokens = run.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  );
  const usedCost = run.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0);
  const parts = [
    run.spec.budget?.maxActions ? `${usedActions}/${run.spec.budget.maxActions} actions` : `${usedActions} actions`,
    run.spec.budget?.maxTokens ? `${usedTokens.toLocaleString()}/${run.spec.budget.maxTokens.toLocaleString()} tokens` : `${usedTokens.toLocaleString()} tokens`,
  ];
  if (run.spec.budget?.maxCostUsd) parts.push(`$${usedCost.toFixed(2)}/$${run.spec.budget.maxCostUsd.toFixed(2)}`);
  return parts.join(" · ");
}

function exportRunDiagnostics(run: TaskSnapshot): void {
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    task: {
      state: run.state,
      revision: run.revision,
      stepStates: run.steps.map((step) => ({ id: step.id, state: step.state })),
      attemptCount: run.attempts.length,
      evidence: run.evidence.map((evidence) => ({
        criterionId: evidence.criterionId,
        kind: evidence.kind,
        passed: evidence.passed,
      })),
      blocker: run.blocker ? { kind: run.blocker.kind, resumable: run.blocker.resumable } : undefined,
      approval: run.approval ? { status: run.approval.status, risk: run.approval.risk } : undefined,
      artifactCount: run.artifacts?.length ?? 0,
      updatedAt: run.updatedAt,
    },
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `moss-run-${run.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function RunCenter({ onClose }: RunCenterProps): React.ReactElement {
  const { sessions } = useSessions();
  const runs = useTaskRuns();
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sessionsByTask = new Map(
    sessions.filter((session) => session.taskId).map((session) => [session.taskId, session]),
  );
  const visibleRuns = runs.filter((run) => sessionsByTask.has(run.id));

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onClose]);

  function inspect(run: TaskSnapshot): void {
    const session = sessionsByTask.get(run.id);
    if (!session) return;
    selectSession(session.id);
    onClose();
  }

  async function cancel(run: TaskSnapshot): Promise<void> {
    try {
      await window.moss.task.cancel(run.id);
      await refreshTaskRuns();
      setError("");
    } catch (cancelError) {
      setError(`Could not cancel run: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
    }
  }

  async function pause(run: TaskSnapshot): Promise<void> {
    try {
      await window.moss.task.pause(run.id, "Paused from Run center");
      await refreshTaskRuns();
      setError("");
    } catch (pauseError) {
      setError(`Could not pause run: ${pauseError instanceof Error ? pauseError.message : String(pauseError)}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-4 pt-[8vh]" role="presentation">
      <section
        ref={dialogRef}
        className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-center-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? [])].filter((element) => element.offsetParent !== null);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="flex items-center gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <div>
            <h2 id="run-center-title" className="font-semibold text-neutral-900 dark:text-white">Run center</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Inspect durable missions without interrupting background work.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ml-auto rounded-md p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white"
            onClick={onClose}
            aria-label="Close run center"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">
          {error ? <p className="mb-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p> : null}
          {visibleRuns.length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              No mission runs yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleRuns.map((run) => {
                const session = sessionsByTask.get(run.id);
                return (
                  <li key={run.id} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5">{stateIcon(run)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {session?.title ?? run.spec.objective}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400">
                          {run.spec.objective}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                          <span className="rounded bg-neutral-100 px-2 py-0.5 capitalize text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                            {stateLabel(run)}
                          </span>
                          {run.blocker ? (
                            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              {run.blocker.kind.replaceAll("-", " ")}
                            </span>
                          ) : null}
                          {run.approval?.status === "pending" ? (
                            <span className="rounded bg-sky-100 px-2 py-0.5 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                              Approval required
                            </span>
                          ) : null}
                        </div>
                        <details className="mt-3 text-xs text-neutral-600 dark:text-neutral-300">
                          <summary className="cursor-pointer font-medium">Run details</summary>
                          <dl className="mt-2 grid gap-1">
                            <div><dt className="inline font-medium">Budget: </dt><dd className="inline">{budgetSummary(run)}</dd></div>
                            <div><dt className="inline font-medium">Evidence: </dt><dd className="inline">{run.evidence.filter((evidence) => evidence.passed).length}/{run.evidence.length} passed</dd></div>
                            <div><dt className="inline font-medium">Artifacts: </dt><dd className="inline">{run.artifacts?.length ?? 0}</dd></div>
                          </dl>
                          {run.steps.length > 0 ? (
                            <ol className="mt-2 space-y-1" aria-label="Run steps">
                              {run.steps.map((step) => (
                                <li key={step.id} className="flex justify-between gap-3">
                                  <span>{step.description}</span>
                                  <span className="shrink-0 capitalize">{step.state}</span>
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </details>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                          onClick={() => inspect(run)}
                        >
                          Inspect
                        </button>
                        {["paused", "blocked", "waiting_for_approval"].includes(run.state) ? (
                          <button
                            type="button"
                            className="rounded-md border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950"
                            onClick={() => inspect(run)}
                          >
                            Review and resume
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                          onClick={() => exportRunDiagnostics(run)}
                        >
                          Export diagnostics
                        </button>
                        {["planning", "executing"].includes(run.state) ? (
                          <button
                            type="button"
                            className="rounded-md border border-sky-300 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-900 dark:text-sky-300 dark:hover:bg-sky-950"
                            onClick={() => void pause(run)}
                          >
                            Pause
                          </button>
                        ) : null}
                        {isRunActive(run) ? (
                          <button
                            type="button"
                            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                            onClick={() => void cancel(run)}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
