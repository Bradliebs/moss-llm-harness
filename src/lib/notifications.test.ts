// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldNotify, showDesktopNotification } from "./notifications";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldNotify", () => {
  const visible = { enabled: true, documentHidden: false, windowFocused: true, viewingOwner: true };

  it("stays quiet when the user is already looking at the run", () => {
    expect(shouldNotify(visible)).toBe(false);
    expect(shouldNotify({ ...visible, enabled: false, documentHidden: true })).toBe(false);
  });

  it("notifies for hidden, unfocused, or background conversations", () => {
    expect(shouldNotify({ ...visible, documentHidden: true })).toBe(true);
    expect(shouldNotify({ ...visible, windowFocused: false })).toBe(true);
    expect(shouldNotify({ ...visible, viewingOwner: false })).toBe(true);
  });
});

describe("showDesktopNotification", () => {
  it("creates a clickable notification", () => {
    const instances: Array<{ title: string; onclick: (() => void) | null }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(public title: string) {
        instances.push(this);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const onClick = vi.fn();
    expect(showDesktopNotification("Approval needed", "write_file", onClick)).toBe(true);
    instances[0].onclick?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does nothing when notifications are denied or unsupported", () => {
    vi.stubGlobal("Notification", class { static permission = "denied"; });
    expect(showDesktopNotification("t", "b")).toBe(false);
    vi.stubGlobal("Notification", undefined);
    expect(showDesktopNotification("t", "b")).toBe(false);
  });
});
