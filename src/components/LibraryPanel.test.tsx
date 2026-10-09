// @vitest-environment jsdom
//
// src/components/LibraryPanel.test.tsx
//
// LibraryPanel hosts two independent CRUD sections (Skills + Memory) backed by
// the window.moss memory.* and skills.* IPC channels. Each is stubbed; the tests
// cover the mount refresh, the add/create validation, and the delete/toggle/clear
// actions plus their follow-up refresh.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryEntry, Skill } from "@common/types";

import { LibraryPanel } from "./LibraryPanel";

const memory = {
  list: vi.fn(),
  add: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
};
const skills = {
  list: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  toggle: vi.fn(),
  update: vi.fn(),
  rename: vi.fn(),
  importFolder: vi.fn(),
};

function memoryEntry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: "m1", fact: "drink water", category: "fact", source: "user", createdAt: "now", ...over };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: "s1",
    name: "Linter",
    description: "Runs the linter",
    instructions: "",
    enabled: false,
    createdAt: "now",
    ...over,
  };
}

beforeEach(() => {
  memory.list.mockResolvedValue([]);
  memory.add.mockResolvedValue(memoryEntry());
  memory.delete.mockResolvedValue(true);
  memory.clear.mockResolvedValue(undefined);
  skills.list.mockResolvedValue([]);
  skills.create.mockResolvedValue(skill());
  skills.delete.mockResolvedValue(true);
  skills.toggle.mockResolvedValue(undefined);
  skills.update.mockResolvedValue(skill());
  skills.rename.mockResolvedValue(skill());
  skills.importFolder.mockResolvedValue(null);
  Object.assign(window, { moss: { memory, skills } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { moss?: unknown }).moss;
});

describe("LibraryPanel — Memory", () => {
  it("shows the empty state after the mount refresh", async () => {
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No memories yet.")).toBeDefined());
    expect(memory.list).toHaveBeenCalled();
  });

  it("adds a memory with the selected category and refreshes", async () => {
    memory.list.mockResolvedValueOnce([]).mockResolvedValue([memoryEntry({ fact: "drink water" })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No memories yet.")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText("Remember a fact…"), { target: { value: "drink water" } });
    fireEvent.click(screen.getByText("Add"));

    expect(memory.add).toHaveBeenCalledWith("drink water", "fact");
    await waitFor(() => expect(screen.getByText("drink water")).toBeDefined());
  });

  it("does not add a blank memory", async () => {
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No memories yet.")).toBeDefined());
    fireEvent.click(screen.getByText("Add"));
    expect(memory.add).not.toHaveBeenCalled();
  });

  it("deletes a memory entry", async () => {
    memory.list.mockResolvedValue([memoryEntry({ id: "m9", fact: "delete me" })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("delete me")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
    expect(memory.delete).toHaveBeenCalledWith("m9");
  });

  it("clears all memories", async () => {
    memory.list.mockResolvedValue([memoryEntry()]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Clear all")).toBeDefined());

    fireEvent.click(screen.getByText("Clear all"));
    expect(memory.clear).toHaveBeenCalled();
  });
});

describe("LibraryPanel — Skills", () => {
  it("shows the empty state after the mount refresh", async () => {
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No skills yet.")).toBeDefined());
    expect(skills.list).toHaveBeenCalled();
  });

  it("requires a name and description before creating", async () => {
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No skills yet.")).toBeDefined());

    fireEvent.click(screen.getByText("Add skill"));
    expect(screen.getByText("Name and description are required.")).toBeDefined();
    expect(skills.create).not.toHaveBeenCalled();
  });

  it("creates a skill and refreshes", async () => {
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No skills yet.")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText("Skill name"), { target: { value: "Linter" } });
    fireEvent.change(screen.getByPlaceholderText("Short description (shown to the model)"), {
      target: { value: "Runs the linter" },
    });
    fireEvent.click(screen.getByText("Add skill"));

    await waitFor(() =>
      expect(skills.create).toHaveBeenCalledWith({
        name: "Linter",
        description: "Runs the linter",
        instructions: "",
      }),
    );
  });

  it("toggles a skill's enabled state", async () => {
    skills.list.mockResolvedValue([skill({ id: "s5", enabled: false })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Linter")).toBeDefined());

    fireEvent.click(screen.getByRole("checkbox"));
    expect(skills.toggle).toHaveBeenCalledWith("s5", true);
  });

  it("deletes a skill", async () => {
    skills.list.mockResolvedValue([skill({ id: "s7", name: "Remove me" })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Remove me")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
    expect(skills.delete).toHaveBeenCalledWith("s7");
  });

  it("edits a skill's description and instructions", async () => {
    skills.list.mockResolvedValue([skill({ id: "s8", name: "Editable", description: "old", instructions: "body" })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Editable")).toBeDefined());

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Edit description"), { target: { value: "new desc" } });
    fireEvent.change(screen.getByLabelText("Edit instructions"), { target: { value: "new body" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(skills.update).toHaveBeenCalledWith({ id: "s8", description: "new desc", instructions: "new body" }),
    );
  });

  it("renames a skill on Enter in the inline editor", async () => {
    skills.list.mockResolvedValue([skill({ id: "s9", name: "Old Name" })]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Old Name")).toBeDefined());

    fireEvent.click(screen.getByText("Rename"));
    const editor = screen.getByLabelText("Rename skill") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "New Name" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(skills.rename).toHaveBeenCalledWith({ id: "s9", newName: "New Name" }));
  });

  it("imports a skill folder and reports review status", async () => {
    skills.importFolder.mockResolvedValue({ imported: ["one", "two"], skipped: ["existing"], invalid: [] });
    skills.list.mockResolvedValueOnce([]).mockResolvedValue([
      skill({ id: "one", name: "One", createdBy: "import" }),
      skill({ id: "two", name: "Two", createdBy: "import" }),
    ]);
    render(<LibraryPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No skills yet.")).toBeDefined());

    fireEvent.click(screen.getByText("Import folder"));

    await waitFor(() => expect(skills.importFolder).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Imported 2; skipped 1; invalid 0/)).toBeDefined();
    expect(screen.getByText(/disabled until reviewed/)).toBeDefined();
    expect(screen.getAllByText("imported")).toHaveLength(2);
  });
});

describe("LibraryPanel", () => {
  it("closes via the Close button", async () => {
    const onClose = vi.fn();
    render(<LibraryPanel onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("No memories yet.")).toBeDefined());
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
