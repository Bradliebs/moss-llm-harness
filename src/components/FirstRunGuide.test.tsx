// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstRunGuide } from "./FirstRunGuide";

afterEach(cleanup);

function props(overrides: Partial<Parameters<typeof FirstRunGuide>[0]> = {}) {
  return {
    providerReady: false,
    workspaceRoot: null,
    onOpenSettings: vi.fn(),
    onPickWorkspace: vi.fn(),
    onTry: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe("FirstRunGuide", () => {
  it("guides setup and disables the sample until a model is ready", () => {
    const value = props();
    render(<FirstRunGuide {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(value.onOpenSettings).toHaveBeenCalledOnce();
    expect(value.onPickWorkspace).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: /Try:/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs a read-only workspace sample and can be dismissed", () => {
    const value = props({ providerReady: true, workspaceRoot: "C:\\ws" });
    render(<FirstRunGuide {...value} />);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try: Summarize my workspace" }));
    expect(value.onTry).toHaveBeenCalledWith(expect.stringContaining("without changing anything"));
    fireEvent.click(screen.getByRole("button", { name: "Hide guide" }));
    expect(value.onDismiss).toHaveBeenCalledOnce();
  });
});
