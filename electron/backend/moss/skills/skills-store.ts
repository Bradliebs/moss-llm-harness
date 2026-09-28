// electron/backend/moss/skills/skills-store.ts
//
// Skills live on disk as <userData>/m-skills/<id>/SKILL.md. Enablement is tracked
// in <userData>/m-skills/disabled.json (a list of disabled ids). All reads are
// best-effort: a missing directory or unparsable file yields no skill rather than
// throwing.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import type { Skill, SkillImportResult } from "../../../../common/types";
import { writeFileAtomicSync } from "../persistence/atomic-file";
import { buildSkillMarkdown, parseSkillMarkdown, setSkillCreatedBy, slugifySkillName } from "./skill-parse";

const log = createLogger("Skills");

export class SkillsStore {
  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private dir(): string {
    return join(this.baseDir ?? userDataDir(), "m-skills");
  }

  private disabledFile(): string {
    return join(this.dir(), "disabled.json");
  }

  private loadDisabled(): Set<string> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.disabledFile(), "utf8"));
      if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === "string"));
    } catch {
      /* missing or corrupt — treat as none disabled */
    }
    return new Set();
  }

  private saveDisabled(ids: Set<string>): void {
    try {
      writeFileAtomicSync(this.disabledFile(), `${JSON.stringify([...ids], null, 2)}\n`);
    } catch (err) {
      log.error("failed to save disabled skills", err);
    }
  }

  list(): Skill[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const disabled = this.loadDisabled();
    const skills: Skill[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const file = join(dir, e.name, "SKILL.md");
      if (!existsSync(file)) continue;
      let parsed: ReturnType<typeof parseSkillMarkdown>;
      try {
        parsed = parseSkillMarkdown(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!parsed) continue;
      const id = e.name;
      skills.push({
        id,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        enabled: !disabled.has(id),
        createdAt: "",
        createdBy: parsed.createdBy === "agent" || parsed.createdBy === "import" ? parsed.createdBy : "user",
        modelInvocable: !parsed.disableModelInvocation,
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(nameOrId: string): Skill | null {
    return this.list().find((s) => s.name === nameOrId || s.id === nameOrId) ?? null;
  }

  listResources(nameOrId: string): string[] {
    const skill = this.get(nameOrId);
    if (!skill) return [];
    const root = join(this.dir(), basename(skill.id));
    const resources: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name !== "SKILL.md" && entry.name !== "LICENSE") {
          resources.push(relative(root, path).split(sep).join("/"));
        }
      }
    }
    return resources.sort();
  }

  readResource(nameOrId: string, resourcePath: string): string | null {
    const skill = this.get(nameOrId);
    if (!skill) return null;
    const root = join(this.dir(), basename(skill.id));
    const target = resolve(root, resourcePath);
    const rel = relative(root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`..${sep}`)) return null;
    try {
      if (!statSync(target).isFile() || statSync(target).size > 256_000) return null;
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  }

  create(name: string, description: string, instructions: string, createdBy?: "user" | "agent" | "import"): Skill {
    const slug = slugifySkillName(name) || "skill";
    const dir = join(this.dir(), basename(slug));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), buildSkillMarkdown(slug, description, instructions, createdBy), "utf8");
    const created = this.get(slug);
    if (!created) throw new Error(`failed to create skill '${slug}'`);
    return created;
  }

  importFromDirectory(sourceRoot: string): SkillImportResult {
    const result: SkillImportResult = { imported: [], skipped: [], invalid: [] };
    const sourceDirs = this.findSkillDirectories(sourceRoot);
    const targetRoot = this.dir();
    mkdirSync(targetRoot, { recursive: true });
    const license = this.findLicense(sourceRoot);
    const disabled = this.loadDisabled();

    for (const sourceDir of sourceDirs) {
      let parsed: ReturnType<typeof parseSkillMarkdown>;
      try {
        parsed = parseSkillMarkdown(readFileSync(join(sourceDir, "SKILL.md"), "utf8"));
      } catch {
        parsed = null;
      }
      if (!parsed) {
        result.invalid.push(sourceDir);
        continue;
      }

      const id = slugifySkillName(parsed.name);
      const targetDir = join(targetRoot, basename(id));
      if (!id || existsSync(targetDir)) {
        result.skipped.push(id || sourceDir);
        continue;
      }

      const stagingDir = join(targetRoot, `.import-${id}-${randomUUID()}`);
      try {
        this.assertNoLinks(sourceDir);
        cpSync(sourceDir, stagingDir, { recursive: true, errorOnExist: true, force: false });
        writeFileSync(
          join(stagingDir, "SKILL.md"),
          setSkillCreatedBy(readFileSync(join(sourceDir, "SKILL.md"), "utf8"), "import"),
          "utf8",
        );
        if (license && !existsSync(join(stagingDir, "LICENSE"))) {
          cpSync(license, join(stagingDir, "LICENSE"), { errorOnExist: true, force: false });
        }
        renameSync(stagingDir, targetDir);
        disabled.add(id);
        result.imported.push(id);
      } catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        result.invalid.push(sourceDir);
        log.error(`failed to import skill '${parsed.name}'`, error);
      }
    }

    this.saveDisabled(disabled);
    return result;
  }

  private findSkillDirectories(sourceRoot: string): string[] {
    if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) return [];
    const found: string[] = [];
    const pending = [sourceRoot];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      const entries = readdirSync(current, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        found.push(current);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          pending.push(join(current, entry.name));
        }
      }
    }
    return found.sort();
  }

  private findLicense(sourceRoot: string): string | null {
    for (const root of [sourceRoot, join(sourceRoot, "..")]) {
      for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
        const candidate = join(root, name);
        if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
      }
    }
    return null;
  }

  private assertNoLinks(root: string): void {
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${path}`);
        if (entry.isDirectory()) pending.push(path);
      }
    }
  }

  /** Rewrite an existing skill's description and instructions in place. The id,
   *  name, and createdBy provenance are preserved; enablement is untouched.
   *  Returns the updated skill, or null when no skill with that id exists. */
  update(id: string, description: string, instructions: string): Skill | null {
    const file = join(this.dir(), basename(id), "SKILL.md");
    if (!existsSync(file)) return null;
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try {
      parsed = parseSkillMarkdown(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    if (!parsed) return null;
    writeFileAtomicSync(
      file,
      buildSkillMarkdown(parsed.name, description, instructions, parsed.createdBy, parsed.disableModelInvocation),
    );
    return this.get(id);
  }

  /** Rename a skill: migrate its on-disk directory to the slug of the new name,
   *  preserving description, instructions, provenance, and enablement. Returns
   *  the renamed skill, null when the source is missing/unparsable, or the
   *  unchanged skill when the new name slugifies to the same id. Refuses to
   *  overwrite a different existing skill (returns null on a slug collision). */
  rename(id: string, newName: string): Skill | null {
    const oldDir = join(this.dir(), basename(id));
    const oldFile = join(oldDir, "SKILL.md");
    if (!existsSync(oldFile)) return null;
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try {
      parsed = parseSkillMarkdown(readFileSync(oldFile, "utf8"));
    } catch {
      return null;
    }
    if (!parsed) return null;
    const newId = slugifySkillName(newName) || "skill";
    if (newId === id) return this.get(id);
    const newDir = join(this.dir(), basename(newId));
    if (existsSync(newDir)) return null;
    mkdirSync(newDir, { recursive: true });
    writeFileSync(
      join(newDir, "SKILL.md"),
      buildSkillMarkdown(newId, parsed.description, parsed.instructions, parsed.createdBy, parsed.disableModelInvocation),
      "utf8",
    );
    rmSync(oldDir, { recursive: true, force: true });
    const disabled = this.loadDisabled();
    if (disabled.delete(id)) {
      disabled.add(newId);
      this.saveDisabled(disabled);
    }
    return this.get(newId);
  }

  delete(id: string): boolean {
    const dir = join(this.dir(), basename(id));
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    const disabled = this.loadDisabled();
    if (disabled.delete(id)) this.saveDisabled(disabled);
    return true;
  }

  setEnabled(id: string, enabled: boolean): void {
    const disabled = this.loadDisabled();
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.saveDisabled(disabled);
  }
}

export const skillsStore = new SkillsStore();
