// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolPreview } from "./ToolPreview";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "moss");
});

describe("ToolPreview", () => {
  it("diffs a pending write against the current workspace file", async () => {
    const preview = vi.fn(async () => ({ exists: true, content: "one\ntwo\n", byteLength: 8 }));
    Object.assign(window, { moss: { workspace: { preview } } });
    render(<ToolPreview name="write_file" args={JSON.stringify({ path: "a.txt", content: "one\nTWO\n" })} risk="mutating" workspaceRoot={"C:\\ws"} />);
    await waitFor(() => expect(screen.getByText(/^Overwrite/)).toBeDefined());
    expect(preview).toHaveBeenCalledWith("C:\\ws", "a.txt");
    expect(screen.getByLabelText("Changes to a.txt").textContent).toContain("TWO");
    expect(screen.getByText("Can change files or state inside the workspace.")).toBeDefined();
  });

  it("labels new files and shows command context", async () => {
    Object.assign(window, { moss: { workspace: { preview: vi.fn(async () => ({ exists: false })) } } });
    const { rerender } = render(<ToolPreview name="write_file" args={JSON.stringify({ path: "new.txt", content: "hi" })} workspaceRoot={"C:\\ws"} />);
    await waitFor(() => expect(screen.getByText(/^Create/)).toBeDefined());
    rerender(<ToolPreview name="run_command" args={JSON.stringify({ command: "npm test" })} risk="destructive" workspaceRoot={"C:\\ws"} />);
    expect(screen.getByText("npm test")).toBeDefined();
    expect(screen.getByText("C:\\ws")).toBeDefined();
    expect(screen.getByText(/Review carefully/)).toBeDefined();
  });

  it("shows edit diffs and generic arguments", () => {
    const { rerender } = render(<ToolPreview name="edit_file" args={JSON.stringify({ path: "a.ts", oldText: "a", newText: "b" })} />);
    expect(screen.getByLabelText("Edit to a.ts").textContent).toContain("b");
    rerender(<ToolPreview name="custom" args='{"x":1}' />);
    expect(screen.getByText(/"x": 1/)).toBeDefined();
  });
});
