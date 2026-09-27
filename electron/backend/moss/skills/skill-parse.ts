// electron/backend/moss/skills/skill-parse.ts
//
// Pure SKILL.md parsing + rendering helpers. No Electron imports so they are
// unit-testable. A skill file is YAML frontmatter (name, description) plus a
// markdown body that holds the full instructions.

import type { Skill } from "../../../../common/types";

export interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
  createdBy?: string;
  disableModelInvocation: boolean;
}

function stripYamlQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

/** Parse a SKILL.md document. Returns null when frontmatter or `name` is absent. */
export function parseSkillMarkdown(content: string): ParsedSkill | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const frontmatter = m[1];
  const body = m[2].trim();
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const createdByMatch = frontmatter.match(/^createdBy:\s*(.+)$/m);
  const disableModelInvocationMatch = frontmatter.match(/^disable-model-invocation:\s*(.+)$/m);
  return {
    name: stripYamlQuotes(nameMatch[1].trim()),
    description: descMatch ? stripYamlQuotes(descMatch[1].trim()) : "",
    instructions: body,
    ...(createdByMatch ? { createdBy: stripYamlQuotes(createdByMatch[1].trim()) } : {}),
    disableModelInvocation: disableModelInvocationMatch?.[1].trim().toLowerCase() === "true",
  };
}

export function setSkillCreatedBy(content: string, createdBy: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return content;
  const frontmatter = match[1].replace(/^createdBy:\s*.*\n?/m, "").trimEnd();
  return `---\n${frontmatter}\ncreatedBy: "${createdBy}"\n---\n\n${match[2].trim()}\n`;
}

/** Render a SKILL.md document from its parts. */
export function buildSkillMarkdown(
  name: string,
  description: string,
  instructions: string,
  createdBy?: string,
  disableModelInvocation = false,
): string {
  const esc = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const desc = (description.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 500);
  const body = instructions.trim() || description.trim();
  const createdByLine = createdBy ? `createdBy: ${esc(createdBy)}\n` : "";
  const invocationLine = disableModelInvocation ? "disable-model-invocation: true\n" : "";
  return `---\nname: ${esc(name)}\ndescription: ${esc(desc)}\n${createdByLine}${invocationLine}---\n\n${body}\n`;
}

/** Filesystem-safe directory/identifier derived from a user-supplied name. */
export function slugifySkillName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/** Enumerate enabled skills as a system-prompt index. Returns "" when none. */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  // Demoted skills failed under verification and stay out of the index until the user restores them.
  const enabled = skills.filter((s) => s.enabled && s.modelInvocable !== false && s.trust?.status !== "demoted");
  if (enabled.length === 0) return "";
  const lines = [
    "## Skills",
    "",
    "The following skills are available. When a request matches one, call the `m_get_skill` tool with its name to load the full instructions before acting.",
    "",
  ];
  for (const s of enabled) {
    const label = s.trust?.status === "candidate"
      ? " _(candidate: not yet verified; check its results carefully)_"
      : s.trust?.stale ? " _(stale: unused for a long time; verify before relying on it)_" : "";
    lines.push(`- **${s.name}**: ${s.description}${label}`);
  }
  return lines.join("\n");
}
