// Model chooser: a searchable dropdown over the loaded model list.
//
// Focusing opens the full list; typing filters it, which keeps long catalogs such
// as OpenRouter's 400+ models usable. Enter uses the typed text unless a suggestion
// was picked with the arrow keys, so IDs the list omits work too (OpenRouter variants like ":free"
// or ":nitro", or "openrouter/auto"). Built by hand because Chromium's datalist
// only shows entries that match the text already in the field.

import { useId, useRef, useState } from "react";

export function ModelPicker({
  models,
  value,
  onChange,
  className,
  wrapperClassName = "min-w-0 flex-1",
  ariaLabel = "Model",
}: {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  className?: string;
  wrapperClassName?: string;
  ariaLabel?: string;
}): React.ReactElement {
  const listId = useId();
  // null while not editing: the field shows the chosen model.
  const [query, setQuery] = useState<string | null>(null);
  // -1 until the arrow keys pick a suggestion, so Enter uses the typed ID as is:
  // typing "openai/gpt-5" must not select the listed "openai/gpt-5:nitro".
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const open = query !== null && models.length > 0;
  const needle = (query ?? "").trim().toLowerCase();
  const matches = needle ? models.filter((m) => m.toLowerCase().includes(needle)) : models;

  function commit(model: string): void {
    const id = model.trim();
    if (id) onChange(id);
    setQuery(null);
  }

  function move(delta: number): void {
    if (matches.length === 0) return;
    const next = active < 0 ? (delta > 0 ? 0 : matches.length - 1) : (active + delta + matches.length) % matches.length;
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView?.({ block: "nearest" });
  }

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        className={className}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        placeholder={models.length > 0 ? `Search ${models.length} models or type an ID` : "Model"}
        spellCheck={false}
        autoComplete="off"
        title={value || undefined}
        value={query ?? value}
        onFocus={() => {
          setQuery("");
          setActive(-1);
        }}
        onBlur={() => {
          // Without a list there is nothing to pick from, so typed text is the model.
          if (models.length === 0 && query) commit(query);
          else setQuery(null);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const typed = (query ?? "").trim();
            const exact = models.find((m) => m.toLowerCase() === typed.toLowerCase());
            commit(matches[active] ?? exact ?? typed);
            e.currentTarget.blur();
          } else if (e.key === "Escape" && query !== null) {
            e.stopPropagation();
            setQuery(null);
            e.currentTarget.blur();
          }
        }}
      />
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${ariaLabel} options`}
          className="absolute left-0 z-50 mt-1 max-h-72 w-full min-w-[18rem] overflow-auto rounded border border-neutral-300 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1 text-neutral-600 dark:text-neutral-400">No listed model matches. Press Enter to use “{query?.trim()}”.</li>
          ) : (
            matches.map((m, i) => (
              <li
                key={m}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={m === value}
                className={`cursor-pointer truncate px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${i === active ? "bg-neutral-200 dark:bg-neutral-700" : ""} ${m === value ? "font-semibold" : ""}`}
                title={m}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(m);
                  (document.activeElement as HTMLElement | null)?.blur();
                }}
                // Inside a <label>, a click would focus the input again and reopen the list.
                onClick={(e) => e.preventDefault()}
              >
                {m}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
