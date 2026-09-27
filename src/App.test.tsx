// @vitest-environment jsdom
//
// src/App.test.tsx
//
// App is the root coordinator: a single `overlay` state machine (none/settings/
// library/runs), the command palette, global shortcuts, display preferences,
// and the `busy` flag threaded to the sidebar and owned via ChatPanel's
// setBusy. The child panels are mocked so only that wiring is under test.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { settingsStore } from "./lib/settings";

vi.mock("./components/Sidebar", () => ({
  Sidebar: ({
    busy,
    onOpenSettings,
    onOpenLibrary,
    onOpenRuns,
    open,
    onClose,
  }: {
    busy: boolean;
    onOpenSettings: () => void;
    onOpenLibrary: () => void;
    onOpenRuns: () => void;
    open: boolean;
    onClose: () => void;
  }) => (
    <div>
      <span>sidebar-busy:{String(busy)}</span>
      <span>sidebar-open:{String(open)}</span>
      <button onClick={onClose}>sb-close</button>
      <button onClick={onOpenSettings}>sb-open-settings</button>
      <button onClick={onOpenLibrary}>sb-open-library</button>
      <button onClick={onOpenRuns}>sb-open-runs</button>
    </div>
  ),
}));

vi.mock("./components/ChatPanel", () => ({
  ChatPanel: ({ busy, setBusy, onOpenChats }: { busy: boolean; setBusy: (b: boolean) => void; onOpenChats: () => void }) => (
    <div>
      <span>chat-busy:{String(busy)}</span>
      <button onClick={() => setBusy(true)}>cp-set-busy</button>
      <button onClick={onOpenChats}>cp-open-chats</button>
    </div>
  ),
}));

vi.mock("./components/SettingsPanel", () => ({
  SettingsPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>settings-overlay</span>
      <button onClick={onClose}>sp-close</button>
    </div>
  ),
}));

vi.mock("./components/LibraryPanel", () => ({
  LibraryPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>library-overlay</span>
      <button onClick={onClose}>lp-close</button>
    </div>
  ),
}));

vi.mock("./components/RunCenter", () => ({
  RunCenter: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>run-center-overlay</span>
      <button onClick={onClose}>rc-close</button>
    </div>
  ),
}));

afterEach(cleanup);

describe("App", () => {
  it("renders no overlay initially", () => {
    render(<App />);
    expect(screen.queryByText("settings-overlay")).toBeNull();
    expect(screen.queryByText("library-overlay")).toBeNull();
  });

  it("opens and closes the settings overlay", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-settings"));
    expect(await screen.findByText("settings-overlay")).toBeDefined();
    fireEvent.click(screen.getByText("sp-close"));
    expect(screen.queryByText("settings-overlay")).toBeNull();
  });

  it("opens the library overlay", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-library"));
    expect(await screen.findByText("library-overlay")).toBeDefined();
  });

  it("opens and closes the run center", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-runs"));
    expect(await screen.findByText("run-center-overlay")).toBeDefined();
    fireEvent.click(screen.getByText("rc-close"));
    expect(screen.queryByText("run-center-overlay")).toBeNull();
  });

  it("shows only one overlay at a time", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("sb-open-settings"));
    expect(await screen.findByText("settings-overlay")).toBeDefined();
    fireEvent.click(screen.getByText("sb-open-library"));
    expect(screen.queryByText("settings-overlay")).toBeNull();
    expect(await screen.findByText("library-overlay")).toBeDefined();
  });

  it("threads the busy flag from ChatPanel to the sidebar", () => {
    render(<App />);
    expect(screen.getByText("sidebar-busy:false")).toBeDefined();
    fireEvent.click(screen.getByText("cp-set-busy"));
    expect(screen.getByText("sidebar-busy:true")).toBeDefined();
  });

  it("opens and closes the compact conversation navigator", () => {
    render(<App />);
    expect(screen.getByText("sidebar-open:false")).toBeDefined();
    fireEvent.click(screen.getByText("cp-open-chats"));
    expect(screen.getByText("sidebar-open:true")).toBeDefined();
    fireEvent.click(screen.getByText("sb-close"));
    expect(screen.getByText("sidebar-open:false")).toBeDefined();
  });

  it("routes global shortcuts to the palette and overlays", async () => {
    render(<App />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeDefined();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();

    fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    expect(await screen.findByText("run-center-overlay")).toBeDefined();
    fireEvent.click(screen.getByText("rc-close"));
    fireEvent.keyDown(document, { key: ",", ctrlKey: true });
    expect(await screen.findByText("settings-overlay")).toBeDefined();
  });

  it("applies text size and high-contrast preferences", () => {
    settingsStore.update((s) => ({ ...s, fontScale: "larger", highContrast: true }));
    render(<App />);
    expect(document.documentElement.style.fontSize).toBe("125%");
    expect(document.documentElement.classList.contains("high-contrast")).toBe(true);
    settingsStore.update((s) => ({ ...s, fontScale: "default", highContrast: false }));
  });
});

describe("App theme", () => {
  afterEach(() => {
    settingsStore.update((s) => ({ ...s, theme: "dark" }));
    document.documentElement.classList.remove("dark");
  });

  function stubPrefersDark(matches: boolean): void {
    window.matchMedia = ((): MediaQueryList =>
      ({
        matches,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  it("adds the dark class for theme dark", () => {
    settingsStore.update((s) => ({ ...s, theme: "dark" }));
    render(<App />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes the dark class for theme light", () => {
    settingsStore.update((s) => ({ ...s, theme: "light" }));
    render(<App />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows system dark for theme auto", () => {
    stubPrefersDark(true);
    settingsStore.update((s) => ({ ...s, theme: "auto" }));
    render(<App />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("follows system light for theme auto", () => {
    stubPrefersDark(false);
    settingsStore.update((s) => ({ ...s, theme: "auto" }));
    render(<App />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
