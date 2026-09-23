import type { TaskBlockerKind, TaskHistoryEntry, TaskSnapshot } from "@common/types";

import { formatUsd } from "../lib/pricing";

interface MissionMonitorProps {
  task: TaskSnapshot;
  history: TaskHistoryEntry[];
  onRecover: () => void;
  onResume: () => void;
  onCancel: () => void;
  onOpenArtifact: (id: string) => void;
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function blockerRecovery(kind: TaskBlockerKind): { label: string; action: "revise" | "settings" | "guidance" } {
  if (kind === "verification") return { label: "Edit verification", action: "revise" };
  if (kind === "budget") return { label: "Revise budget", action: "revise" };
  if (kind === "missing-capability" || kind === "permission") return { label: "Review capabilities", action: "revise" };
  if (kind === "user-decision") return { label: "Add guidance", action: "guidance" };
  if (kind === "credential") return { label: "Configure credentials", action: "settings" };
  if (kind === "unavailable-service") return { label: "Check services", action: "settings" };
  return { label: "Review setup", action: "settings" };
}

export function MissionMonitor({
  task,
  history,
  onRecover,
  onResume,
  onCancel,
  onOpenArtifact,
}: MissionMonitorProps): React.ReactElement {
  const actionCount = task.attempts.reduce((total, attempt) => total + attempt.actionCount, 0);
  const tokenCount = task.attempts.reduce(
    (total, attempt) => total + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
    0,
  );
  const cost = task.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0);
  const elapsedMs = Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime());
  const runningStep = task.steps.find((step) => step.state === "running");
  const exclusiveStep = task.steps.find(
    (step) => step.state === "running" && step.mission?.executionLane === "exclusive",
  );
  const canResume = task.state === "paused" || (task.state === "blocked"
    && task.blocker?.resumable
    && !["verification", "budget", "missing-capability", "permission", "unsupported-environment"].includes(task.blocker.kind));

  return (
    <section className="border-t border-neutral-200 bg-white/70 px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/70" aria-label="Task status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">Task</span>
        <span className={
          task.state === "completed"
            ? "text-emerald-600 dark:text-emerald-400"
            : task.state === "blocked" || task.state === "failed"
              ? "text-red-600 dark:text-red-400"
              : task.state === "paused" || task.state === "waiting_for_approval"
                ? "text-amber-600 dark:text-amber-400"
                : "text-sky-600 dark:text-sky-400"
        }>
          {task.state.replaceAll("_", " ")}
        </span>
        <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
          {runningStep?.description ?? task.spec.objective}
        </span>
        {task.missionPlan ? (
          <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
            Plan r{task.missionPlan.revision} · {task.steps.filter((step) => step.state === "completed").length}/{task.steps.length} steps
          </span>
        ) : null}
        {runningStep?.mission ? (
          <span className="text-neutral-500 dark:text-neutral-400">
            {runningStep.mission.workerRole} · {runningStep.mission.executionLane}
          </span>
        ) : null}
        <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
          {task.attempts.length} {task.attempts.length === 1 ? "attempt" : "attempts"} · {task.evidence.filter((item) => item.passed).length}/{task.spec.acceptanceCriteria.filter((item) => item.mandatory).length} evidence
        </span>
        {task.spec.budget?.maxActions ? (
          <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
            {actionCount}/{task.spec.budget.maxActions} actions
          </span>
        ) : null}
        {task.approval ? (
          <span className="font-mono text-neutral-500 dark:text-neutral-400">
            {task.approval.toolName} {task.approval.status}
          </span>
        ) : null}
        {task.state === "blocked" && task.blocker ? (
          <button
            className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
            onClick={onRecover}
          >
            {blockerRecovery(task.blocker.kind).label}
          </button>
        ) : null}
        {canResume ? (
          <button className="rounded bg-neutral-200 px-2 py-0.5 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700" onClick={onResume}>
            Resume
          </button>
        ) : null}
        {!["completed", "failed", "cancelled"].includes(task.state) ? (
          <button className="text-red-600 hover:text-red-500 dark:text-red-400" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      {task.spec.budget ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400" aria-label="Remaining mission budget">
          {task.spec.budget.maxActions ? <span>{Math.max(0, task.spec.budget.maxActions - actionCount)} actions left</span> : null}
          {task.spec.budget.maxTokens ? <span>{formatTokens(Math.max(0, task.spec.budget.maxTokens - tokenCount))} tokens left</span> : null}
          {task.spec.budget.maxCostUsd ? <span>{formatUsd(Math.max(0, task.spec.budget.maxCostUsd - cost))} left</span> : null}
          {task.spec.budget.maxDurationMs ? <span title="Remaining at the latest durable checkpoint">{formatDuration(task.spec.budget.maxDurationMs - elapsedMs)} left</span> : null}
          {exclusiveStep ? <span className="font-medium text-amber-700 dark:text-amber-300">Exclusive: {exclusiveStep.description}</span> : null}
        </div>
      ) : null}
      {task.blocker ? <p className="mt-1 whitespace-pre-wrap text-amber-700 dark:text-amber-300">{task.blocker.summary}</p> : null}
      {(task.missionPlan || task.evidence.length > 0 || (task.artifacts?.length ?? 0) > 0) ? (
        <details className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-800">
          <summary className="w-fit cursor-pointer select-none text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
            Mission details
          </summary>
          {task.missionPlan ? (
            <ol className="mt-1 grid gap-1 sm:grid-cols-2">
              {task.steps.map((step) => (
                <li key={step.id} className="flex min-w-0 gap-2 text-neutral-600 dark:text-neutral-300">
                  <span className="w-16 shrink-0 text-neutral-400">{step.state}</span>
                  <span className="min-w-0 truncate">{step.description}</span>
                  {step.mission ? <span className="ml-auto shrink-0 text-neutral-400">{step.mission.workerRole}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {task.spec.acceptanceCriteria.map((criterion) => {
              const criterionEvidence = task.evidence.filter((item) => item.criterionId === criterion.id);
              return (
                <div key={criterion.id} className="min-w-0 border-l-2 border-neutral-300 pl-2 dark:border-neutral-700">
                  <div className="flex gap-2 text-neutral-700 dark:text-neutral-200">
                    <span className="min-w-0 flex-1 truncate">{criterion.description}</span>
                    <span className="shrink-0 tabular-nums text-neutral-400">{criterionEvidence.filter((item) => item.passed).length}/{criterionEvidence.length}</span>
                  </div>
                  {criterionEvidence.map((item) => (
                    <p key={item.id} className={item.passed ? "truncate text-emerald-600 dark:text-emerald-400" : "truncate text-red-600 dark:text-red-400"}>
                      {item.summary}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
          {task.artifacts && task.artifacts.length > 0 ? (
            <ul className="mt-2 space-y-1" aria-label="Mission artifacts">
              {task.artifacts.map((artifact) => (
                <li key={artifact.id} className="flex gap-2 text-neutral-600 dark:text-neutral-300">
                  <button type="button" className="min-w-0 break-words text-left font-mono underline decoration-neutral-400 underline-offset-2 hover:text-emerald-600" title={`Open ${artifact.name}`} onClick={() => onOpenArtifact(artifact.id)}>
                    {artifact.name}
                  </button>
                  <span className="min-w-0 truncate text-neutral-400">{artifact.summary}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
      {history.length > 0 ? (
        <details className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-800">
          <summary className="w-fit cursor-pointer select-none text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
            Timeline ({history.length})
          </summary>
          <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto border-l border-neutral-300 pl-3 dark:border-neutral-700">
            {history.map((entry) => (
              <li key={entry.id} className="flex gap-2 text-neutral-600 dark:text-neutral-300">
                <time className="shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500" dateTime={entry.occurredAt}>
                  {new Date(entry.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
                <span>{entry.summary}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
