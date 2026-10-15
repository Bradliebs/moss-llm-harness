// src/lib/persistentStore.ts
//
// A minimal localStorage-backed store with React subscription support. One JSON
// value per key, parsed defensively (a corrupt/absent value falls back to the
// default). Shared by the settings, sessions, and models stores so the chat
// surface and the settings/sidebar overlays stay in sync without prop drilling.

import { useSyncExternalStore } from "react";

export interface PersistentStore<T> {
  get(): T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  use(): T;
}

/** Told after every save whether it worked, so the app can warn while saves
 *  fail (instead of losing changes silently on the next restart) and clear the
 *  warning once they work again. */
let persistResult: ((key: string, ok: boolean) => void) | undefined;
export function onPersistResult(handler: ((key: string, ok: boolean) => void) | undefined): void {
  persistResult = handler;
}

export function createPersistentStore<T>(key: string, fallback: T, toPersist: (value: T) => T = (value) => value): PersistentStore<T> {
  let value = load();
  const listeners = new Set<() => void>();

  function load(): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  function persist(): void {
    try {
      localStorage.setItem(key, JSON.stringify(toPersist(value)));
    } catch {
      // Storage full or unavailable: keep the in-memory value and report it.
      persistResult?.(key, false);
      return;
    }
    persistResult?.(key, true);
  }

  function set(next: T): void {
    value = next;
    persist();
    listeners.forEach((l) => l());
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
