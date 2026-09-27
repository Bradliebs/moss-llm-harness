// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, type PaletteCommand } from "./CommandPalette";

afterEach(cleanup);

function commands(): PaletteCommand[] {
  return [
    { id: "new", label: "New chat", group: "Actions", shortcut: "Ctrl+N", run: vi.fn() },
    { id: "settings", label: "Open Settings", group: "Actions", run: vi.fn() },
    { id: "chat-1", label: "Quarterly report", group: "Conversations", run: vi.fn() },
  ];
}

describe("CommandPalette", () => {
  it("filters commands and runs the highlighted one with the keyboard", () => {
    const list = commands();
    const onClose = vi.fn();
    render(<CommandPalette commands={list} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "open" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(list[1].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves the selection with arrow keys and closes on Escape", () => {
    const list = commands();
    const onClose = vi.fn();
    render(<CommandPalette commands={list} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.click(screen.getByText("Quarterly report"));
    expect(list[2].run).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
