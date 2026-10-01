import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskArtifactStore } from "./task-artifact-store";

describe("TaskArtifactStore", () => {
  let root: string;
  let store: TaskArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moss-task-artifact-"));
    store = new TaskArtifactStore(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stores content behind a bounded hash-bearing reference", async () => {
    const reference = await store.save({
      taskId: "task-1",
      planRevision: 1,
      stepId: "research",
      attemptId: "attempt-1",
      name: "findings",
      summary: "Research findings",
      content: "full private handoff",
    });

    expect(reference).toMatchObject({ taskId: "task-1", planRevision: 1, byteLength: 20 });
    expect(reference.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reference).not.toHaveProperty("content");
    expect(await store.get("task-1", reference.id)).toMatchObject({ ...reference, content: "full private handoff" });
  });

  it("keeps the untrusted sources a step read with its artifact", async () => {
    const reference = await store.save({
      taskId: "task-1", planRevision: 1, stepId: "research", attemptId: "attempt-1",
      name: "findings", summary: "From the web", content: "Acme $10", untrustedSources: ["fetch_url", "fetch_url", ""],
    });
    expect(reference.untrustedSources).toEqual(["fetch_url"]);
    expect((await store.get("task-1", reference.id))?.untrustedSources).toEqual(["fetch_url"]);
  });

  it("rejects unsafe keys and oversized content", async () => {
    await expect(store.save({
      taskId: "../task",
      planRevision: 1,
      stepId: "research",
      attemptId: "attempt-1",
      name: "findings",
      summary: "Research findings",
      content: "text",
    })).rejects.toThrow("safe identifier");

    await expect(store.save({
      taskId: "task-1",
      planRevision: 1,
      stepId: "research",
      attemptId: "attempt-1",
      name: "findings",
      summary: "Research findings",
      content: "x".repeat(256 * 1024 + 1),
    })).rejects.toThrow("exceeds");
  });

  it("refuses a record whose content no longer matches its digest", async () => {
    const reference = await store.save({
      taskId: "task-1",
      planRevision: 1,
      stepId: "research",
      attemptId: "attempt-1",
      name: "findings",
      summary: "Research findings",
      content: "original",
    });
    const path = join(root, "task-artifacts", "task-1", `${reference.id}.json`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, content: "tampered" }), "utf8");

    expect(await store.get("task-1", reference.id)).toBeNull();
  });
});