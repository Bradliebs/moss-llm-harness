// src/components/LibraryPanel.tsx
//
// Overlay for managing durable memory and skills. Opened from the chat header.

import { useCallback, useEffect, useState } from "react";
import { SkillTrustControls } from "./SkillTrustControls";

import type { MemoryCategory, MemoryEntry, Skill } from "@common/types";

const CATEGORIES: MemoryCategory[] = ["preference", "fact", "decision", "context"];

function MemorySection(): React.ReactElement {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [fact, setFact] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("fact");

  const refresh = useCallback(async () => {
    setEntries(await window.moss.memory.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(): Promise<void> {
    const text = fact.trim();
    if (!text) return;
    await window.moss.memory.add(text, category);
    setFact("");
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    await window.moss.memory.delete(id);
    await refresh();
  }

  async function clearAll(): Promise<void> {
    await window.moss.memory.clear();
    await refresh();
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Memory</h2>
        {entries.length > 0 ? (
          <button className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-red-400" onClick={() => void clearAll()}>
            Clear all
          </button>
        ) : null}
      </div>
      <div className="mb-2 flex gap-2">
        <input
          className="flex-1 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
          placeholder="Remember a fact…"
          value={fact}
          onChange={(e) => setFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <select
          className="rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as MemoryCategory)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button className="rounded bg-blue-700 px-3 py-1 text-sm hover:bg-blue-600" onClick={() => void add()}>
          Add
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">No memories yet.</p>
        ) : (
          entries.map((m) => (
            <div key={m.id} className="flex items-start gap-2 rounded bg-white dark:bg-neutral-900 px-2 py-1 text-sm">
              <span className="rounded bg-neutral-200 dark:bg-neutral-800 px-1 text-xs text-neutral-600 dark:text-neutral-400">{m.category}</span>
              <span className="flex-1 text-neutral-800 dark:text-neutral-200">{m.fact}</span>
              <button className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-red-400" onClick={() => void remove(m.id)}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SkillsSection(): React.ReactElement {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [importMessage, setImportMessage] = useState("");

  const refresh = useCallback(async () => {
    setSkills(await window.moss.skills.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(): Promise<void> {
    if (!name.trim() || !description.trim()) {
      setError("Name and description are required.");
      return;
    }
    try {
      await window.moss.skills.create({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      setName("");
      setDescription("");
      setInstructions("");
      setError("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(skill: Skill): Promise<void> {
    await window.moss.skills.toggle(skill.id, !skill.enabled);
    await refresh();
  }

  function beginEdit(skill: Skill): void {
    setEditingId(skill.id);
    setEditDescription(skill.description);
    setEditInstructions(skill.instructions);
  }

  function cancelEdit(): void {
    setEditingId(null);
  }

  async function saveEdit(id: string): Promise<void> {
    await window.moss.skills.update({
      id,
      description: editDescription.trim(),
      instructions: editInstructions.trim(),
    });
    setEditingId(null);
    await refresh();
  }

  function beginRename(skill: Skill): void {
    setRenamingId(skill.id);
    setRenameDraft(skill.name);
  }

  function cancelRename(): void {
    setRenamingId(null);
  }

  async function saveRename(id: string): Promise<void> {
    const newName = renameDraft.trim();
    if (newName) await window.moss.skills.rename({ id, newName });
    setRenamingId(null);
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    await window.moss.skills.delete(id);
    await refresh();
  }

  async function importFolder(): Promise<void> {
    try {
      const result = await window.moss.skills.importFolder();
      if (!result) return;
      setImportMessage(
        `Imported ${result.imported.length}; skipped ${result.skipped.length}; invalid ${result.invalid.length}. Imported skills are disabled until reviewed.`,
      );
      setError("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <h2 className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-200">Skills</h2>
      <div className="mb-2 space-y-2 rounded border border-neutral-200 dark:border-neutral-800 p-2">
        <input
          className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
          placeholder="Skill name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
          placeholder="Short description (shown to the model)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <textarea
          className="w-full resize-none rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
          rows={3}
          placeholder="Full instructions (loaded on demand)"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        {importMessage ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{importMessage}</p> : null}
        <div className="flex gap-2">
          <button className="rounded bg-blue-700 px-3 py-1 text-sm hover:bg-blue-600" onClick={() => void create()}>
            Add skill
          </button>
          <button
            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-300 dark:hover:bg-neutral-700"
            onClick={() => void importFolder()}
          >
            Import folder
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {skills.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">No skills yet.</p>
        ) : (
          skills.map((s) => (
            <div key={s.id} className="rounded bg-white dark:bg-neutral-900 px-2 py-1 text-sm">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                </label>
                {renamingId === s.id ? (
                  <input
                    className="min-w-0 flex-1 rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-0.5 text-sm font-medium text-neutral-900 dark:text-neutral-100"
                    aria-label="Rename skill"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void saveRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename(s.id);
                      else if (e.key === "Escape") cancelRename();
                    }}
                  />
                ) : (
                  <span className="flex-1 font-medium text-neutral-800 dark:text-neutral-200">{s.name}</span>
                )}
                {s.createdBy === "agent" ? (
                  <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                    agent
                  </span>
                ) : null}
                {s.createdBy === "import" ? (
                  <span className="rounded bg-cyan-900/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-300">
                    imported
                  </span>
                ) : null}
                <button
                  className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-blue-400"
                  title="Rename skill"
                  onClick={() => beginRename(s)}
                >
                  Rename
                </button>
                <button
                  className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-blue-400"
                  title="Edit skill"
                  onClick={() => beginEdit(s)}
                >
                  Edit
                </button>
                <button className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-red-400" onClick={() => void remove(s.id)}>
                  ✕
                </button>
              </div>
              {editingId === s.id ? (
                <div className="mt-1 space-y-1 pl-6">
                  <input
                    className="w-full rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
                    aria-label="Edit description"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                  />
                  <textarea
                    className="w-full resize-none rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-sm"
                    aria-label="Edit instructions"
                    rows={3}
                    value={editInstructions}
                    onChange={(e) => setEditInstructions(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      className="rounded bg-blue-700 px-2 py-0.5 text-xs hover:bg-blue-600"
                      onClick={() => void saveEdit(s.id)}
                    >
                      Save
                    </button>
                    <button className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="pl-6 text-xs text-neutral-600 dark:text-neutral-400">{s.description}</p>
              )}
              <SkillTrustControls skill={s} onChanged={() => void refresh()} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function LibraryPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Library</h1>
          <button className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-300 dark:hover:bg-neutral-700" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 gap-6">
          <SkillsSection />
          <MemorySection />
        </div>
      </div>
    </div>
  );
}
