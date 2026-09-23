// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnUndo } from "./TurnUndo";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "moss");
});

function mockCheckpoint(revert = vi.fn(async () => ({ reverted: 2, errors: [] as string[] }))) {
  Object.assign(window, {
    moss: {
      checkpoint: {
        list: vi.fn(async () => [{ path: "src/a.ts", existed: true }, { path: "new.md", existed: false }]),
        revert,
      },
    },
  });
  return revert;
}

describe("TurnUndo", () => {
  it("lists changed files and requires confirmation before reverting", async () => {
    const revert = mockCheckpoint();
    render(<TurnUndo turnId="turn-1" />);
    await waitFor(() => expect(screen.getByText("2 files changed")).toBeDefined());
    expect(screen.getByText("created (undo deletes it)")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Undo turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep changes" }));
    expect(revert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Undid changes to 2 files"));
    expect(revert).toHaveBeenCalledWith("turn-1");
  });

  it("reports partial failures", async () => {
    mockCheckpoint(vi.fn(async () => ({ reverted: 1, errors: ["new.md: locked"] })));
    render(<TurnUndo turnId="turn-1" />);
    await waitFor(() => screen.getByRole("button", { name: "Undo turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("new.md: locked"));
  });

  it("renders nothing when the turn changed no files", async () => {
    Object.assign(window, { moss: { checkpoint: { list: vi.fn(async () => []), revert: vi.fn() } } });
    const { container } = render(<TurnUndo turnId="turn-1" />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
