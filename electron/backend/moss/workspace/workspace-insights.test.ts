import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_PREVIEW_BYTES, readWorkspacePreview, suggestVerificationCommands } from "./workspace-insights";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-insights-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readWorkspacePreview", () => {
  it("returns current text and reports missing files as new", async () => {
    await writeFile(join(root, "a.txt"), "hello\n");
    expect(await readWorkspacePreview(root, "a.txt")).toEqual({ exists: true, content: "hello\n", byteLength: 6 });
    expect(await readWorkspacePreview(root, "missing.txt")).toEqual({ exists: false });
  });

  it("refuses paths outside the workspace, binaries, and oversized files", async () => {
    expect((await readWorkspacePreview(root, "../escape.txt")).error).toMatch(/escapes the workspace/);
    await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    expect(await readWorkspacePreview(root, "bin.dat")).toMatchObject({ exists: true, binary: true });
    await writeFile(join(root, "big.txt"), "x".repeat(MAX_PREVIEW_BYTES + 1));
    expect(await readWorkspacePreview(root, "big.txt")).toMatchObject({ exists: true, truncated: true });
    await mkdir(join(root, "dir"));
    expect((await readWorkspacePreview(root, "dir")).error).toBe("Not a regular file");
  });
});

describe("suggestVerificationCommands", () => {
  it("suggests package scripts with the detected package manager", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } }));
    expect((await suggestVerificationCommands(root)).map((suggestion) => suggestion.command)).toEqual(["npm test", "npm run lint", "npm run build"]);
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    expect((await suggestVerificationCommands(root))[0]).toEqual({ command: "pnpm test", source: "package.json \"test\" script" });
  });

  it("ignores placeholder npm test scripts and detects other ecosystems", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    await writeFile(join(root, "Cargo.toml"), "");
    await writeFile(join(root, "go.mod"), "");
    await writeFile(join(root, "pyproject.toml"), "[tool.poetry]\n");
    await writeFile(join(root, "Makefile"), "test:\n\techo ok\n");
    expect((await suggestVerificationCommands(root)).map((suggestion) => suggestion.command)).toEqual([
      "poetry run pytest",
      "cargo test",
      "go test ./...",
      "make test",
    ]);
  });

  it("returns nothing for missing or empty workspaces", async () => {
    expect(await suggestVerificationCommands("")).toEqual([]);
    expect(await suggestVerificationCommands(join(root, "missing"))).toEqual([]);
    expect(await suggestVerificationCommands(root)).toEqual([]);
  });
});
