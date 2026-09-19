import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySandboxSnapshot, WORKSPACE_BYTES } from "./sandbox-snapshot";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moss-snapshot-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "existing.txt"), "unchanged");
  return workspace;
}

describe("sandbox snapshot", () => {
  it("synchronizes binary files, deletions and empty directories", () => {
    const root = fixture();
    applySandboxSnapshot(root, [
      { path: "nested", mode: 0o755 }, { path: "empty", mode: 0o755 },
      { path: "nested/data", mode: 0o644, content: Buffer.from([0, 255, 7]).toString("base64") },
    ]);
    expect(readFileSync(join(root, "nested/data"))).toEqual(Buffer.from([0, 255, 7]));
    expect(readdirSync(root).sort()).toEqual(["empty", "nested"]);
  });

  it.each(["../canary", "/canary", "C:/canary", "nested\\canary", "file:stream", "NUL", "file.", "file ", "nested//file"])("rejects unsafe path %s without writes", (path) => {
    const root = fixture();
    expect(() => applySandboxSnapshot(root, [{ path, mode: 0o644, content: "" }])).toThrow();
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("unchanged");
  });

  it.each([
    [{ path: "a", mode: 0o644, content: "" }, { path: "A", mode: 0o644, content: "" }],
    [{ path: "nested/file", mode: 0o644, content: "" }],
    [{ path: "file", mode: 0o644, content: "not base64" }],
    [{ path: "file", mode: 0o4755, content: "" }],
  ].map((entries) => ({ entries })))("rejects malformed snapshots before deleting original files", ({ entries }) => {
    const root = fixture();
    expect(() => applySandboxSnapshot(root, entries)).toThrow();
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("unchanged");
  });

  it("rejects oversized content before decoding or writing", () => {
    const root = fixture();
    expect(() => applySandboxSnapshot(root, [{ path: "large", mode: 0o644, content: "A".repeat(Math.ceil(WORKSPACE_BYTES / 3) * 4 + 4) }])).toThrow("content");
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("unchanged");
  });
});