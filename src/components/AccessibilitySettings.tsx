// src/components/AccessibilitySettings.tsx
//
// Display, notification, and keyboard preferences.

import { SHORTCUTS } from "../lib/shortcuts";
import { updateSettings, useSettings } from "../lib/settings";

export function AccessibilitySettings({ className }: { className: string }): React.ReactElement {
  const settings = useSettings();
  return (
    <section className={className}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Accessibility and notifications</h3>
      <label className="block">
        <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Text size</span>
        <select
          className="w-full rounded bg-neutral-200 px-2 py-1 dark:bg-neutral-800"
          value={settings.fontScale ?? "default"}
          onChange={(event) => updateSettings({ fontScale: event.target.value as "default" | "large" | "larger" })}
        >
          <option value="default">Default</option>
          <option value="large">Large (112%)</option>
          <option value="larger">Larger (125%)</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-emerald-600"
          checked={settings.highContrast === true}
          onChange={(event) => updateSettings({ highContrast: event.target.checked })}
        />
        High-contrast text, borders, and focus outlines
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-emerald-600"
          checked={settings.desktopNotifications !== false}
          onChange={(event) => updateSettings({ desktopNotifications: event.target.checked })}
        />
        Notify me when background work needs approval, blocks, or finishes
      </label>
      {settings.onboardingDismissed ? (
        <button
          type="button"
          className="rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700"
          onClick={() => updateSettings({ onboardingDismissed: false })}
        >
          Show the getting-started guide again
        </button>
      ) : null}
      <details>
        <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">Keyboard shortcuts</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="Keyboard shortcuts">
          {[...SHORTCUTS, { command: "stop", keys: "Esc", label: "Stop the current response" }].map((binding) => (
            <div key={binding.command} className="contents">
              <dt><kbd className="rounded border border-neutral-300 px-1.5 dark:border-neutral-600">{binding.keys}</kbd></dt>
              <dd className="text-neutral-700 dark:text-neutral-300">{binding.label}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
