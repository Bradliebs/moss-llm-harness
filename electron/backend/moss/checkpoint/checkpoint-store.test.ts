// electron/backend/moss/checkpoint/checkpoint-store.test.ts

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointStore } from "./checkpoint-store";

describe("CheckpointStore", () => {
  let dir: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-ckpt-"));
    store = new CheckpointStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reverts an overwritten file to its pre-image content", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "original", "utf8");

    const rec = store.recorder("t1");
    await rec.record(file, "a.txt");
    writeFileSync(file, "modified", "utf8"); // simulate the tool's write

    const result = await store.revert("t1");
    expect(result).toEqual({ reverted: 1, errors: [] });
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("leaves a file that changed after the turn instead of overwriting newer work", async () => {
    const changedLater = join(dir, "a.txt");
    const untouched = join(dir, "b.txt");
    writeFileSync(changedLater, "original", "utf8");
    writeFileSync(untouched, "b0", "utf8");
    const rec = store.recorder("t1");
    await rec.record(changedLater, "a.txt");
    await rec.record(untouched, "b.txt");
    writeFileSync(changedLater, "turn 1", "utf8");
    writeFileSync(untouched, "b1", "utf8");
    await store.seal("t1");
    writeFileSync(changedLater, "turn 2 or the user", "utf8"); // edited after the turn

    const result = await store.revert("t1");
    expect(result.reverted).toBe(1);
    expect(result.errors).toEqual(["a.txt: changed after this turn, so it was left as it is"]);
    expect(readFileSync(changedLater, "utf8")).toBe("turn 2 or the user");
    expect(readFileSync(untouched, "utf8")).toBe("b0");

    // The skipped file stays undoable: once the later edit is gone, undo works.
    expect(await store.list("t1")).toEqual([{ path: "a.txt", existed: true }]);
    writeFileSync(changedLater, "turn 1", "utf8");
    expect(await store.revert("t1")).toEqual({ reverted: 1, errors: [] });
    expect(readFileSync(changedLater, "utf8")).toBe("original");
    expect(await store.list("t1")).toEqual([]);
  });

  it("does not bring back a manifest when a seal races a revert", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "original", "utf8");
    await store.recorder("t1").record(file, "a.txt");
    writeFileSync(file, "turn 1", "utf8");

    const sealing = store.seal("t1");
    const reverting = store.revert("t1");
    await Promise.all([sealing, reverting]);

    expect(readFileSync(file, "utf8")).toBe("original");
    expect(await new CheckpointStore(dir).list("t1")).toEqual([]);
  });

  it("deletes a file the turn created when reverting", async () => {
    const file = join(dir, "new.txt");
    const rec = store.recorder("t1");
    await rec.record(file, "new.txt"); // file does not exist yet
    writeFileSync(file, "created by tool", "utf8");

    const result = await store.revert("t1");
    expect(result.reverted).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the earliest pre-image when a path is recorded twice in a turn", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "v1", "utf8");

    const rec = store.recorder("t1");
    await rec.record(file, "a.txt");
    writeFileSync(file, "v2", "utf8");
    await rec.record(file, "a.txt"); // second snapshot must be ignored
    writeFileSync(file, "v3", "utf8");

    await store.revert("t1");
    expect(readFileSync(file, "utf8")).toBe("v1");
  });

  it("lists the files a turn changed", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "x", "utf8");
    const rec = store.recorder("t1");
    await rec.record(a, "a.txt");
    await rec.record(b, "b.txt");

    const files = await store.list("t1");
    expect(files).toEqual([
      { path: "a.txt", existed: true },
      { path: "b.txt", existed: false },
    ]);
  });

  it("returns an empty result for an unknown turn", async () => {
    expect(await store.revert("nope")).toEqual({ reverted: 0, errors: [] });
    expect(await store.list("nope")).toEqual([]);
  });

  it("does not revert a turn twice", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "original", "utf8");
    const rec = store.recorder("t1");
    await rec.record(file, "a.txt");
    writeFileSync(file, "modified", "utf8");

    expect((await store.revert("t1")).reverted).toBe(1);
    writeFileSync(file, "changed again", "utf8");
    expect(await store.revert("t1")).toEqual({ reverted: 0, errors: [] });
    expect(readFileSync(file, "utf8")).toBe("changed again");
  });

  it("reverts after reloading from disk (no in-memory cache)", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "original", "utf8");
    await store.recorder("t1").record(file, "a.txt");
    writeFileSync(file, "modified", "utf8");

    const fresh = new CheckpointStore(dir); // cold store, reads the manifest
    expect((await fresh.revert("t1")).reverted).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("prunes old turn manifests beyond the retention limit", async () => {
    for (let i = 0; i < 5; i++) {
      const f = join(dir, `f${i}.txt`);
      await store.recorder(`t${i}`).record(f, `f${i}.txt`);
    }
    store.prune(2);
    const manifests = readdirSync(join(dir, "checkpoints")).filter((n) => n.endsWith(".json"));
    expect(manifests.length).toBe(2);
  });
});
