// electron/backend/moss/skills/skills-store.test.ts
//
// Unit tests for the on-disk skills store. A tmpdir baseDir override stands in
// for Electron userData, so `app` is never touched and no electron mock is
// needed (mirrors memory-store.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillsStore } from "./skills-store";

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

  it("lists nothing when the directory does not exist", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a skill and lists it back, enabled by default", () => {
    const created = store.create("Note Taker", "Takes notes", "Do the thing.");
    expect(created.id).toBe("note-taker");
    expect(created.name).toBe("note-taker");
    expect(created.description).toBe("Takes notes");
    expect(created.instructions).toBe("Do the thing.");
    expect(created.enabled).toBe(true);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("note-taker");
  });

  it("persists a created skill to disk across store instances", () => {
    store.create("Note Taker", "Takes notes", "Do the thing.");
    const reopened = new SkillsStore(dir);
    expect(reopened.list().map((s) => s.id)).toEqual(["note-taker"]);
  });

  it("imports nested skill directories with resources disabled and preserves existing skills", () => {
    const source = join(dir, "source");
    const importedSource = join(source, "engineering", "imported-skill");
    mkdirSync(importedSource, { recursive: true });
    writeFileSync(join(source, "LICENSE"), "sample license", "utf8");
    writeFileSync(
      join(importedSource, "SKILL.md"),
      "---\nname: imported-skill\ndescription: Imported instructions\ndisable-model-invocation: true\n---\n\nRead REFERENCE.md.\n",
      "utf8",
    );
    writeFileSync(join(importedSource, "REFERENCE.md"), "supporting detail", "utf8");
    store.create("existing", "keep", "original");

    const first = store.importFromDirectory(source);
    const second = store.importFromDirectory(source);
    const reopened = new SkillsStore(dir);

    expect(first).toEqual({ imported: ["imported-skill"], skipped: [], invalid: [] });
    expect(second).toEqual({ imported: [], skipped: ["imported-skill"], invalid: [] });
    expect(reopened.get("imported-skill")).toMatchObject({ enabled: false, createdBy: "import", modelInvocable: false });
    expect(reopened.get("existing")?.instructions).toBe("original");
    expect(reopened.listResources("imported-skill")).toEqual(["REFERENCE.md"]);
    expect(reopened.readResource("imported-skill", "REFERENCE.md")).toBe("supporting detail");
    expect(reopened.readResource("imported-skill", "../existing/SKILL.md")).toBeNull();
    // An absolute path, including one on another drive, never leaves the skill.
    expect(reopened.readResource("imported-skill", join(tmpdir(), "outside.txt"))).toBeNull();
    expect(reopened.readResource("imported-skill", "Z:\\secrets.txt")).toBeNull();
    expect(readFileSync(join(dir, "m-skills", "imported-skill", "REFERENCE.md"), "utf8")).toBe("supporting detail");
    expect(readFileSync(join(dir, "m-skills", "imported-skill", "LICENSE"), "utf8")).toBe("sample license");
  });

  it("slugifies a messy name into a filesystem-safe id", () => {
    const created = store.create("My Cool Skill!! v2", "desc", "body");
    expect(created.id).toBe("my-cool-skill-v2");
  });

  it("finds a skill by id or by name", () => {
    store.create("Finder", "finds", "body");
    expect(store.get("finder")?.id).toBe("finder");
    expect(store.get("nope")).toBeNull();
  });

  it("toggles enablement and persists it across instances", () => {
    store.create("Toggler", "t", "body");
    store.setEnabled("toggler", false);
    expect(store.list()[0].enabled).toBe(false);

    const reopened = new SkillsStore(dir);
    expect(reopened.list()[0].enabled).toBe(false);

    store.setEnabled("toggler", true);
    expect(store.list()[0].enabled).toBe(true);
  });

  it("deletes a skill and reports whether anything was removed", () => {
    store.create("Doomed", "d", "body");
    expect(store.delete("doomed")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.delete("doomed")).toBe(false);
  });

  it("updates description and instructions while preserving id and enablement", () => {
    store.create("Editable", "old desc", "old body");
    store.setEnabled("editable", false);

    const updated = store.update("editable", "new desc", "new body");
    expect(updated?.id).toBe("editable");
    expect(updated?.name).toBe("editable");
    expect(updated?.description).toBe("new desc");
    expect(updated?.instructions).toBe("new body");
    expect(updated?.enabled).toBe(false);

    const reopened = new SkillsStore(dir);
    const persisted = reopened.get("editable");
    expect(persisted?.description).toBe("new desc");
    expect(persisted?.instructions).toBe("new body");
  });

  it("returns null when updating a skill that does not exist", () => {
    expect(store.update("ghost", "d", "b")).toBeNull();
  });

  it("renames a skill, migrating its directory and preserving enablement", () => {
    store.create("Old Name", "desc", "body");
    store.setEnabled("old-name", false);

    const renamed = store.rename("old-name", "New Name");
    expect(renamed?.id).toBe("new-name");
    expect(renamed?.name).toBe("new-name");
    expect(renamed?.description).toBe("desc");
    expect(renamed?.instructions).toBe("body");
    expect(renamed?.enabled).toBe(false);

    expect(existsSync(join(dir, "m-skills", "old-name"))).toBe(false);
    const reopened = new SkillsStore(dir);
    expect(reopened.get("old-name")).toBeNull();
    expect(reopened.get("new-name")?.enabled).toBe(false);
  });

  it("returns the unchanged skill when the new name slugifies to the same id", () => {
    store.create("Same", "desc", "body");
    const renamed = store.rename("same", "SAME");
    expect(renamed?.id).toBe("same");
    expect(existsSync(join(dir, "m-skills", "same"))).toBe(true);
  });

  it("refuses to overwrite a different existing skill and returns null", () => {
    store.create("Alpha", "a", "ab");
    store.create("Beta", "b", "bb");
    expect(store.rename("alpha", "Beta")).toBeNull();
    expect(store.get("alpha")?.description).toBe("a");
    expect(store.get("beta")?.description).toBe("b");
  });

  it("returns null when renaming a skill that does not exist", () => {
    expect(store.rename("ghost", "Whatever")).toBeNull();
  });

  it("ignores directories without a SKILL.md file", () => {
    mkdirSync(join(dir, "m-skills", "not-a-skill"), { recursive: true });
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, "m-skills", "not-a-skill"))).toBe(true);
  });
});
