// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindSuggestedCommand, VerificationSuggestions } from "./VerificationSuggestions";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "moss");
});

describe("VerificationSuggestions", () => {
  it("offers only commands that are not already enabled", async () => {
    const suggestVerification = vi.fn(async () => [
      { command: "npm test", source: "package.json \"test\" script" },
      { command: "npm run lint", source: "package.json \"lint\" script" },
    ]);
    Object.assign(window, { moss: { workspace: { suggestVerification } } });
    const onAccept = vi.fn();
    render(<VerificationSuggestions workspaceRoot="C:\\ws" configuredCommands={["npm run lint"]} onAccept={onAccept} />);
    await waitFor(() => screen.getByRole("button", { name: "Use npm test for verification" }));
    expect(screen.queryByRole("button", { name: "Use npm run lint for verification" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use npm test for verification" }));
    expect(onAccept).toHaveBeenCalledWith("npm test");
  });

  it("renders nothing without a workspace", () => {
    const { container } = render(<VerificationSuggestions workspaceRoot={null} configuredCommands={[]} onAccept={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

describe("bindSuggestedCommand", () => {
  it("binds to the first mandatory criterion without a non-command method", () => {
    const criteria = [
      { id: "a", mandatory: true, verification: { kind: "file-exists", path: "x" } },
      { id: "b", mandatory: true },
    ];
    expect(bindSuggestedCommand(criteria, "npm test")[1]).toEqual({ id: "b", mandatory: true, verification: { kind: "commands", commands: ["npm test"] } });
    expect(bindSuggestedCommand([{ id: "c", mandatory: false }], "npm test")).toEqual([{ id: "c", mandatory: false }]);
  });
});
