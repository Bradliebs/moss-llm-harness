import { describe, expect, it } from "vitest";

import { matchShortcut, shortcutFor, SHORTCUTS } from "./shortcuts";

const press = (key: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("matchShortcut", () => {
  it("maps every documented binding", () => {
    expect(matchShortcut(press("k", { ctrlKey: true }))).toBe("palette");
    expect(matchShortcut(press("N", { ctrlKey: true }))).toBe("new-chat");
    expect(matchShortcut(press(",", { ctrlKey: true }))).toBe("open-settings");
    expect(matchShortcut(press("j", { metaKey: true }))).toBe("open-runs");
    expect(matchShortcut(press("L", { ctrlKey: true, shiftKey: true }))).toBe("open-library");
    expect(matchShortcut(press("l", { ctrlKey: true }))).toBe("focus-composer");
    expect(matchShortcut(press("b", { ctrlKey: true }))).toBe("toggle-sidebar");
    expect(SHORTCUTS.every((binding) => shortcutFor(binding.command) === binding.keys)).toBe(true);
  });

  it("ignores unmodified keys and Electron reload accelerators", () => {
    expect(matchShortcut(press("k"))).toBeNull();
    expect(matchShortcut(press("r", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(press("R", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(press("k", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});
