import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProductDiagnosticsStore } from "./product-diagnostics";

describe("ProductDiagnosticsStore", () => {
  it("is opt-in and stores only the bounded diagnostic schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-diagnostics-"));
    const store = new ProductDiagnosticsStore(root);

    await store.record("turn-started", { mission: true });
    expect((await store.list()).entries).toEqual([]);

    await store.configure({ enabled: true, retentionDays: 30 });
    await store.record("first-response", { mission: true, durationMs: 125 });
    const result = await store.list();

    expect(result.config).toEqual({ enabled: true, retentionDays: 30 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      kind: "first-response",
      mission: true,
      durationMs: 125,
    });
    const persisted = await readFile(join(root, "product-diagnostics", "events.json"), "utf8");
    expect(persisted).not.toContain("prompt");
    expect(persisted).not.toContain("workspace");
    expect(persisted).not.toContain("apiKey");
  });

  it("clamps retention and clears events without changing consent", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-diagnostics-"));
    const store = new ProductDiagnosticsStore(root);
    expect(await store.configure({ enabled: true, retentionDays: 999 })).toEqual({
      enabled: true,
      retentionDays: 90,
    });
    await store.record("renderer-startup");
    await store.clear();
    expect(await store.list()).toEqual({
      config: { enabled: true, retentionDays: 90 },
      entries: [],
    });
  });
});
