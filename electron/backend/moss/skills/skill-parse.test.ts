// electron/backend/moss/skills/skill-parse.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSkillMarkdown,
  formatSkillsForSystemPrompt,
  parseSkillMarkdown,
  slugifySkillName,
} from "./skill-parse";
import { SkillsStore } from "./skills-store";

describe("skill-parse", () => {
  it("parses frontmatter and body", () => {
    const md = `---\nname: "demo"\ndescription: "a demo skill"\ndisable-model-invocation: true\n---\n\nDo the thing.`;
    const parsed = parseSkillMarkdown(md);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("demo");
    expect(parsed?.description).toBe("a demo skill");
    expect(parsed?.instructions).toBe("Do the thing.");
    expect(parsed?.disableModelInvocation).toBe(true);
  });

  it("unquotes YAML scalars in either quote style", () => {
    const single = parseSkillMarkdown("---\nname: 'agency-code-reviewer'\ndescription: 'Reviews code; it''s strict about C:\\paths'\n---\nBody");
    expect(single?.description).toBe("Reviews code; it's strict about C:\\paths");
    const double = parseSkillMarkdown("---\nname: \"x\"\ndescription: \"Say \\\"hi\\\" to C:\\\\temp\"\n---\nBody");
    expect(double?.description).toBe("Say \"hi\" to C:\\temp");
  });

  it("returns null without frontmatter or name", () => {
    expect(parseSkillMarkdown("no frontmatter here")).toBeNull();
    expect(parseSkillMarkdown(`---\ndescription: "x"\n---\nbody`)).toBeNull();
  });

  it("round-trips through buildSkillMarkdown", () => {
    const md = buildSkillMarkdown("my-skill", "does stuff", "step one\nstep two");
    const parsed = parseSkillMarkdown(md);
    expect(parsed?.name).toBe("my-skill");
    expect(parsed?.description).toBe("does stuff");
    expect(parsed?.instructions).toBe("step one\nstep two");
  });

  it("slugifies names safely", () => {
    expect(slugifySkillName("My Cool Skill!")).toBe("my-cool-skill");
    expect(slugifySkillName("../escape")).toBe("escape");
  });

  it("formats only enabled skills", () => {
    const out = formatSkillsForSystemPrompt([
      { id: "a", name: "alpha", description: "first", instructions: "", enabled: true, createdAt: "" },
      { id: "b", name: "beta", description: "second", instructions: "", enabled: false, createdAt: "" },
      { id: "c", name: "command", description: "explicit only", instructions: "", enabled: true, createdAt: "", modelInvocable: false },
    ]);
    expect(out).toContain("alpha");
    expect(out).not.toContain("beta");
    expect(out).not.toContain("command");
  });
});

describe("SkillsStore", () => {
  let dir: string;
  let store: SkillsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-skills-"));
    store = new SkillsStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates, lists, toggles, and deletes a skill", () => {
    const created = store.create("Test Skill", "a test", "the instructions");
    expect(created.name).toBe("test-skill");
    expect(created.enabled).toBe(true);

    expect(store.list()).toHaveLength(1);
    expect(store.get("test-skill")?.instructions).toBe("the instructions");

    store.setEnabled(created.id, false);
    expect(store.get(created.id)?.enabled).toBe(false);

    expect(store.delete(created.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
});
