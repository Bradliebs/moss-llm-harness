import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verificationFileTouched } from "./verification-files";

describe("verificationFileTouched", () => {
  it("recognizes files that decide what verification runs", () => {
    for (const path of ["package.json", "packages/api/package.json", "vite.config.ts", "src/vitest.config.mts", "tsconfig.node.json", ".eslintrc.cjs", "scripts/test.sh", ".github/workflows/ci.yml", "pytest.ini", "tests/conftest.py"]) {
      expect(verificationFileTouched("edit_file", { path }, "")).toBe(path);
    }
    expect(verificationFileTouched("move_file", { from: "a.ts", to: "jest.config.js" }, "")).toBe("jest.config.js");
  });

  it("covers other ecosystems, commands that write the files, and folder moves", () => {
    for (const path of ["pom.xml", "app/build.gradle.kts", "src/App.csproj", "Directory.Build.props", "Gemfile", "noxfile.py", ".coveragerc", "justfile"]) {
      expect(verificationFileTouched("write_file", { path }, "")).toBe(path);
    }
    expect(verificationFileTouched("run_command", { command: "npm pkg set scripts.test=\"exit 0\"" }, "")).toBeDefined();
    expect(verificationFileTouched("run_command", { command: "sed -i s/jest/true/ package.json" }, "")).toBe("package.json");
    expect(verificationFileTouched("run_command", { command: "echo {} > tsconfig.json" }, "")).toBe("tsconfig.json");
    expect(verificationFileTouched("run_command", { command: "cat package.json" }, "")).toBeUndefined();
    expect(verificationFileTouched("run_command", { command: "npm install lodash" }, "")).toBeUndefined();
    for (const command of ["git add package.json", "git commit -m x package.json", "git checkout -- package.json", "git restore package.json", "git stash"]) {
      expect(verificationFileTouched("run_command", { command }, "")).toBeUndefined();
    }
    expect(verificationFileTouched("run_command", { command: "git add . && sed -i s/a/b/ package.json" }, "")).toBe("package.json");
    const root = mkdtempSync(join(tmpdir(), "moss-verify-files-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      mkdirSync(join(root, "packages", "api"), { recursive: true });
      writeFileSync(join(root, "packages", "api", "package.json"), "{}");
      mkdirSync(join(root, "src"));
      expect(verificationFileTouched("move_file", { from: ".github", to: "old" }, root)).toBe(".github");
      expect(verificationFileTouched("move_file", { from: "packages/api", to: "old-api" }, root)).toBe("packages/api");
      expect(verificationFileTouched("move_file", { from: "src", to: "lib" }, root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores ordinary source files and other tools", () => {
    for (const path of ["src/app.ts", "README.md", "src/config/settings.ts", "docs/package-notes.md"]) {
      expect(verificationFileTouched("write_file", { path }, "")).toBeUndefined();
    }
    expect(verificationFileTouched("read_file", { path: "package.json" }, "")).toBeUndefined();
  });
});
