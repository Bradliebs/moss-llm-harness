// src/components/WelcomeScreen.tsx
//
// Shown when the current conversation is empty. Offers a few starter prompts;
// picking one submits it as the first message of the turn. When no model is
// configured yet (e.g. first run on a fresh machine), the starter prompts would
// silently do nothing, so a setup call-to-action is shown instead.

import { Bug, FileSearch, FlaskConical, ScanText, type LucideIcon } from "lucide-react";

import { MossFace } from "./MossFace";
import { ReadinessIcon } from "./ReadinessIcon";
import { FirstRunGuide, type FirstRunGuideProps } from "./FirstRunGuide";
import type { ReadinessItem } from "../lib/settings";

const SUGGESTIONS: readonly { text: string; icon: LucideIcon }[] = [
  { text: "Summarize the files in my workspace.", icon: FileSearch },
  { text: "Explain what this project does.", icon: ScanText },
  { text: "Find and fix a bug in the current folder.", icon: Bug },
  { text: "Write a unit test for a function I point you to.", icon: FlaskConical },
];

interface WelcomeScreenProps {
  onPick: (text: string) => void;
  /** true when no model is selected; the starter prompts cannot run yet */
  needsSetup?: boolean;
  onOpenSettings?: () => void;
  readiness?: readonly ReadinessItem[];
  /** first-run walkthrough; omitted once dismissed */
  guide?: Omit<FirstRunGuideProps, "onTry" | "onOpenSettings">;
}

export function WelcomeScreen({ onPick, needsSetup, onOpenSettings, readiness = [], guide }: WelcomeScreenProps): React.ReactElement {
  const attentionCount = readiness.filter((item) => item.status === "attention").length;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-4 text-center animate-fade-in">
      <div className="flex flex-col items-center gap-3">
        <MossFace
          className="h-24 w-24 shadow-[0_10px_36px_rgba(16,185,129,0.2)] ring-4 ring-white/70 dark:ring-neutral-900/70"
          label="Moss portrait"
        />
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">Moss</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {needsSetup
            ? "Connect a model provider to start chatting."
            : "Pick a starting point, or just type a message below."}
        </p>
      </div>
      {guide ? <FirstRunGuide {...guide} onTry={onPick} onOpenSettings={() => onOpenSettings?.()} /> : null}
      {needsSetup && guide ? null : needsSetup ? (
        <div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-6 py-5">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Moss needs a model provider before it can respond. Run Ollama locally, or add an
            OpenAI-compatible or Anthropic API key in Settings, then pick a model.
          </p>
          <button
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-800"
            onClick={() => onOpenSettings?.()}
          >
            Open Settings
          </button>
        </div>
      ) : (
        <div className="w-full max-w-xl space-y-4">
          {readiness.length > 0 ? (
            <section className="rounded-xl border border-neutral-200 bg-white/70 p-3 text-left shadow-sm dark:border-neutral-800 dark:bg-neutral-900/70" aria-label="Capability readiness">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Ready for this session</h2>
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${
                  attentionCount > 0
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                    : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                }`}>
                  {attentionCount > 0 ? `${attentionCount} to review` : "Ready"}
                </span>
                <button type="button" className="ml-auto whitespace-nowrap text-xs text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => onOpenSettings?.()}>
                  Review readiness
                </button>
              </div>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {readiness.slice(0, 6).map((item) => (
                  <li key={item.id} className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300" title={item.detail}>
                    <ReadinessIcon status={item.status} />
                    {item.label}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SUGGESTIONS.map(({ text, icon: Icon }) => (
              <button
                key={text}
                className="group flex items-start gap-3 rounded-xl border border-neutral-200 bg-white/70 px-4 py-3 text-left text-sm text-neutral-700 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-emerald-500/50 hover:bg-white hover:text-neutral-900 motion-reduce:hover:translate-y-0 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                onClick={() => onPick(text)}
              >
                <Icon size={18} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                {text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
