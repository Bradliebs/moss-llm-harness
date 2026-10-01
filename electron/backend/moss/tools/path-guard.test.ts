// Tests for the workspace sandbox guard. The escape cases are the security
// boundary for every filesystem tool, so they are verified explicitly.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveInWorkspace } from "./path-guard";

const root = resolve("test-workspace-root");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "file.txt")).toBe(resolve(root, "file.txt"));
  });

  it("resolves a nested relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "sub/dir/file.txt")).toBe(resolve(root, "sub/dir/file.txt"));
  });

  it("allows the workspace root itself", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
    expect(resolveInWorkspace(root, root)).toBe(root);
  });

  it("rejects a parent-directory escape", () => {
    expect(() => resolveInWorkspace(root, "../evil.txt")).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an escape hidden by nested traversal", () => {
    expect(() => resolveInWorkspace(root, "a/../../evil.txt")).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an absolute path outside the workspace", () => {
    const outside = resolve(root, "..", "outside.txt");
    expect(() => resolveInWorkspace(root, outside)).toThrow(/escapes the workspace sandbox/);
  });

  it("rejects an empty path", () => {
    expect(() => resolveInWorkspace(root, "")).toThrow(/path is required/);
  });

  it("rejects when no workspace folder is selected", () => {
    expect(() => resolveInWorkspace("", "file.txt")).toThrow(/No workspace folder selected/);
  });

  it("allows a file named with two leading dots", () => {
    expect(resolveInWorkspace(root, "..notes.txt")).toBe(resolve(root, "..notes.txt"));
  });

  it("rejects a junction or link inside the workspace that points outside it", () => {
    const base = mkdtempSync(join(tmpdir(), "moss-guard-"));
    try {
      const workspace = join(base, "ws");
      const outside = join(base, "secrets");
      mkdirSync(workspace);
      mkdirSync(outside);
      writeFileSync(join(outside, "key.txt"), "secret");
      // A junction needs no admin rights on Windows and is a symlink elsewhere.
      symlinkSync(outside, join(workspace, "link"), "junction");
      expect(() => resolveInWorkspace(workspace, "link/key.txt")).toThrow(/through a link/);
      expect(() => resolveInWorkspace(workspace, "link/new-file.txt")).toThrow(/through a link/);
      // A link whose target was deleted must not let a write recreate it outside.
      const gone = join(base, "gone");
      mkdirSync(gone);
      symlinkSync(gone, join(workspace, "dangling"), "junction");
      rmSync(gone, { recursive: true, force: true });
      expect(() => resolveInWorkspace(workspace, "dangling/x.txt")).toThrow(/through a link/);
      mkdirSync(join(workspace, "real"));
      expect(resolveInWorkspace(workspace, "real/new/file.txt")).toBe(join(workspace, "real", "new", "file.txt"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});