// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessibilitySettings } from "./AccessibilitySettings";

const updateSettings = vi.fn();
const settings = vi.hoisted(() => ({ value: { onboardingDismissed: true } as Record<string, unknown> }));

vi.mock("../lib/settings", () => ({
  useSettings: () => settings.value,
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

afterEach(() => {
  cleanup();
  updateSettings.mockReset();
});

describe("AccessibilitySettings", () => {
  it("updates text size, contrast, notifications, and the guide", () => {
    render(<AccessibilitySettings className="" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "larger" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /High-contrast/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Notify me/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show the getting-started guide again" }));
    expect(updateSettings).toHaveBeenCalledWith({ fontScale: "larger" });
    expect(updateSettings).toHaveBeenCalledWith({ highContrast: true });
    expect(updateSettings).toHaveBeenCalledWith({ desktopNotifications: false });
    expect(updateSettings).toHaveBeenCalledWith({ onboardingDismissed: false });
    expect(screen.getByLabelText("Keyboard shortcuts").textContent).toContain("Ctrl+K");
  });
});
