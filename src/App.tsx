// src/App.tsx

import { lazy, Suspense, useEffect, useState } from "react";

import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { initializeProviderCredential, settingsStore } from "./lib/settings";

const LibraryPanel = lazy(() =>
  import("./components/LibraryPanel").then(({ LibraryPanel }) => ({ default: LibraryPanel })),
);
const SettingsPanel = lazy(() =>
  import("./components/SettingsPanel").then(({ SettingsPanel }) => ({ default: SettingsPanel })),
);
const RunCenter = lazy(() =>
  import("./components/RunCenter").then(({ RunCenter }) => ({ default: RunCenter })),
);

type Overlay = "none" | "settings" | "library" | "runs";

export default function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [chatsOpen, setChatsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const theme = settingsStore.use().theme;

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

  return (
    <div className="flex h-screen bg-transparent text-neutral-900 dark:text-neutral-100">
      <Sidebar
        busy={busy}
        open={chatsOpen}
        onClose={() => setChatsOpen(false)}
        onOpenSettings={() => setOverlay("settings")}
        onOpenLibrary={() => setOverlay("library")}
        onOpenRuns={() => setOverlay("runs")}
      />
      <ChatPanel
        busy={busy}
        setBusy={setBusy}
        onOpenChats={() => setChatsOpen(true)}
        onOpenSettings={() => setOverlay("settings")}
      />
      <Suspense fallback={<div className="sr-only" role="status">Loading panel…</div>}>
        {overlay === "settings" ? <SettingsPanel onClose={() => setOverlay("none")} /> : null}
        {overlay === "library" ? <LibraryPanel onClose={() => setOverlay("none")} /> : null}
        {overlay === "runs" ? <RunCenter onClose={() => setOverlay("none")} /> : null}
      </Suspense>
    </div>
  );
}
