// src/components/PracticeSettings.tsx
//
// Practice runs: replays your recorded work against other local models while
// the PC is idle, and re-runs tasks with a reproducible start state in
// disposable copies graded by your own verification commands. Results come
// with an optional recommendation; nothing changes until you apply it.

import { useEffect, useState } from "react";

import type { PracticeConfig, PracticeProgress, PracticeReport } from "@common/types";

import { isCloudModel, isEmbeddingModel } from "../lib/setupProposal";
import { PROVIDER_PRESETS, updateSettings, useSettings } from "../lib/settings";
import { LiveStatus } from "./LiveStatus";

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}

export function PracticeSettings({ className }: { className: string }): React.ReactElement | null {
  const settings = useSettings();
  const bridge = window.moss?.practice;
  const baseUrl = (settings.providerProfiles?.ollama?.baseUrl ?? PROVIDER_PRESETS.find((preset) => preset.id === "ollama")?.baseUrl ?? "").trim();
  const [config, setConfig] = useState<PracticeConfig | null>(null);
  const [latest, setLatest] = useState<PracticeReport | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PracticeProgress | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.get().then((state) => {
      if (cancelled) return;
      setConfig(state.config);
      setLatest(state.latest);
      setRunning(state.running);
    }).catch(() => undefined);
    void window.moss.provider?.listModels({ kind: "openai-compatible", baseUrl, model: "" })
      .then((list) => { if (!cancelled) setModels(list.filter((name) => !isCloudModel(name) && !isEmbeddingModel(name))); })
      .catch(() => undefined);
    const unsubscribe = bridge.onProgress((item) => setProgress(item));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, baseUrl]);

  if (!bridge || !config) return null;

  async function save(next: PracticeConfig): Promise<void> {
    setConfig(await bridge!.configure({ ...next, baseUrl }));
  }

  async function runNow(): Promise<void> {
    setRunning(true);
    setStatus("");
    setProgress(null);
    try {
      const report = await bridge!.run();
      setLatest(report);
      setStatus(report.cancelled ? "Practice run cancelled." : `Practice run finished: ${report.candidates.length} model${report.candidates.length === 1 ? "" : "s"} on ${report.tracesUsed} recorded turn${report.tracesUsed === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(`Practice run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function applyRecommendation(report: PracticeReport): void {
    const recommendation = report.recommendation;
    if (!recommendation) return;
    updateSettings(recommendation.role === "chat" ? { model: recommendation.model } : { fastModel: recommendation.model, fastRoute: undefined });
    setStatus(recommendation.role === "chat" ? `Switched the chat model to ${recommendation.model}.` : `Set ${recommendation.model} as the fast model.`);
  }

  const toggleCandidate = (model: string, on: boolean): void => {
    const candidates = on ? [...new Set([...config.candidates, model])].slice(0, 6) : config.candidates.filter((item) => item !== model);
    void save({ ...config, candidates });
  };
  const choices = [...new Set([...config.candidates, ...models])];
  return (
    <section className={className} aria-labelledby="practice-heading">
      <h3 id="practice-heading" className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Practice runs</h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">
        Replays your recorded turns against other local models to compare decisions. Turns recorded in a clean git workspace
        with verification commands are also re-run in a disposable copy of that commit and graded by your checks. Candidates
        get file tools inside the copy only: no shell, network, or email. Needs trace recording on. Results feed the live
        scores at half weight.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-emerald-600"
          checked={config.enabled}
          onChange={(event) => void save({ ...config, enabled: event.target.checked })}
        />
        <span>
          Practice while this PC is idle
          <span className="block text-xs text-neutral-600 dark:text-neutral-300">
            At most once a day, after {config.idleMinutes} idle minutes on mains power. Starting a turn stops it.
          </span>
        </span>
      </label>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-neutral-600 dark:text-neutral-400">Candidate models on this PC</legend>
        {choices.length === 0 ? <p className="text-xs text-neutral-600 dark:text-neutral-300">No local Ollama models found.</p> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {choices.map((model) => (
            <label key={model} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" className="accent-emerald-600" checked={config.candidates.includes(model)} onChange={(event) => toggleCandidate(model, event.target.checked)} />
              {model}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button type="button" className="rounded bg-neutral-200 px-3 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700" onClick={() => void bridge.cancel()}>
            Cancel practice
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            disabled={config.candidates.length === 0}
            onClick={() => void runNow()}
          >
            Practice now
          </button>
        )}
        {running && progress ? <span className="text-xs text-neutral-700 dark:text-neutral-200">{progress.completed}/{progress.total} · {progress.message}</span> : null}
      </div>
      <LiveStatus message={status} className="text-xs text-neutral-700 dark:text-neutral-200" />
      {latest ? (
        <div className="space-y-1 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800" aria-label="Latest practice report">
          <p className="text-neutral-700 dark:text-neutral-200">
            {new Date(latest.finishedAt).toLocaleString()} · {latest.tracesUsed} recorded turn{latest.tracesUsed === 1 ? "" : "s"}, {latest.outcomeTraces} re-run in a
            disposable copy · original models passed {latest.baseline.outcome.passed} of {latest.baseline.outcome.runs}
            {latest.cancelled ? " · cancelled" : ""}
          </p>
          <table className="w-full">
            <caption className="sr-only">Practice results by model</caption>
            <thead>
              <tr className="text-left text-neutral-600 dark:text-neutral-300">
                <th scope="col" className="pr-2 font-medium">Model</th>
                <th scope="col" className="pr-2 font-medium">Same decision</th>
                <th scope="col" className="pr-2 font-medium">Valid arguments</th>
                <th scope="col" className="pr-2 font-medium">Median reply</th>
                <th scope="col" className="font-medium">Verified tasks</th>
              </tr>
            </thead>
            <tbody>
              {latest.candidates.map((candidate) => (
                <tr key={candidate.model} className="text-neutral-800 dark:text-neutral-100">
                  <td className="pr-2">{candidate.model}{candidate.error ? ` (error: ${candidate.error})` : ""}</td>
                  <td className="pr-2 tabular-nums">{percent(candidate.decision.sameAction, candidate.decision.calls)}</td>
                  <td className="pr-2 tabular-nums">{candidate.decision.calls ? `${Math.round(candidate.decision.validArgumentRate * 100)}%` : "–"}</td>
                  <td className="pr-2 tabular-nums">{candidate.decision.medianLatencyMs !== undefined ? `${(candidate.decision.medianLatencyMs / 1000).toFixed(1)}s` : "–"}</td>
                  <td className="tabular-nums">{candidate.outcome.runs ? `${candidate.outcome.passed} of ${candidate.outcome.runs}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {latest.recommendation ? (
            <div className="flex flex-wrap items-center gap-2 rounded bg-emerald-50 p-2 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" aria-label="Practice recommendation">
              <span>{latest.recommendation.reason}</span>
              <button type="button" className="rounded border border-emerald-600 px-2 py-0.5" onClick={() => applyRecommendation(latest)}>
                {latest.recommendation.role === "chat" ? `Use ${latest.recommendation.model} for chat` : `Use ${latest.recommendation.model} as the fast model`}
              </button>
            </div>
          ) : (
            <p className="text-neutral-600 dark:text-neutral-300">No change recommended: no candidate clearly beat the models you use.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
