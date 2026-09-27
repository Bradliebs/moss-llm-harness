// src/components/ModelProfileSettings.tsx
//
// Runs the capability probe suite against the selected model, shows the
// measured profile, and applies the settings those measurements support.

import { useEffect, useState } from "react";

import type { CapabilityDimension, ModelCapabilityProfile, ModelProbeProgress } from "@common/types";

import { toProviderConfig, updateSettings, useSettings } from "../lib/settings";
import { LiveStatus } from "./LiveStatus";

const LABELS: Record<CapabilityDimension, string> = {
  "tool-calling": "Tool calling",
  "tool-selection": "Tool selection",
  "tool-restraint": "Tool restraint",
  "structured-output": "Structured output",
  "instruction-following": "Instruction following",
  "usable-context": "Usable context",
  "plan-coherence": "Plan coherence",
};

const TIER_CLASS: Record<ModelCapabilityProfile["tier"], string> = {
  strong: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
  capable: "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100",
  limited: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  unreliable: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100",
};

const CONTEXT_CHOICES = [
  { value: 8_192, label: "Up to 8K tokens (fastest)" },
  { value: 32_768, label: "Up to 32K tokens" },
  { value: 131_072, label: "Up to 128K tokens (slow on local models)" },
];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeSettings(settings: ModelCapabilityProfile["recommendation"]["settings"]): string[] {
  const lines: string[] = [];
  if (settings.enableTools === false) lines.push("Turn tools off");
  if (settings.maxToolRounds !== undefined) lines.push(`Max tool rounds: ${settings.maxToolRounds}`);
  if (settings.contextLimit !== undefined) lines.push(`Context limit: ${settings.contextLimit.toLocaleString("en-US")} tokens`);
  return lines;
}

function downloadProfile(profile: ModelCapabilityProfile): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `moss-profile-${profile.model.replace(/[^a-z0-9.-]+/gi, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ModelProfileSettings({ className }: { className: string }): React.ReactElement {
  const settings = useSettings();
  const bridge = window.moss?.model;
  const [profile, setProfile] = useState<ModelCapabilityProfile | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ModelProbeProgress | null>(null);
  const [status, setStatus] = useState("");
  const [maxContext, setMaxContext] = useState(32_768);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    if (!bridge || !settings.model || !settings.baseUrl) return;
    void bridge.profile(settings.kind, settings.baseUrl, settings.model)
      .then((stored) => { if (!cancelled) setProfile(stored); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [bridge, settings.kind, settings.baseUrl, settings.model]);

  useEffect(() => bridge?.onProbeProgress((item) => setProgress(item)), [bridge]);

  async function run(): Promise<void> {
    if (!bridge) return;
    setRunning(true);
    setProgress(null);
    setStatus("");
    try {
      const result = await bridge.probe({ config: toProviderConfig(settings), options: { maxContextTokens: maxContext } });
      setProfile(result);
      setStatus(`Profiled ${result.model}: ${result.tier}, ${percent(result.overall)} overall.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(/cancel/i.test(message) ? "Capability probe cancelled." : `Capability probe failed: ${message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function apply(): void {
    if (!profile) return;
    const recommended = profile.recommendation.settings;
    const patch = {
      ...(recommended.enableTools === false ? { enableTools: false } : {}),
      ...(recommended.maxToolRounds !== undefined ? { maxToolRounds: recommended.maxToolRounds } : {}),
      ...(recommended.contextLimit !== undefined ? { contextLimit: recommended.contextLimit } : {}),
    };
    updateSettings(patch);
    setStatus(`Applied ${Object.keys(patch).length} recommended setting${Object.keys(patch).length === 1 ? "" : "s"}.`);
  }

  const settingLines = profile ? describeSettings(profile.recommendation.settings) : [];
  return (
    <section className={className} aria-labelledby="model-profile-heading">
      <h3 id="model-profile-heading" className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
        Capability profile
      </h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">
        Measure how reliably the selected model calls tools, returns JSON, follows instructions, recalls long context, and
        completes multi-step tool chains. The probe sends about 30 short requests with fake tools; nothing runs on your
        system. Cloud providers charge for the tokens used.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-neutral-700 dark:text-neutral-200">
          <span className="mb-1 block">Longest context to test</span>
          <select
            className="rounded bg-neutral-200 px-2 py-1 dark:bg-neutral-800"
            value={maxContext}
            disabled={running}
            onChange={(event) => setMaxContext(Number(event.target.value))}
          >
            {CONTEXT_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>
        {running ? (
          <button type="button" className="rounded bg-neutral-200 px-3 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700" onClick={() => void bridge?.cancelProbe()}>
            Cancel probe
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            disabled={!bridge || !settings.model || !settings.baseUrl}
            onClick={() => void run()}
          >
            {profile ? "Re-run capability probe" : "Run capability probe"}
          </button>
        )}
      </div>
      {running ? (
        <div className="space-y-1" aria-label="Probe progress">
          <progress
            className="h-1.5 w-full accent-emerald-600"
            max={progress?.totalDimensions ?? 7}
            value={progress?.completedDimensions ?? 0}
            aria-label="Capability probe progress"
          />
          <p className="text-xs text-neutral-700 dark:text-neutral-200">{progress?.message ?? "Starting…"}</p>
        </div>
      ) : null}
      <LiveStatus message={status} className="text-xs text-neutral-700 dark:text-neutral-200" />
      {!profile && !running && settings.model ? (
        <p className="text-xs text-neutral-600 dark:text-neutral-300">{settings.model} has not been profiled on this endpoint yet.</p>
      ) : null}
      {profile ? (
        <div className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800" aria-label="Capability profile results">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{profile.model}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${TIER_CLASS[profile.tier]}`}>{profile.tier}</span>
            <span className="text-xs text-neutral-700 dark:text-neutral-200">{percent(profile.overall)} overall</span>
            <span className="ml-auto text-[11px] text-neutral-600 dark:text-neutral-300">
              {new Date(profile.probedAt).toLocaleString()} · {Math.round(profile.durationMs / 1000)}s ·{" "}
              {((profile.usage.inputTokens ?? 0) + (profile.usage.outputTokens ?? 0)).toLocaleString("en-US")} tokens
              {profile.latency ? ` · median ${(profile.latency.medianMs / 1000).toFixed(1)}s per reply` : ""}
              {profile.failedRequests ? ` · ${profile.failedRequests} failed or timed out` : ""}
            </span>
          </div>
          <table className="w-full text-xs">
            <caption className="sr-only">Scores by capability</caption>
            <tbody>
              {profile.results.map((result) => (
                <tr key={result.dimension} className="align-top">
                  <th scope="row" className="w-40 py-0.5 pr-2 text-left font-medium text-neutral-800 dark:text-neutral-100">{LABELS[result.dimension]}</th>
                  <td className="w-24 py-0.5 pr-2">
                    <meter className="w-full" min={0} max={1} low={0.5} high={0.85} optimum={1} value={result.score} aria-label={`${LABELS[result.dimension]} score`} />
                  </td>
                  <td className="w-10 py-0.5 pr-2 tabular-nums text-neutral-800 dark:text-neutral-100">{percent(result.score)}</td>
                  <td className="py-0.5 text-neutral-700 dark:text-neutral-200">
                    {result.summary}
                    {result.trials.some((item) => !item.passed && item.note) ? (
                      <details>
                        <summary className="cursor-pointer text-[11px] text-neutral-600 dark:text-neutral-300">Failures</summary>
                        <ul className="list-disc pl-4 text-[11px]">
                          {result.trials.filter((item) => !item.passed && item.note).map((item) => <li key={item.id}>{item.note}</li>)}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-neutral-800 dark:text-neutral-100">
            Recommended scaffolding: <strong className="capitalize">{profile.recommendation.scaffolding}</strong> · tools{" "}
            <strong>{profile.recommendation.toolUse}</strong> · structured output <strong>{profile.recommendation.structuredOutput}</strong>
          </p>
          {profile.recommendation.notes.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-neutral-700 dark:text-neutral-200" aria-label="Profile notes">
              {profile.recommendation.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {settingLines.length > 0 ? (
              <>
                <span className="text-xs text-neutral-700 dark:text-neutral-200">Suggested: {settingLines.join(" · ")}</span>
                <button type="button" className="rounded border border-emerald-600 px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950" onClick={apply}>
                  Apply suggested settings
                </button>
              </>
            ) : null}
            <button type="button" className="ml-auto text-xs text-neutral-700 underline dark:text-neutral-200" onClick={() => downloadProfile(profile)}>
              Export profile
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
