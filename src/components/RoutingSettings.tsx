// src/components/RoutingSettings.tsx
//
// Model adaptation, routing, and trace replay. Fast and escalation routes can
// use any configured provider, so a local model can escalate to a cloud model;
// stored capability profiles are shown next to each choice so the selection
// rests on measurements.

import { useEffect, useState } from "react";

import { liveScore, modelKey } from "@common/live-scores";
import { isLocalRoute, routeDestination } from "@common/routes";
import type { ConstrainedOutputMode, ModelCapabilityProfile, ModelLiveScore, ModelPerformanceEntry, ModelRoute, ReplayReport, TurnTraceSummary } from "@common/types";

import { modelsStore, PROVIDER_PRESETS, toProviderConfig, updateSettings, useSettings, type MossSettings } from "../lib/settings";
import { LiveStatus } from "./LiveStatus";

function profileLabel(profile: ModelCapabilityProfile | undefined, live?: ModelLiveScore): string {
  const liveText = live && live.graded > 0 && live.successRate !== undefined
    ? `${Math.round(live.successRate * 100)}% on your work over ${Math.round(live.graded)} runs`
    : "";
  if (!profile) return liveText || "not profiled";
  const latency = profile.latency ? `, ${(profile.latency.medianMs / 1000).toFixed(1)}s` : "";
  return `${profile.tier}, ${Math.round(profile.overall * 100)}%${latency}${liveText ? `; ${liveText}` : ""}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

type ProfileLookup = (kind: string, baseUrl: string, model: string) => ModelCapabilityProfile | undefined;
type LiveLookup = (kind: string, baseUrl: string, model: string) => ModelLiveScore | undefined;

function presetBaseUrl(settings: MossSettings, presetId: string): string {
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
  return (settings.providerProfiles?.[presetId]?.baseUrl ?? preset?.baseUrl ?? "").trim();
}

/** Provider and model for one route. "This connection" keeps the older
 *  same-connection model setting; another provider stores a full route whose
 *  API key stays in secure storage and is resolved by the main process. */
function RoutePicker({
  id,
  label,
  emptyLabel,
  model,
  route,
  onChange,
  profileFor,
  liveFor,
}: {
  id: string;
  label: string;
  emptyLabel: string;
  model: string | undefined;
  route: ModelRoute | undefined;
  onChange: (next: { model?: string; route?: ModelRoute }) => void;
  profileFor: ProfileLookup;
  liveFor?: LiveLookup;
}): React.ReactElement {
  const settings = useSettings();
  const models = modelsStore.use();
  const currentPresetId = PROVIDER_PRESETS[settings.presetIndex]?.id;
  const [providerId, setProviderId] = useState<string>(route?.presetId && route.presetId !== currentPresetId ? route.presetId : "current");
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const others = PROVIDER_PRESETS.filter((preset) => preset.id !== currentPresetId && presetBaseUrl(settings, preset.id));

  useEffect(() => {
    if (providerId === "current") return;
    const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
    if (!preset || !window.moss?.provider) return;
    let cancelled = false;
    setLoadError("");
    void (async () => {
      try {
        const apiKey = await window.moss.provider.getCredential(preset.id);
        const list = await window.moss.provider.listModels({ kind: preset.kind, baseUrl: presetBaseUrl(settings, preset.id), apiKey: apiKey || undefined, model: "" });
        if (!cancelled) setRemoteModels(list);
      } catch (error) {
        if (!cancelled) {
          setRemoteModels([]);
          setLoadError(`Could not list ${preset.label} models. Select ${preset.label} under Provider once to save its API key. ${error instanceof Error ? error.message : ""}`.trim());
        }
      }
    })();
    return () => { cancelled = true; };
    // Settings changes that matter here are the preset base URLs, captured by providerId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
  const current = providerId === "current";
  const baseUrl = current ? settings.baseUrl : presetBaseUrl(settings, providerId);
  const kind = current ? settings.kind : preset?.kind ?? settings.kind;
  const listed = current ? models.filter((item) => item !== settings.model) : remoteModels;
  const selected = current ? model ?? "" : route?.presetId === providerId ? route.model : "";
  const choices = selected && !listed.includes(selected) ? [selected, ...listed] : listed;
  const select = "w-full rounded bg-neutral-200 px-2 py-1 dark:bg-neutral-800";
  const leavesMachine = Boolean(selected) && isLocalRoute(settings.baseUrl, settings.model) && !isLocalRoute(baseUrl, selected);

  return (
    <div className="space-y-1">
      <span id={`${id}-label`} className="block text-neutral-600 dark:text-neutral-400">{label}</span>
      <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
        <select
          aria-label={`${label} provider`}
          className={select}
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setRemoteModels([]);
            onChange({});
          }}
        >
          <option value="current">This connection</option>
          {others.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select
          aria-labelledby={`${id}-label`}
          className={select}
          value={selected}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) onChange({});
            else if (current) onChange({ model: value });
            else onChange({ route: { presetId: providerId, kind, baseUrl, model: value } });
          }}
        >
          <option value="">{emptyLabel}</option>
          {choices.map((item) => <option key={item} value={item}>{item} ({profileLabel(profileFor(kind, baseUrl, item), liveFor?.(kind, baseUrl, item))})</option>)}
        </select>
      </div>
      {loadError ? <p className="text-xs text-amber-800 dark:text-amber-300">{loadError}</p> : null}
      {leavesMachine ? (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          This route runs off this machine: when it is used, the conversation and workspace context go to {routeDestination(baseUrl, selected)}.
          Moss shows a notice each time a turn crosses to it.
        </p>
      ) : null}
    </div>
  );
}

const CONSTRAINED_LABELS: Record<ConstrainedOutputMode, string> = {
  auto: "Automatic",
  always: "Always",
  never: "Never",
};

export function RoutingSettings({ className }: { className: string }): React.ReactElement {
  const settings = useSettings();
  const models = modelsStore.use();
  const [profiles, setProfiles] = useState<ModelCapabilityProfile[]>([]);
  const [performance, setPerformance] = useState<ModelPerformanceEntry[]>([]);
  const [traces, setTraces] = useState<{ count: number; traces: TurnTraceSummary[] } | null>(null);
  const [replayModel, setReplayModel] = useState("");
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.moss?.model?.profiles()
      .then((list) => { if (!cancelled) setProfiles(list); })
      .catch(() => undefined);
    void window.moss?.model?.performance?.()
      .then((list) => { if (!cancelled) setPerformance(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function refreshTraces(): Promise<void> {
    const listed = await window.moss?.traces?.list().catch(() => null);
    if (listed) setTraces(listed);
  }

  useEffect(() => {
    void refreshTraces();
    return window.moss?.traces?.onReplayProgress((item) => setProgress(item));
  }, []);

  const profileAt: ProfileLookup = (kind, baseUrl, model) => profiles.find((profile) =>
    profile.model === model && profile.providerKind === kind
    && profile.endpoint.toLowerCase() === baseUrl.replace(/\/+$/, "").toLowerCase());
  const profileFor = (model: string): ModelCapabilityProfile | undefined => profileAt(settings.kind, settings.baseUrl, model);
  const liveAt: LiveLookup = (kind, baseUrl, model) => {
    const key = modelKey(kind, baseUrl, model);
    const own = performance.filter((entry) => modelKey(entry.providerKind, entry.endpoint, entry.model) === key);
    return own.length > 0 ? liveScore(own, "all") : undefined;
  };
  const constrainedMode = settings.constrainedOutput?.[settings.model] ?? "auto";
  const currentTier = profileFor(settings.model)?.tier;
  const constrainedNow = settings.kind === "openai-compatible"
    && (constrainedMode === "always" || (constrainedMode === "auto" && (currentTier === "limited" || currentTier === "unreliable")));
  const votingMode = settings.stepVoting?.[settings.model] ?? "auto";
  const currentProfile = profileFor(settings.model);
  const votingNow = constrainedNow && isLocalRoute(settings.baseUrl, settings.model)
    && (votingMode === "always" || (votingMode === "auto" && settings.adaptiveScaffolding !== false
      && (currentTier === "limited" || currentTier === "unreliable")
      && currentProfile?.latency !== undefined && currentProfile.latency.medianMs <= 4_000));
  function setVoting(mode: ConstrainedOutputMode): void {
    const next = { ...(settings.stepVoting ?? {}) };
    if (mode === "auto") delete next[settings.model];
    else next[settings.model] = mode;
    updateSettings({ stepVoting: next });
  }
  function setConstrained(mode: ConstrainedOutputMode): void {
    const next = { ...(settings.constrainedOutput ?? {}) };
    if (mode === "auto") delete next[settings.model];
    else next[settings.model] = mode;
    updateSettings({ constrainedOutput: next });
  }

  async function replay(trace: TurnTraceSummary): Promise<void> {
    if (!window.moss?.traces || !replayModel) return;
    setReplayingId(trace.id);
    setReport(null);
    setProgress(null);
    setStatus("");
    try {
      const result = await window.moss.traces.replay({ traceId: trace.id, config: { ...toProviderConfig(settings), model: replayModel } });
      setReport(result);
      setStatus(`${replayModel} made the same decision as ${result.baselineModel} on ${result.summary.sameAction} of ${result.summary.calls} calls.`);
    } catch (error) {
      setStatus(`Replay failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setReplayingId(null);
      setProgress(null);
    }
  }

  const select = "w-full rounded bg-neutral-200 px-2 py-1 dark:bg-neutral-800";
  return (
    <section className={className} aria-labelledby="routing-heading">
      <h3 id="routing-heading" className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
        Routing and adaptation
      </h3>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-emerald-600"
          checked={settings.adaptiveScaffolding !== false}
          onChange={(event) => updateSettings({ adaptiveScaffolding: event.target.checked })}
        />
        <span>
          Adapt to the measured capability profile
          <span className="block text-xs text-neutral-600 dark:text-neutral-300">
            Weaker models get fewer, task-relevant tools, step-by-step guidance, and one tool call per round. No effect until the
            model has been profiled. Missions keep their granted capabilities.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-emerald-600"
          checked={settings.semanticRanking === true}
          onChange={(event) => updateSettings({ semanticRanking: event.target.checked })}
        />
        <span>
          Rank tools and lessons by meaning
          <span className="block text-xs text-neutral-600 dark:text-neutral-300">
            Uses the embeddings model under Settings &gt; Knowledge ({settings.embedModel || "nomic-embed-text"} at{" "}
            {routeDestination((settings.embedBaseUrl || settings.baseUrl || "").trim(), "")}) to keep the right tools when adaptation
            narrows them and to recall related lessons. Each request's text goes to that endpoint. Without it, Moss matches
            words.
          </span>
        </span>
      </label>
      {settings.kind === "openai-compatible" && settings.model ? (
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Constrained tool output for {settings.model}</span>
          <select
            aria-label={`Constrained tool output for ${settings.model}`}
            className={select}
            value={constrainedMode}
            onChange={(event) => setConstrained(event.target.value as ConstrainedOutputMode)}
          >
            {(Object.keys(CONSTRAINED_LABELS) as ConstrainedOutputMode[]).map((mode) => (
              <option key={mode} value={mode}>{CONSTRAINED_LABELS[mode]}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-neutral-600 dark:text-neutral-300">
            Constrained output makes every model step a schema-valid tool call or a final answer, which lets small local models
            use tools reliably. Automatic turns it on for limited and unreliable profiles. {constrainedNow ? "On for this model." : "Off for this model."}
            {" "}Tool calls written as text are repaired either way.
          </span>
        </label>
      ) : null}
      {settings.kind === "openai-compatible" && settings.model ? (
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Vote on each step for {settings.model}</span>
          <select
            aria-label={`Vote on each step for ${settings.model}`}
            className={select}
            value={votingMode}
            onChange={(event) => setVoting(event.target.value as ConstrainedOutputMode)}
          >
            {(Object.keys(CONSTRAINED_LABELS) as ConstrainedOutputMode[]).map((mode) => (
              <option key={mode} value={mode}>{CONSTRAINED_LABELS[mode]}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-neutral-600 dark:text-neutral-300">
            With constrained output on a local model, Moss samples each step three times and runs the most common one. It
            about doubles the time per step and catches one-off wrong calls. Automatic votes for limited and unreliable models
            whose median reply takes under 4 seconds. {votingNow ? "Voting is on for this model." : "Voting is off for this model."}
          </span>
        </label>
      ) : null}
      <RoutePicker
        id="fast-route"
        label="Fast model for summaries and read-only subagents"
        emptyLabel="Same as the chat model"
        model={settings.fastModel}
        route={settings.fastRoute}
        profileFor={profileAt}
        liveFor={liveAt}
        onChange={(next) => updateSettings({ fastModel: next.model, fastRoute: next.route })}
      />
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem] sm:items-end">
        <RoutePicker
          id="escalation-route"
          label="Escalation model"
          emptyLabel="Do not escalate"
          model={settings.escalationModel}
          route={settings.escalationRoute}
          profileFor={profileAt}
        liveFor={liveAt}
          onChange={(next) => updateSettings({ escalationModel: next.model, escalationRoute: next.route })}
        />
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">After rejections</span>
          <input
            type="number"
            min={1}
            max={5}
            className={select}
            disabled={!settings.escalationModel && !settings.escalationRoute}
            value={settings.escalateAfter ?? 2}
            onChange={(event) => updateSettings({ escalateAfter: Math.min(5, Math.max(1, Math.floor(Number(event.target.value) || 2))) })}
          />
        </label>
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">
        A turn switches to the escalation model after Moss rejects its work this many times: a failed tool call, failed
        verification, or a refused completion. Your own denials never count, and the model never decides this itself.
        Escalation to a paid model uses your provider credits, and missions price each step at the model that ran it.
      </p>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-emerald-600"
          checked={settings.recordTraces === true}
          onChange={(event) => updateSettings({ recordTraces: event.target.checked })}
        />
        <span>
          Record turn traces for replay
          <span className="block text-xs text-neutral-600 dark:text-neutral-300">
            Stores every model request and response locally, including conversation and workspace content, for 14 days (up to
            200 turns). Nothing is uploaded.
          </span>
        </span>
      </label>
      {traces ? (
        <div className="space-y-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800" aria-label="Recorded traces">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-neutral-800 dark:text-neutral-100">{traces.count} recorded trace{traces.count === 1 ? "" : "s"}</span>
            <button type="button" className="underline" onClick={() => void window.moss?.traces?.openFolder()}>Open folder</button>
            {traces.count > 0 ? (
              <button
                type="button"
                className="text-red-700 underline dark:text-red-300"
                onClick={() => void window.moss?.traces?.clear().then(refreshTraces).then(() => setStatus("Deleted all recorded traces."))}
              >
                Delete all
              </button>
            ) : null}
          </div>
          {traces.traces.length > 0 ? (
            <>
              <label className="flex items-center gap-2">
                <span className="text-neutral-700 dark:text-neutral-200">Replay against</span>
                <select className="rounded bg-neutral-200 px-2 py-0.5 dark:bg-neutral-800" value={replayModel} onChange={(event) => setReplayModel(event.target.value)}>
                  <option value="">Choose a model…</option>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {traces.traces.map((trace) => (
                  <li key={trace.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-100" title={trace.preview}>
                      {new Date(trace.createdAt).toLocaleString()} · {trace.primaryModel}{trace.escalatedTo ? ` → ${trace.escalatedTo}` : ""} · {trace.callCount} calls · {trace.outcome ?? "unknown"} · {trace.preview}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 disabled:opacity-50 dark:border-neutral-700"
                      disabled={!replayModel || replayingId !== null}
                      onClick={() => void replay(trace)}
                    >
                      {replayingId === trace.id ? `Replaying ${progress ? `${progress.completed}/${progress.total}` : "…"}` : "Replay"}
                    </button>
                  </li>
                ))}
              </ul>
              {replayingId ? (
                <button type="button" className="underline" onClick={() => void window.moss?.traces?.cancelReplay()}>Cancel replay</button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <LiveStatus message={status} className="text-xs text-neutral-700 dark:text-neutral-200" />
      {report ? (
        <table className="w-full text-xs" aria-label="Replay results">
          <caption className="sr-only">Replay results by call</caption>
          <thead>
            <tr className="text-left text-neutral-700 dark:text-neutral-200">
              <th scope="col" className="pr-2">Call</th>
              <th scope="col" className="pr-2">{report.baselineModel}</th>
              <th scope="col" className="pr-2">{report.candidateModel}</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {report.calls.map((call) => (
              <tr key={call.index} className="align-top text-neutral-800 dark:text-neutral-100">
                <td className="pr-2">{call.index + 1}</td>
                <td className="pr-2">{call.baseline.toolNames.join(", ") || "answered"}</td>
                <td className="pr-2">{call.candidate.error ? `error: ${call.candidate.error}` : call.candidate.toolNames.join(", ") || "answered"}</td>
                <td>
                  {call.agreement.replace(/-/g, " ")}
                  {call.candidate.unknownArguments.length ? ` (unknown arguments: ${call.candidate.unknownArguments.join(", ")})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-neutral-700 dark:text-neutral-200">
              <td colSpan={4} className="pt-1">
                Agreement {percent(report.summary.agreementRate)} · valid arguments {percent(report.summary.validArgumentRate)} · {report.summary.errors} errors
                {report.summary.medianLatencyMs !== undefined ? ` · median ${(report.summary.medianLatencyMs / 1000).toFixed(1)}s` : ""}
                {report.summary.baselineMedianLatencyMs !== undefined ? ` (original ${(report.summary.baselineMedianLatencyMs / 1000).toFixed(1)}s)` : ""}
              </td>
            </tr>
          </tfoot>
        </table>
      ) : null}
    </section>
  );
}
