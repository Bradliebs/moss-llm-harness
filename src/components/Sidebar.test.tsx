// @vitest-environment jsdom
//
// src/components/Sidebar.test.tsx
//
// The sessions store logic is covered by sessions.test.ts; here the store is
// mocked so the component is tested in isolation: it renders the conversation
// list and routes button clicks to the right store action, and locks
// interaction while a turn is busy.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sessions from "../lib/sessions";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/sessions", () => ({
  useSessions: vi.fn(),
  createSession: vi.fn(),
  selectSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteSessions: vi.fn(),
  setSessionPinned: vi.fn(),
  sortSessionsForDisplay: (list: unknown[]) => list,
  renameSession: vi.fn(),
  sessionToMarkdown: vi.fn(() => "# md"),
}));

vi.mock("../lib/settings", () => ({
  useSettings: () => ({ model: "gpt-4o", modelRates: {} }),
  updateSettings: vi.fn(),
}));

const noop = (): void => {};

beforeEach(() => {
  vi.mocked(sessions.useSessions).mockReturnValue({ sessions: [], currentId: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("shows an empty-state message when there are no conversations", () => {
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect(screen.getByRole("img", { name: "Moss portrait" })).toBeDefined();
    expect(screen.getByText("No conversations yet.")).toBeDefined();
  });

  it("renders each conversation title", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [
        { id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 },
        { id: "b", title: "Second chat", messages: [], createdAt: 0, updatedAt: 0 },
      ],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect(screen.getByText("First chat")).toBeDefined();
    expect(screen.getByText("Second chat")).toBeDefined();
  });

  it("creates a new conversation on the New chat button", () => {
    const onClose = vi.fn();
    render(<Sidebar busy={false} open onClose={onClose} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByText("+ New chat"));
    expect(sessions.createSession).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selects a conversation when its title is clicked", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    const onClose = vi.fn();
    render(<Sidebar busy={false} open onClose={onClose} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByText("First chat"));
    expect(sessions.selectSession).toHaveBeenCalledWith("a");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the compact conversation navigator", () => {
    const onClose = vi.fn();
    render(<Sidebar busy={false} open onClose={onClose} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getAllByLabelText("Close conversations")[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes a conversation when its delete button is clicked", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByTitle("Delete conversation"));
    expect(sessions.deleteSession).toHaveBeenCalledWith("a");
  });

  it("opens the settings and library overlays", () => {
    const onOpenSettings = vi.fn();
    const onOpenLibrary = vi.fn();
    render(<Sidebar busy={false} onOpenSettings={onOpenSettings} onOpenLibrary={onOpenLibrary} />);
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByText("Library"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("allows safe conversation browsing while a turn is busy", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={true} onOpenSettings={noop} onOpenLibrary={noop} />);
    expect((screen.getByText("+ New chat") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("First chat") as HTMLButtonElement).disabled).toBe(false);
  });

  it("filters the conversation list by the search query", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [
        { id: "a", title: "Alpha notes", messages: [], createdAt: 0, updatedAt: 0 },
        { id: "b", title: "Beta plan", messages: [], createdAt: 0, updatedAt: 0 },
      ],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "beta" } });
    expect(screen.queryByText("Alpha notes")).toBeNull();
    expect(screen.getByText("Beta plan")).toBeDefined();
  });

  it("pins conversations and deletes a confirmed bulk selection", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [
        { id: "a", title: "Alpha notes", messages: [], createdAt: 0, updatedAt: 0 },
        { id: "b", title: "Beta plan", messages: [], createdAt: 0, updatedAt: 0, pinned: true },
      ],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Pin conversation" })[0]);
    expect(sessions.setSessionPinned).toHaveBeenCalledWith("a", true);
    expect(screen.getByRole("button", { name: "Unpin conversation" })).toBeDefined();

    fireEvent.click(screen.getByText("Select conversations"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha notes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(sessions.deleteSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    expect(sessions.deleteSessions).toHaveBeenCalledWith(["a", "b"]);
  });

  it("renames a conversation on Enter in the inline editor", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByTitle("Rename conversation"));
    const editor = screen.getByLabelText("Rename conversation") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "Renamed" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(sessions.renameSession).toHaveBeenCalledWith("a", "Renamed");
  });

  it("exports a conversation as Markdown", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByTitle("Export conversation as Markdown"));
    expect(sessions.sessionToMarkdown).toHaveBeenCalledTimes(1);
  });

  it("copies a conversation as Markdown", () => {
    vi.mocked(sessions.useSessions).mockReturnValue({
      sessions: [{ id: "a", title: "First chat", messages: [], createdAt: 0, updatedAt: 0 }],
      currentId: "a",
    });
    render(<Sidebar busy={false} onOpenSettings={noop} onOpenLibrary={noop} />);
    fireEvent.click(screen.getByTitle("Copy conversation as Markdown"));
    expect(sessions.sessionToMarkdown).toHaveBeenCalledTimes(1);
  });
});
