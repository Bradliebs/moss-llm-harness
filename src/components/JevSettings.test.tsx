// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JevSettings } from "./JevSettings";
import { updateSettings } from "../lib/settings";

vi.mock("../lib/settings", () => ({
  useSettings: () => ({ jevEnabled: false }),
  updateSettings: vi.fn(),
}));

beforeEach(() => {
  Object.assign(window, { moss: { provider: {
    getCredential: vi.fn().mockResolvedValue(""),
    setCredential: vi.fn().mockResolvedValue(undefined),
  } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Jev settings", () => {
  it("defaults off and saves only through encrypted credential IPC without enabling Jev", async () => {
    render(<JevSettings />);
    const toggle = screen.getByRole("checkbox", { name: "Use Jev" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const input = screen.getByLabelText("TypeSafe API key") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(toggle.disabled).toBe(true);
    fireEvent.change(input, { target: { value: " test-secret " } });
    fireEvent.click(screen.getByRole("button", { name: "Save TypeSafe API key" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(window.moss.provider.setCredential).toHaveBeenCalledWith("typesafe", "test-secret");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({ jevEnabled: true });
  });

  it("restores key presence without displaying the stored key, and removal disables Jev", async () => {
    vi.mocked(window.moss.provider.getCredential).mockResolvedValue("saved-secret");
    render(<JevSettings />);
    await screen.findByText("Key saved securely");
    expect((screen.getByLabelText("TypeSafe API key") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Remove TypeSafe API key" }));
    await screen.findByText("TypeSafe API key removed.");
    expect(window.moss.provider.setCredential).toHaveBeenCalledWith("typesafe", "");
    expect(updateSettings).toHaveBeenCalledWith({ jevEnabled: false });
  });

  it("shows storage failures without leaking error contents or enabling Jev", async () => {
    vi.mocked(window.moss.provider.setCredential).mockRejectedValue(new Error("test-secret"));
    render(<JevSettings />);
    const input = screen.getByLabelText("TypeSafe API key") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save TypeSafe API key" }));
    await screen.findByText("Could not save the TypeSafe API key. Check secure credential storage.");
    expect(screen.getByRole("status").textContent).not.toContain("test-secret");
    expect(updateSettings).not.toHaveBeenCalled();
  });
});