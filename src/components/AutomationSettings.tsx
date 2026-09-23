import { updateSettings, useSettings } from "../lib/settings";

export function AutomationSettings({ className }: { className: string }): React.ReactElement {
  const settings = useSettings();
  return (
    <>
      <section className={className}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Browser automation</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={settings.browserEnabled === true}
            disabled={!settings.enableTools}
            onChange={(event) => updateSettings({ browserEnabled: event.target.checked })}
          />
          Enable isolated browser sessions
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed domains</span>
          <textarea
            className="h-20 w-full resize-y rounded bg-neutral-200 px-2 py-1 font-mono text-xs dark:bg-neutral-800"
            placeholder={"example.com\ndocs.example.com"}
            value={settings.browserAllowedDomains ?? ""}
            onChange={(event) => updateSettings({ browserAllowedDomains: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={settings.browserHeadless !== false}
            onChange={(event) => updateSettings({ browserHeadless: event.target.checked })}
          />
          Run browser headlessly
        </label>
      </section>
      <section className={className}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Windows desktop automation</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-emerald-500"
            checked={settings.desktopEnabled === true}
            disabled={!settings.enableTools}
            onChange={(event) => updateSettings({ desktopEnabled: event.target.checked })}
          />
          Enable semantic UI Automation
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed process names</span>
          <textarea
            className="h-16 w-full resize-y rounded bg-neutral-200 px-2 py-1 font-mono text-xs dark:bg-neutral-800"
            placeholder={"notepad.exe\nCode.exe"}
            value={settings.desktopAllowedProcesses ?? ""}
            onChange={(event) => updateSettings({ desktopAllowedProcesses: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Allowed exact window titles</span>
          <textarea
            className="h-16 w-full resize-y rounded bg-neutral-200 px-2 py-1 font-mono text-xs dark:bg-neutral-800"
            value={settings.desktopAllowedWindows ?? ""}
            onChange={(event) => updateSettings({ desktopAllowedWindows: event.target.value })}
          />
        </label>
      </section>
    </>
  );
}
