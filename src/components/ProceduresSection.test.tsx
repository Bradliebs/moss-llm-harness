// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Procedure } from "@common/types";

import { ProceduresSection } from "./ProceduresSection";

const PROCEDURE: Procedure = {
  id: "p-1", name: "read_file → run_command", description: "Learned from verified turns such as \"fix a\".", status: "candidate", learnedFrom: 3,
  successCount: 1, failureCount: 0, consecutiveFailures: 0, createdAt: "x", updatedAt: "x",
  steps: [{ tool: "read_file", args: { path: { slot: "path" } } }, { tool: "run_command", args: { command: { const: "npm test" } } }],
  slots: [{ name: "path", example: "a.ts" }],
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "moss");
});

describe("ProceduresSection", () => {
  it("lists procedures with their steps and record, and changes their trust", async () => {
    const setStatus = vi.fn(async () => [{ ...PROCEDURE, status: "trusted" as const }]);
    const remove = vi.fn(async () => []);
    Object.assign(window, { moss: { procedures: { list: async () => [PROCEDURE], setStatus, remove } } });
    render(<ProceduresSection />);
    expect(await screen.findByText("read_file → run_command")).toBeDefined();
    expect(screen.getByText("1 verified use · 0 failed · learned from 3 turns")).toBeDefined();
    expect(screen.getByText("read_file(path=<path>)")).toBeDefined();
    expect(screen.getByText("run_command(command=\"npm test\")")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith("p-1", "trusted"));
    expect(await screen.findByText("trusted")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText(/None yet/)).toBeDefined());
  });
});
