// src/lib/shortcuts.ts
//
// Global keyboard shortcuts. Bindings avoid Electron's default menu
// accelerators (Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I, zoom) so they never reload
// the renderer or interrupt pending approvals.

export type ShortcutCommand =
  | "palette"
  | "new-chat"
  | "open-settings"
  | "open-runs"
  | "open-library"
  | "focus-composer"
  | "toggle-sidebar";

export interface ShortcutBinding {
  command: ShortcutCommand;
  keys: string;
  label: string;
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  { command: "palette", keys: "Ctrl+K", label: "Open command palette" },
  { command: "new-chat", keys: "Ctrl+N", label: "New chat" },
  { command: "open-settings", keys: "Ctrl+,", label: "Open Settings" },
  { command: "open-runs", keys: "Ctrl+J", label: "Open Run center" },
  { command: "open-library", keys: "Ctrl+Shift+L", label: "Open Library" },
  { command: "focus-composer", keys: "Ctrl+L", label: "Focus the message box" },
  { command: "toggle-sidebar", keys: "Ctrl+B", label: "Collapse or expand the sidebar" },
];

export function shortcutFor(command: ShortcutCommand): string | undefined {
  return SHORTCUTS.find((binding) => binding.command === command)?.keys;
}

export function matchShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): ShortcutCommand | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "l" ? "open-library" : null;
  if (key === "k") return "palette";
  if (key === "n") return "new-chat";
  if (key === ",") return "open-settings";
  if (key === "j") return "open-runs";
  if (key === "l") return "focus-composer";
  if (key === "b") return "toggle-sidebar";
  return null;
}
