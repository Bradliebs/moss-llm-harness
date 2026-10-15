// src/lib/persistentStore.test.ts
//
// Unit tests for the localStorage-backed store factory. Runs in node with a
// Map-backed localStorage stub; every store gets a unique key so tests do not
// share state. The store's defensive parsing and persist guards are the logic
// worth locking.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPersistentStore, onPersistResult } from "./persistentStore";

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
    clear: (): void => map.clear(),
  };
}

let ls: ReturnType<typeof makeLocalStorage>;

beforeEach(() => {
  ls = makeLocalStorage();
  vi.stubGlobal("localStorage", ls);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPersistentStore", () => {
  it("returns the fallback when nothing is stored", () => {
    const store = createPersistentStore("k.empty", { n: 0 });
    expect(store.get()).toEqual({ n: 0 });
  });

  it("loads a previously persisted value", () => {
    ls.setItem("k.seed", JSON.stringify({ n: 42 }));
    const store = createPersistentStore("k.seed", { n: 0 });
    expect(store.get()).toEqual({ n: 42 });
  });

  it("falls back when the stored value is corrupt JSON", () => {
    ls.setItem("k.bad", "{not json");
    const store = createPersistentStore("k.bad", { n: 7 });
    expect(store.get()).toEqual({ n: 7 });
  });

  it("set updates the value and persists it", () => {
    const store = createPersistentStore("k.set", 0);
    store.set(5);
    expect(store.get()).toBe(5);
    expect(JSON.parse(ls.getItem("k.set") as string)).toBe(5);
  });

  it("can redact fields from persistence without changing the in-memory value", () => {
    const store = createPersistentStore("k.redact", { apiKey: "", model: "" }, (value) => ({ ...value, apiKey: "" }));
    store.set({ apiKey: "provider-secret", model: "m" });
    expect(store.get().apiKey).toBe("provider-secret");
    expect(JSON.parse(ls.getItem("k.redact") as string)).toEqual({ apiKey: "", model: "m" });
  });

  it("update applies a function to the previous value", () => {
    const store = createPersistentStore("k.upd", 1);
    store.update((p) => p + 9);
    expect(store.get()).toBe(10);
  });

  it("keeps the in-memory value when persistence throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage full");
      },
    });
    const results: string[] = [];
    onPersistResult((key, ok) => results.push(`${key}:${ok}`));
    const store = createPersistentStore("k.throw", 0);
    expect(() => store.set(3)).not.toThrow();
    expect(store.get()).toBe(3);
    // The failure is reported, so the app can warn instead of losing changes silently.
    expect(results).toEqual(["k.throw:false"]);
    onPersistResult(undefined);
  });
});
