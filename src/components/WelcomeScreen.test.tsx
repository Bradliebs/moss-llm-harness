// @vitest-environment jsdom
//
// src/components/WelcomeScreen.test.tsx
//
// WelcomeScreen is presentational: it renders four starter prompts and reports
// the picked one through onPick. These tests lock that prop contract.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WelcomeScreen } from "./WelcomeScreen";

afterEach(cleanup);

describe("WelcomeScreen", () => {
  it("renders the four starter suggestions", () => {
    render(<WelcomeScreen onPick={() => {}} />);
    expect(screen.getByRole("img", { name: "Moss portrait" })).toBeDefined();
    expect(screen.getByText("Summarize the files in my workspace.")).toBeDefined();
    expect(screen.getByText("Explain what this project does.")).toBeDefined();
    expect(screen.getByText("Find and fix a bug in the current folder.")).toBeDefined();
    expect(screen.getByText("Write a unit test for a function I point you to.")).toBeDefined();
  });

  it("reports the picked suggestion through onPick", () => {
    const onPick = vi.fn();
    render(<WelcomeScreen onPick={onPick} />);
    fireEvent.click(screen.getByText("Explain what this project does."));
    expect(onPick).toHaveBeenCalledWith("Explain what this project does.");
  });

  it("shows a setup call-to-action instead of suggestions when no model is configured", () => {
    const onOpenSettings = vi.fn();
    render(<WelcomeScreen onPick={() => {}} needsSetup onOpenSettings={onOpenSettings} />);
    expect(screen.queryByText("Explain what this project does.")).toBeNull();
    fireEvent.click(screen.getByText("Open Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("summarizes capability readiness and opens its detailed settings route", () => {
    const onOpenSettings = vi.fn();
    render(
      <WelcomeScreen
        onPick={() => {}}
        onOpenSettings={onOpenSettings}
        readiness={[
          { id: "provider", label: "Provider and model", detail: "Connected", status: "ready" },
          { id: "pricing", label: "Model pricing", detail: "Rate unknown", status: "attention" },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Capability readiness" }).textContent).toContain("1 to review");
    fireEvent.click(screen.getByRole("button", { name: "Review readiness" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
