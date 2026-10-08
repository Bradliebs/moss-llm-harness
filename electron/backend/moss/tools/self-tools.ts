// electron/backend/moss/tools/self-tools.ts
//
// Self-management tools: the model's interface to its own durable memory and the
// installed skills. These operate on the process-wide stores and ignore the
// workspace sandbox (they touch app data, not user files).

import type { MemoryCategory } from "../../../../common/types";
import { memoryReviewQueue } from "../governed/review-queue";
import { memoryStore } from "../memory/memory-store";
import { slugifySkillName } from "../skills/skill-parse";
import { skillsStore } from "../skills/skills-store";
import { skillLedger } from "../skills/skill-ledger";
import type { Tool } from "./types";

const CATEGORIES: readonly MemoryCategory[] = ["preference", "fact", "decision", "context"];

export const rememberTool: Tool = {
  name: "m_remember",
  description: "Store a durable fact, preference, or decision for future sessions.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The thing to remember (max 500 chars)." },
      category: {
        type: "string",
        enum: CATEGORIES as unknown as string[],
      },
    },
    required: ["fact"],
  },
  async execute(args, ctx) {
    const fact = String(args.fact ?? "");
    const category = CATEGORIES.includes(args.category as MemoryCategory)
      ? (args.category as MemoryCategory)
      : "fact";
    // When gated memory is on, stage the write for human review rather than
    // committing it, so the agent cannot silently persist facts.
    if (ctx.gatedMemory) {
      const pending = memoryReviewQueue.enqueue(fact, category, "assistant");
      return pending
        ? {
            ok: true,
            content: `Queued for your review (${pending.category}): ${pending.fact}. It will be saved to memory only after you approve it in Settings.`,
          }
        : { ok: false, content: "Nothing to remember -- the fact was empty." };
    }
    const entry = memoryStore.add(fact, category, "assistant");
    return entry
      ? { ok: true, content: `Remembered (${entry.category}): ${entry.fact}` }
      : { ok: false, content: "Nothing to remember -- the fact was empty." };
  },
};

export const recallTool: Tool = {
  name: "m_recall",
  description: "Search remembered facts by keyword.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords to search for." } },
    required: ["query"],
  },
  async execute(args) {
    const results = memoryStore.recall(String(args.query ?? ""), 20, 2);
    if (results.length === 0) return { ok: true, content: "No matching memories." };
    return { ok: true, content: results.map((m) => `[${m.category}|${m.id}] ${m.fact}`).join("\n") };
  },
};

export const forgetTool: Tool = {
  name: "m_forget",
  description: "Delete a remembered fact by its id (as shown by m_recall).",
  parameters: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(args) {
    const ok = memoryStore.delete(String(args.id ?? ""));
    return { ok, content: ok ? "Forgotten." : "No memory with that id." };
  },
};

export const listMemoriesTool: Tool = {
  name: "m_list_memories",
  description: "List all remembered facts. Unlike m_recall, this is not query-scoped.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const entries = memoryStore.list();
    if (entries.length === 0) return { ok: true, content: "No memories stored." };
    return { ok: true, content: entries.map((m) => `[${m.category}|${m.id}] ${m.fact}`).join("\n") };
  },
};

export const listSkillsTool: Tool = {
  name: "m_list_skills",
  description: "List the available skills and their descriptions.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const skills = skillsStore.list().filter((s) => s.enabled && s.modelInvocable !== false);
    if (skills.length === 0) return { ok: true, content: "No skills available." };
    return { ok: true, content: skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") };
  },
};

export const getSkillTool: Tool = {
  name: "m_get_skill",
  description: "Load the full instructions for a skill by name before using it.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  async execute(args) {
    const requested = String(args.name ?? "");
    const skill = skillsStore.get(requested);
    if (!skill || !skill.enabled) return { ok: false, content: `No enabled skill named '${requested}'.` };
    const trust = skillLedger.sync(skillsStore.list()).find((item) => item.id === skill.id)?.trust;
    if (trust?.status === "demoted") {
      return { ok: false, content: `Skill '${skill.name}' was demoted (${trust.statusReason}). The user can restore it in the Library; do not rely on it until then.` };
    }
    const resources = skillsStore.listResources(skill.id);
    const resourceNote = resources.length > 0
      ? `\n\nSupporting resources (load with m_get_skill_resource):\n${resources.map((path) => `- ${path}`).join("\n")}`
      : "";
    return { ok: true, content: `${skill.instructions || skill.description}${resourceNote}` };
  },
};

export const getSkillResourceTool: Tool = {
  name: "m_get_skill_resource",
  description: "Read a supporting text resource from an enabled skill after loading its main instructions.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Enabled skill name." },
      path: { type: "string", description: "Resource path listed by m_get_skill." },
    },
    required: ["name", "path"],
  },
  async execute(args) {
    const requested = String(args.name ?? "");
    const skill = skillsStore.get(requested);
    if (!skill || !skill.enabled) return { ok: false, content: `No enabled skill named '${requested}'.` };
    const path = String(args.path ?? "");
    const content = skillsStore.readResource(skill.id, path);
    if (content === null) return { ok: false, content: `No readable resource '${path}' in skill '${requested}'.` };
    return { ok: true, content };
  },
};

// The three authoring tools below mutate the on-disk skills store, whose enabled
// entries are injected into the system prompt. They are deliberately absent from
// permission.ts AUTO_ALLOW, so each call is approval-gated (mutating tier) unless
// the user has turned auto-approve on, matching write_file's contract.
export const createSkillTool: Tool = {
  name: "m_create_skill",
  description:
    "Create a new skill (a reusable instruction sheet) for future sessions. Fails if a skill with that name already exists -- use m_update_skill to change one. Requires user approval.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short skill name; becomes its identifier." },
      description: { type: "string", description: "One line on when to use the skill (max 500 chars)." },
      instructions: { type: "string", description: "The full step-by-step instructions for the skill." },
    },
    required: ["name", "description", "instructions"],
  },
  async execute(args) {
    const slug = slugifySkillName(String(args.name ?? ""));
    if (!slug) return { ok: false, content: "A skill name with at least one letter or digit is required." };
    if (skillsStore.get(slug)) {
      return { ok: false, content: `A skill named '${slug}' already exists. Use m_update_skill to change it.` };
    }
    const skill = skillsStore.create(slug, String(args.description ?? ""), String(args.instructions ?? ""), "agent");
    // Agent-authored skills start disabled so a human enables them in the
    // Library before their instructions can enter the system prompt.
    skillsStore.setEnabled(skill.id, false);
    return { ok: true, content: `Created skill '${skill.name}'. It is disabled until you enable it in the Library.` };
  },
};

export const updateSkillTool: Tool = {
  name: "m_update_skill",
  description:
    "Update an existing skill's description and/or instructions. Fails if no such skill exists. Requires user approval.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", description: "New description (optional; unchanged if omitted)." },
      instructions: { type: "string", description: "New instructions (optional; unchanged if omitted)." },
    },
    required: ["name"],
  },
  async execute(args) {
    const slug = slugifySkillName(String(args.name ?? ""));
    const existing = slug ? skillsStore.get(slug) : null;
    if (!existing) {
      return { ok: false, content: `No skill named '${String(args.name ?? "")}'. Use m_create_skill to add it.` };
    }
    const hasDesc = typeof args.description === "string";
    const hasInstr = typeof args.instructions === "string";
    if (!hasDesc && !hasInstr) {
      return { ok: false, content: "Nothing to update -- provide a new description or instructions." };
    }
    // create() upserts by slug, so re-creating with the same slug overwrites the
    // SKILL.md in place; the disabled.json entry is untouched, so enablement is
    // preserved across the update.
    const description = hasDesc ? String(args.description) : existing.description;
    const instructions = hasInstr ? String(args.instructions) : existing.instructions;
    // An agent rewrite is a new, unproven version: it returns to candidate status.
    skillLedger.noteEdit(existing.id, "agent");
    skillsStore.create(existing.name, description, instructions, existing.createdBy);
    skillLedger.sync(skillsStore.list());
    return { ok: true, content: `Updated skill '${existing.name}'. The new version is a candidate until it passes verification again.` };
  },
};

export const deleteSkillTool: Tool = {
  name: "m_delete_skill",
  description: "Delete a skill by name. Requires user approval.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  async execute(args) {
    const slug = slugifySkillName(String(args.name ?? ""));
    const existing = slug ? skillsStore.get(slug) : null;
    if (!existing) return { ok: false, content: `No skill named '${String(args.name ?? "")}'.` };
    const ok = skillsStore.delete(existing.id);
    return { ok, content: ok ? `Deleted skill '${existing.name}'.` : `Could not delete '${existing.name}'.` };
  },
};

export const SELF_TOOLS: Tool[] = [
  rememberTool,
  recallTool,
  forgetTool,
  listMemoriesTool,
  listSkillsTool,
  getSkillTool,
  getSkillResourceTool,
  createSkillTool,
  updateSkillTool,
  deleteSkillTool,
];
