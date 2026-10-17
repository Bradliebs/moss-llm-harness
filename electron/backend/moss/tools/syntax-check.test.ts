import { describe, expect, it } from "vitest";

import { syntaxNote, syntaxProblem } from "./syntax-check";

describe("syntaxProblem", () => {
  it("names the error and line of JavaScript that no longer parses", () => {
    // Recorded from ministral-3:8b: `//` starts a comment, so the call never closes.
    const broken = "function slugify(text) {\n  return text\n    .replace(//{1,}/g, \"-\");\n}\n";
    expect(syntaxProblem("src/slugify.js", broken)).toMatch(/^SyntaxError: .+ \(line \d+\)$/);
    expect(syntaxNote("src/slugify.js", broken, "function slugify(text) {}\n")).toMatch(/^\n\[check\] src\/slugify\.js no longer parses: SyntaxError: /);
    expect(syntaxNote("src/new.js", broken)).toMatch(/^\n\[check\] src\/new\.js does not parse: SyntaxError: /);
  });

  it("only reports a change that broke a file that parsed before", () => {
    expect(syntaxNote("a.js", "const a = (;", "const b = (;")).toBe("");
    expect(syntaxNote("a.js", "const a = 1;", "const b = (;")).toBe("");
  });

  it("accepts valid scripts, ES modules, and files it does not check", () => {
    expect(syntaxProblem("a.js", "module.exports = { a: 1 };\n")).toBeUndefined();
    expect(syntaxProblem("a.cjs", "#!/usr/bin/env node\nconsole.log(1);\n")).toBeUndefined();
    expect(syntaxProblem("a.js", "import x from \"./x.js\";\nexport const y = x;\n")).toBeUndefined();
    expect(syntaxProblem("a.js", "const data = await load();\n")).toBeUndefined();
    // CommonJS allows a top-level return; JSX in .js cannot be judged here.
    expect(syntaxProblem("a.js", "if (done) return;\nmodule.exports = 1;\n")).toBeUndefined();
    expect(syntaxProblem("App.js", "const App = () => <div />;\n")).toBeUndefined();
    expect(syntaxProblem("a.ts", "const a: number = ;")).toBeUndefined();
    expect(syntaxNote("README.md", "# (")).toBe("");
  });

  it("checks JSON, except files that allow comments", () => {
    expect(syntaxProblem("package.json", "{\"name\": \"a\",}")).toMatch(/^invalid JSON: /);
    expect(syntaxProblem("package.json", "{\"name\": \"a\"}")).toBeUndefined();
    expect(syntaxProblem("tsconfig.json", "{ // comment\n}")).toBeUndefined();
    expect(syntaxProblem(".vscode/settings.json", "{ // comment\n}")).toBeUndefined();
  });
});
