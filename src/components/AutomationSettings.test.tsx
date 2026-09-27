// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutomationSettings } from "./AutomationSettings";

const updateSettings = vi.fn();
const settings = {
  enableTools: true,
  browserEnabled: false,
  browserAllowedDomains: "",
  browserHeadless: true,
  desktopEnabled: false,
  desktopAllowedProcesses: "",
  desktopAllowedWindows: "",
};

vi.mock("../lib/settings", () => ({
  useSettings: () => settings,
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

afterEach(() => {
  cleanup();
  updateSettings.mockReset();
});

describe("AutomationSettings", () => {
  it("updates browser and desktop scopes without enabling approval bypasses", () => {
    render(<AutomationSettings className="" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable isolated browser sessions" }));
    fireEvent.change(screen.getByLabelText("Allowed process names"), { target: { value: "notepad.exe" } });
    expect(updateSettings).toHaveBeenCalledWith({ browserEnabled: true });
    expect(updateSettings).toHaveBeenCalledWith({ desktopAllowedProcesses: "notepad.exe" });
    expect(updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ autoApproveTools: true }));
  });
});
