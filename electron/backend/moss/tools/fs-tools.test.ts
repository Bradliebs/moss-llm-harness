// Tests for the surgical edit_file and search_files workspace tools. Both run
// against a real temporary workspace so the sandbox + filesystem behavior is
// exercised end to end.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editFileTool, globFilesTool, moveFileTool, readFileTool, searchFilesTool, writeFileTool } from "./fs-tools";
import type { ToolContext } from "./types";

let root: string;

function ctx(): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("replaces a unique snippet in place", async () => {
    await writeFile(join(root, "a.txt"), "hello world\nsecond line\n", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "hello world", newText: "hi there" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hi there\nsecond line\n");
  });

  it("errors when oldText is not found", async () => {
    await writeFile(join(root, "a.txt"), "content", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "missing", newText: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
  });

  it("refuses an ambiguous match unless replaceAll is set", async () => {
    await writeFile(join(root, "a.txt"), "foo foo foo", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "foo", newText: "bar" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("3 places");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("foo foo foo");
  });

  it("replaces every occurrence with replaceAll", async () => {
    await writeFile(join(root, "a.txt"), "foo foo foo", "utf8");
    const res = await editFileTool.execute(
      { path: "a.txt", oldText: "foo", newText: "bar", replaceAll: true },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Replaced 3 occurrences");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("bar bar bar");
  });

  it("writes replacement text literally, not as a regex template", async () => {
    await writeFile(join(root, "a.txt"), "value: PLACEHOLDER", "utf8");
    const res = await editFileTool.execute({ path: "a.txt", oldText: "PLACEHOLDER", newText: "$& and $1" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("value: $& and $1");
  });

  it("errors when the file does not exist", async () => {
    const res = await editFileTool.execute({ path: "nope.txt", oldText: "a", newText: "b" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("File not found");
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(editFileTool.execute({ path: "../evil.txt", oldText: "a", newText: "b" }, ctx())).rejects.toThrow(
      /escapes the workspace sandbox/,
    );
  });
});

describe("line endings and line ranges", () => {
  it("edits a CRLF file with LF oldText and keeps CRLF", async () => {
    await writeFile(join(root, "a.js"), "function add(a, b) {\r\n  return a - b;\r\n}\r\n", "utf8");
    const res = await editFileTool.execute({ path: "a.js", oldText: "function add(a, b) {\n  return a - b;\n}", newText: "function add(a, b) {\n  return a + b;\n}" }, ctx());
    expect(res).toEqual({ ok: true, content: "Replaced 1 occurrence in a.js at line 1" });
    expect(await readFile(join(root, "a.js"), "utf8")).toBe("function add(a, b) {\r\n  return a + b;\r\n}\r\n");
  });

  it("writes inserted lines with CRLF when a one-line oldText matched exactly", async () => {
    await writeFile(join(root, "c.js"), "const a = 1;\r\nconst b = 2;\r\n", "utf8");
    await editFileTool.execute({ path: "c.js", oldText: "const a = 1;", newText: "const a = 1;\nconst c = 3;" }, ctx());
    expect(await readFile(join(root, "c.js"), "utf8")).toBe("const a = 1;\r\nconst c = 3;\r\nconst b = 2;\r\n");
  });

  it("follows the majority line ending in a mixed file", async () => {
    await writeFile(join(root, "m.js"), "a\nb\nc\r\nd\n", "utf8");
    await editFileTool.execute({ path: "m.js", oldText: "a", newText: "a\nz" }, ctx());
    expect(await readFile(join(root, "m.js"), "utf8")).toBe("a\nz\nb\nc\r\nd\n");
    await editFileTool.execute({ path: "m.js", oldText: "c\nd", newText: "c\nD" }, ctx());
    expect(await readFile(join(root, "m.js"), "utf8")).toBe("a\nz\nb\nc\nD\n");
  });

  it("says where a near miss is and shows the actual text", async () => {
    await writeFile(join(root, "a.py"), "def f():\n    if x:\n        return 1\n", "utf8");
    const res = await editFileTool.execute({ path: "a.py", oldText: "if x:\n    return 1", newText: "if x:\n    return 2" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("first line appears at line 2");
    expect(res.content).toContain("        return 1");
  });

  it("keeps CRLF when overwriting a CRLF file, and writes new files as given", async () => {
    await writeFile(join(root, "w.txt"), "a\r\nb\r\n", "utf8");
    await writeFileTool.execute({ path: "w.txt", content: "a\nc\n" }, ctx());
    expect(await readFile(join(root, "w.txt"), "utf8")).toBe("a\r\nc\r\n");
    await writeFileTool.execute({ path: "new.txt", content: "x\ny\n" }, ctx());
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("x\ny\n");
  });

  it("sizes pages in UTF-8 bytes so non-English text fits one result", async () => {
    await writeFile(join(root, "cjk.ts"), Array.from({ length: 400 }, (_, i) => `// 注释说明第${i}行，这里是中文内容`).join("\n"), "utf8");
    const page = await readFileTool.execute({ path: "cjk.ts" }, { ...ctx(), maxResultChars: 3_000 });
    expect(page.content.startsWith("[lines 1-")).toBe(true);
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(3_000);
  });

  it("explains missing files, directories, no-op edits, and shrinking overwrites", async () => {
    expect((await readFileTool.execute({ path: "nope.ts" }, ctx())).content).toBe("File not found: nope.ts. Use glob_files or list_dir to find it.");
    await mkdir(join(root, "dir"), { recursive: true });
    expect((await readFileTool.execute({ path: "dir" }, ctx())).content).toContain("is a directory");
    await writeFile(join(root, "s.ts"), "a\nb\nc\n", "utf8");
    expect((await editFileTool.execute({ path: "s.ts", oldText: "b", newText: "b" }, ctx())).ok).toBe(false);
    expect((await writeFileTool.execute({ path: "s.ts", content: "a\n" }, ctx())).content).toBe("Wrote 2 bytes to s.ts (replaced 4 lines with 2)");
  });

  it("reads a line range with a header, and notes how to page a large file", async () => {
    await writeFile(join(root, "big.ts"), Array.from({ length: 1_500 }, (_, i) => `export const v${i} = ${i};`).join("\r\n"), "utf8");
    const part = await readFileTool.execute({ path: "big.ts", startLine: 700, endLine: 702 }, ctx());
    expect(part.content).toBe("[lines 700-702 of 1500]\nexport const v699 = 699;\nexport const v700 = 700;\nexport const v701 = 701;");
    const clamped = await readFileTool.execute({ path: "big.ts", startLine: 1_499, endLine: 9_999 }, ctx());
    expect(clamped.content.startsWith("[lines 1499-1500 of 1500]")).toBe(true);
    const whole = await readFileTool.execute({ path: "big.ts" }, { ...ctx(), maxResultChars: 3_000 });
    const header = whole.content.split("\n")[0];
    expect(header).toMatch(/^\[lines 1-(\d+) of 1500; to read on, call read_file with startLine=(\d+)\]$/);
    const [, last, next] = header.match(/1-(\d+) of 1500; .*startLine=(\d+)/)!;
    expect(Number(next)).toBe(Number(last) + 1);
    expect(whole.content.length).toBeLessThanOrEqual(3_000);
    expect(whole.content.split("\n").at(-1)).toBe(`export const v${Number(last) - 1} = ${Number(last) - 1};`);
    await writeFile(join(root, "small.txt"), "tiny\n", "utf8");
    expect((await readFileTool.execute({ path: "small.txt" }, ctx())).content).toBe("tiny\n");
    expect((await readFileTool.execute({ path: "small.txt", startLine: 1 }, ctx())).content).toBe("[lines 1-1 of 1]\ntiny");
    expect((await readFileTool.execute({ path: "small.txt", startLine: 5 }, ctx())).content).toBe("small.txt has 1 lines; startLine 5 is past the end.");
  });
});

describe("search_files", () => {
  it("searches by regex and include glob, skips lockfiles, and hints at regex", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "function   bar() {}\nconst foo = 1;\n", "utf8");
    await writeFile(join(root, "src", "a.md"), "foo in docs\n", "utf8");
    await writeFile(join(root, "package-lock.json"), "\"foo\": 1\n", "utf8");
    expect((await searchFilesTool.execute({ query: "function\\s+bar", regex: true }, ctx())).content).toBe("src/a.ts:1: function   bar() {}");
    expect((await searchFilesTool.execute({ query: "foo", include: "*.ts" }, ctx())).content).toBe("src/a.ts:2: const foo = 1;");
    expect((await searchFilesTool.execute({ query: "foo" }, ctx())).content).not.toContain("package-lock");
    expect((await searchFilesTool.execute({ query: "foo", include: "package-lock.json" }, ctx())).content).toContain("package-lock.json:1");
    expect((await searchFilesTool.execute({ query: "zip|zap" }, ctx())).content).toContain("set regex to true");

    expect((await searchFilesTool.execute({ query: "(unclosed", regex: true }, ctx())).content).toContain("Invalid regular expression");
  });

  it("stops a regular expression that backtracks without bound instead of freezing", async () => {
    await writeFile(join(root, "slow.txt"), `${"a".repeat(40)}!\n`, "utf8");
    const started = Date.now();
    const res = await searchFilesTool.execute({ query: "(a|aa)+$", regex: true }, ctx());
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("the regular expression is too slow");
  }, 15_000);

  it("skips caches and files over 1 MB", async () => {
    await mkdir(join(root, ".venv"), { recursive: true });
    await writeFile(join(root, ".venv", "lib.py"), "needle", "utf8");
    await writeFile(join(root, "huge.log"), `needle\n${"x".repeat(1_100_000)}`, "utf8");
    await writeFile(join(root, "src.py"), "needle", "utf8");
    const res = await searchFilesTool.execute({ query: "needle" }, ctx());
    expect(res.content).toBe("src.py:1: needle");
  });

  it("returns matching lines as path:line: text", async () => {
    await writeFile(join(root, "a.txt"), "alpha\nbeta needle here\ngamma\n", "utf8");
    const res = await searchFilesTool.execute({ query: "needle" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("a.txt:2: beta needle here");
  });

  it("matches case-insensitively", async () => {
    await writeFile(join(root, "a.txt"), "Has NEEDLE inside", "utf8");
    const res = await searchFilesTool.execute({ query: "needle" }, ctx());
    expect(res.content).toContain("a.txt:1:");
  });

  it("searches nested directories and skips node_modules", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "deep.txt"), "found target here", "utf8");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "target in dep", "utf8");
    const res = await searchFilesTool.execute({ query: "target" }, ctx());
    expect(res.content).toContain("sub/deep.txt:1:");
    expect(res.content).not.toContain("node_modules");
  });

  it("reports an honest no-match result", async () => {
    await writeFile(join(root, "a.txt"), "nothing relevant", "utf8");
    const res = await searchFilesTool.execute({ query: "zzz" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No matches");
  });

  it("respects maxResults and flags capping", async () => {
    const lines = Array.from({ length: 10 }, () => "hit").join("\n");
    await writeFile(join(root, "a.txt"), lines, "utf8");
    const res = await searchFilesTool.execute({ query: "hit", maxResults: 3 }, ctx());
    expect(res.content).toContain("capped at 3 matches");
    expect(res.content.split("\n").filter((l) => l.startsWith("a.txt:")).length).toBe(3);
  });

  it("requires a query", async () => {
    const res = await searchFilesTool.execute({ query: "  " }, ctx());
    expect(res.ok).toBe(false);
  });

  it("skips binary files", async () => {
    await writeFile(join(root, "bin.dat"), "match\u0000here", "utf8");
    await writeFile(join(root, "text.txt"), "match here", "utf8");
    const res = await searchFilesTool.execute({ query: "match" }, ctx());
    expect(res.content).toContain("text.txt:1:");
    expect(res.content).not.toContain("bin.dat");
  });
});

describe("glob_files", () => {
  it("matches files across directories with **", async () => {
    await writeFile(join(root, "top.ts"), "", "utf8");
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "", "utf8");
    await writeFile(join(root, "src", "deep", "b.ts"), "", "utf8");
    await writeFile(join(root, "src", "c.txt"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("top.ts");
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/deep/b.ts");
    expect(res.content).not.toContain("c.txt");
  });

  it("matches only the current segment with a single star in a path pattern", async () => {
    await writeFile(join(root, "a.txt"), "", "utf8");
    await mkdir(join(root, "sub", "deep"), { recursive: true });
    await writeFile(join(root, "sub", "b.txt"), "", "utf8");
    await writeFile(join(root, "sub", "deep", "c.txt"), "", "utf8");
    expect((await globFilesTool.execute({ pattern: "./*.txt" }, ctx())).content).toBe("a.txt");
    expect((await globFilesTool.execute({ pattern: "sub/*.txt" }, ctx())).content).toBe("sub/b.txt");
  });

  it("skips node_modules and build dirs", async () => {
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.ts"), "", "utf8");
    await writeFile(join(root, "keep.ts"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.content).toContain("keep.ts");
    expect(res.content).not.toContain("node_modules");
  });

  it("reports an honest no-match result", async () => {
    await writeFile(join(root, "a.ts"), "", "utf8");
    const res = await globFilesTool.execute({ pattern: "**/*.zzz" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No files match");
  });

  it("requires a pattern", async () => {
    const res = await globFilesTool.execute({ pattern: "  " }, ctx());
    expect(res.ok).toBe(false);
  });
});

describe("glob_files patterns", () => {
  it("expands braces, matches bare names in every folder, and sorts before capping", async () => {
    await mkdir(join(root, "src", "ui"), { recursive: true });
    for (const name of ["src/b.ts", "src/ui/a.tsx", "src/ui/c.css", "z.ts"]) await writeFile(join(root, name), "", "utf8");
    expect((await globFilesTool.execute({ pattern: "src/**/*.{ts,tsx}" }, ctx())).content).toBe("src/b.ts\nsrc/ui/a.tsx");
    expect((await globFilesTool.execute({ pattern: "*.ts" }, ctx())).content).toBe("src/b.ts\nz.ts");
    expect((await globFilesTool.execute({ pattern: "*.{ts,tsx}", maxResults: 2 }, ctx())).content).toBe("src/b.ts\nsrc/ui/a.tsx\n\u2026[capped at 2 matches]");
  });
});

describe("move_file", () => {
  it("renames a file in place", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    const res = await moveFileTool.execute({ from: "old.txt", to: "new.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("body");
    await expect(readFile(join(root, "old.txt"), "utf8")).rejects.toThrow();
  });

  it("creates destination parent directories", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    const res = await moveFileTool.execute({ from: "old.txt", to: "nested/deep/new.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "nested", "deep", "new.txt"), "utf8")).toBe("body");
  });

  it("errors when the source does not exist", async () => {
    const res = await moveFileTool.execute({ from: "missing.txt", to: "new.txt" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Source not found");
  });

  it("rejects a path escaping the workspace", async () => {
    await writeFile(join(root, "old.txt"), "body", "utf8");
    await expect(moveFileTool.execute({ from: "old.txt", to: "../evil.txt" }, ctx())).rejects.toThrow(
      /escapes the workspace sandbox/,
    );
  });
});
