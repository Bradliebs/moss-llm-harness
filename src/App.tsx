// src/App.tsx

import { lazy, Suspense, useEffect, useState } from "react";

import { ChatPanel } from "./components/ChatPanel";
import type { PaletteCommand } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import type { SettingsCategoryId } from "./lib/guidance";
import { createSession, selectSession, sortSessionsForDisplay, useSessions } from "./lib/sessions";
import { initializeProviderCredential, settingsStore, updateSettings } from "./lib/settings";
import { matchShortcut, shortcutFor } from "./lib/shortcuts";

const LibraryPanel = lazy(() =>
  import("./components/LibraryPanel").then(({ LibraryPanel }) => ({ default: LibraryPanel })),
);
const SettingsPanel = lazy(() =>
  import("./components/SettingsPanel").then(({ SettingsPanel }) => ({ default: SettingsPanel })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })),
);
const RunCenter = lazy(() =>
  import("./components/RunCenter").then(({ RunCenter }) => ({ default: RunCenter })),
);

type Overlay = "none" | "settings" | "library" | "runs";

const FONT_SCALE: Record<"default" | "large" | "larger", string> = {
  default: "",
  large: "112.5%",
  larger: "125%",
};

export default function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const settings = settingsStore.use();
  const theme = settings.theme;
  const { sessions } = useSessions();

  function openSettings(category?: SettingsCategoryId): void {
    setSettingsCategory(category);
    setOverlay("settings");
  }

  useEffect(() => {
    void initializeProviderCredential();
  }, []);

  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "auto" && !!mq?.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (theme !== "auto" || !mq) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = FONT_SCALE[settings.fontScale ?? "default"];
    document.documentElement.classList.toggle("high-contrast", settings.highContrast === true);
  }, [settings.fontScale, settings.highContrast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = matchShortcut(event);
      if (!command) return;
      const modalOpen = !!document.querySelector('[aria-modal="true"]');
      if (command === "palette") {
        event.preventDefault();
        setPaletteOpen((open) => (open ? false : !modalOpen));
        return;
      }
      if (modalOpen) return;
      event.preventDefault();
      if (command === "new-chat") createSession();
      else if (command === "open-settings") openSettings();
      else if (command === "open-runs") setOverlay("runs");
      else if (command === "open-library") setOverlay("library");
      else if (command === "focus-composer") window.dispatchEvent(new Event("moss:focus-composer"));
      else if (command === "toggle-sidebar") updateSettings({ sidebarCollapsed: !settingsStore.get().sidebarCollapsed });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const paletteCommands: PaletteCommand[] = [
    { id: "new-chat", label: "New chat", group: "Actions", shortcut: shortcutFor("new-chat"), run: () => createSession() },
    { id: "settings", label: "Open Settings", group: "Actions", shortcut: shortcutFor("open-settings"), run: () => openSettings() },
    { id: "runs", label: "Open Run center", group: "Actions", shortcut: shortcutFor("open-runs"), run: () => setOverlay("runs") },
    { id: "library", label: "Open Library", group: "Actions", shortcut: shortcutFor("open-library"), run: () => setOverlay("library") },
    { id: "focus", label: "Focus the message box", group: "Actions", shortcut: shortcutFor("focus-composer"), run: () => window.dispatchEvent(new Event("moss:focus-composer")) },
    { id: "stop", label: "Stop the current response", group: "Actions", shortcut: "Esc", run: () => window.dispatchEvent(new Event("moss:stop-turn")) },
    {
      id: "sidebar",
      label: settings.sidebarCollapsed ? "Expand the sidebar" : "Collapse the sidebar",
      group: "Actions",
      shortcut: shortcutFor("toggle-sidebar"),
      run: () => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }),
    },
    {
      id: "theme",
      label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
      group: "Actions",
      run: () => updateSettings({ theme: theme === "dark" ? "light" : "dark" }),
    },
    { id: "diagnostics", label: "Open diagnostics settings", group: "Actions", run: () => openSettings("diagnostics") },
    ...sortSessionsForDisplay(sessions).map((session): PaletteCommand => ({
      id: `session-${session.id}`,
      label: session.title,
      group: "Conversations",
      run: () => selectSession(session.id),
    })),
  ];

  return (
    <div className="flex h-screen bg-transparent text-neutral-900 dark:text-neutral-100">
      <Sidebar
        busy={busy}
        open={chatsOpen}
        onClose={() => setChatsOpen(false)}
        onOpenSettings={() => openSettings()}
        onOpenLibrary={() => setOverlay("library")}
        onOpenRuns={() => setOverlay("runs")}
      />
      <ChatPanel
        busy={busy}
        setBusy={setBusy}
        onOpenChats={() => setChatsOpen(true)}
        onOpenSettings={openSettings}
      />
      <Suspense fallback={<div className="sr-only" role="status">Loading panel…</div>}>
        {overlay === "settings" ? <SettingsPanel initialCategory={settingsCategory} onClose={() => setOverlay("none")} /> : null}
        {overlay === "library" ? <LibraryPanel onClose={() => setOverlay("none")} /> : null}
        {overlay === "runs" ? <RunCenter onClose={() => setOverlay("none")} /> : null}
      </Suspense>
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
