// src/components/CommandPalette.tsx
//
// Keyboard-first command palette (Ctrl+K). Lists application commands and
// conversations, filters as you type, and runs the highlighted entry on Enter.

import { useEffect, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  group: "Actions" | "Conversations";
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose: () => void }): React.ReactElement {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filter = query.trim().toLowerCase();
  const matches = commands.filter((command) => !filter || command.label.toLowerCase().includes(filter)).slice(0, 50);

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function run(command: PaletteCommand | undefined): void {
    if (!command) return;
    onClose();
    command.run();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" role="presentation" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full border-b border-neutral-200 bg-transparent px-4 py-3 text-sm text-neutral-900 outline-none placeholder:text-neutral-500 dark:border-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-400"
          placeholder="Type a command or conversation name"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={matches[active] ? `command-${matches[active].id}` : undefined}
          aria-label="Search commands"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => (matches.length ? (index + 1) % matches.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (matches.length ? (index - 1 + matches.length) % matches.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(matches[active]);
            }
          }}
        />
        <ul id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-1">
          {matches.length === 0 ? <li className="px-3 py-4 text-sm text-neutral-600 dark:text-neutral-300">No matching commands.</li> : null}
          {matches.map((command, index) => (
            <li
              key={command.id}
              id={`command-${command.id}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm ${
                index === active ? "bg-emerald-100 text-neutral-900 dark:bg-emerald-900/50 dark:text-white" : "text-neutral-800 dark:text-neutral-200"
              }`}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(command)}
            >
              <span className="w-24 shrink-0 text-[11px] text-neutral-600 dark:text-neutral-300">{command.group}</span>
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {command.shortcut ? <kbd className="rounded border border-neutral-300 px-1.5 text-[11px] text-neutral-700 dark:border-neutral-600 dark:text-neutral-200">{command.shortcut}</kbd> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
