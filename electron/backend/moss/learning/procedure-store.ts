// electron/backend/moss/learning/procedure-store.ts
//
// Learned procedures. When the same sequence of tools passes verification in
// three turns, the argument values that never changed become fixed and the
// ones that varied become slots. The model can then call run_procedure with
// just the slots; the runner expands it into ordinary tool calls that each go
// through the normal permission, provenance, and approval path, and stops at
// the first failed step. Trust follows host evidence: a candidate becomes
// trusted after three verified uses and is demoted after two failures in a row.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import type { Procedure, ProcedureArg, ProcedureStatus, ProcedureStep, ToolCall, ToolDefinition } from "../../../../common/types";
import { writeFileAtomic } from "../persistence/atomic-file";
import type { Tool } from "../tools/types";

export const RUN_PROCEDURE = "run_procedure";
export const PROCEDURE_HINT = "Learned procedures are available through run_procedure. When one matches the task, use it: it repeats steps that passed verification in your earlier work, including ones that are easy to forget.";
const EXAMPLES_TO_LEARN = 3;
const USES_TO_TRUST = 3;
const FAILURES_TO_DEMOTE = 2;
const MAX_STEPS = 8;
const MAX_LITERAL = 300;
const MAX_PENDING = 200;
const MAX_PROCEDURES = 50;
/** Tools that never become part of a procedure. */
const EXCLUDED = new Set([RUN_PROCEDURE, "plan", "working_state", "find_tool", "delegate", "m_remember", "m_forget", "send_email"]);

export interface ObservedCall {
  name: string;
  arguments: string;
}

interface Example {
  request: string;
  /** per step: argument name to canonical value (JSON, or #hash for long values) */
  steps: Array<Record<string, string>>;
}

interface PendingPattern {
  signature: string;
  examples: Example[];
}

interface StoreFile {
  schemaVersion: 1;
  procedures: Procedure[];
  pending: PendingPattern[];
}

function canonical(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= MAX_LITERAL ? json : `#${createHash("sha256").update(json).digest("hex").slice(0, 16)}`;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function signatureOf(calls: readonly ObservedCall[]): string {
  return calls.map((call) => call.name).join(">");
}

/** Generalize three or more examples of one tool sequence into steps with slots. */
export function minePattern(examples: readonly Example[], tools: readonly string[]): { steps: ProcedureStep[]; slots: Procedure["slots"] } | undefined {
  if (examples.length < EXAMPLES_TO_LEARN) return undefined;
  const first = examples[0];
  const keysMatch = first.steps.every((step, index) => examples.every((example) => {
    const keys = Object.keys(example.steps[index] ?? {}).sort().join(",");
    return keys === Object.keys(step).sort().join(",");
  }));
  if (!keysMatch) return undefined;
  const slotByVector = new Map<string, string>();
  const slots: Procedure["slots"] = [];
  let constants = 0;
  let sharedSlots = 0;
  const steps: ProcedureStep[] = first.steps.map((step, index) => ({
    tool: tools[index],
    args: Object.fromEntries(Object.keys(step).map((key): [string, ProcedureArg] => {
      const values = examples.map((example) => example.steps[index][key]);
      if (values.every((value) => value === values[0]) && !values[0].startsWith("#")) {
        constants += 1;
        return [key, { const: JSON.parse(values[0]) }];
      }
      const vector = values.join("\u0000");
      const existing = slotByVector.get(vector);
      if (existing) {
        sharedSlots += 1;
        return [key, { slot: existing }];
      }
      let name = key;
      for (let suffix = 2; slots.some((slot) => slot.name === name); suffix++) name = `${key}_${suffix}`;
      slotByVector.set(vector, name);
      const example = values.find((value) => !value.startsWith("#"));
      slots.push({ name, example: example ? String(JSON.parse(example)).slice(0, 120) : "(long text)" });
      return [key, { slot: name }];
    })),
  }));
  // A procedure worth keeping fixes something or ties steps together.
  return constants > 0 || sharedSlots > 0 ? { steps, slots } : undefined;
}

export function expandProcedure(procedure: Procedure, slots: Record<string, unknown>): { calls: ToolCall[] } | { error: string } {
  const missing = procedure.slots.filter((slot) => slots[slot.name] === undefined || slots[slot.name] === null).map((slot) => slot.name);
  if (missing.length > 0) return { error: `run_procedure ${procedure.id} needs slots: ${missing.join(", ")}. Expected: ${procedure.slots.map((slot) => slot.name).join(", ")}.` };
  return {
    calls: procedure.steps.map((step, index) => ({
      id: `proc-${procedure.id.slice(0, 8)}-${index}-${randomUUID().slice(0, 8)}`,
      name: step.tool,
      arguments: JSON.stringify(Object.fromEntries(Object.entries(step.args).map(([key, arg]) => [key, "slot" in arg ? slots[arg.slot] : arg.const]))),
    })),
  };
}

export function describeStep(step: ProcedureStep): string {
  const parts = Object.entries(step.args).map(([key, arg]) => "slot" in arg ? `${key}=<${arg.slot}>` : `${key}=${JSON.stringify(arg.const).slice(0, 40)}`);
  return `${step.tool}(${parts.join(", ")})`;
}

export function procedureToolDefinition(procedures: readonly Procedure[]): ToolDefinition {
  return {
    name: RUN_PROCEDURE,
    description: [
      "Run a learned procedure: a tool sequence that passed verification in earlier turns. You supply only the slots; the steps run in order, each with the usual approvals, and the run stops at the first failed step so you can continue by hand.",
      ...procedures.map((procedure) => `- ${procedure.id}${procedure.status === "candidate" ? " (unproven)" : ""}: ${procedure.description} Steps: ${procedure.steps.map(describeStep).join(" -> ")}. Slots: ${procedure.slots.map((slot) => `${slot.name} (e.g. ${slot.example})`).join(", ") || "none"}.`),
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        procedure: { type: "string", enum: procedures.map((procedure) => procedure.id) },
        slots: { type: "object", description: "Slot values by name." },
      },
      required: ["procedure", "slots"],
    },
  };
}

/** Placeholder so the registry knows the tool; the runner expands calls to it. */
export const runProcedureTool: Tool = {
  name: RUN_PROCEDURE,
  description: "Run a learned procedure.",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { ok: false, content: "run_procedure is expanded by the harness and cannot run directly." };
  },
};

export class ProcedureStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir?: string, private readonly now: () => Date = () => new Date()) {}

  private file(): string {
    return join(this.baseDir ?? userDataDir(), "learning", "procedures.json");
  }

  private async read(): Promise<StoreFile> {
    try {
      const value = JSON.parse(await readFile(this.file(), "utf8")) as Partial<StoreFile>;
      return { schemaVersion: 1, procedures: Array.isArray(value.procedures) ? value.procedures : [], pending: Array.isArray(value.pending) ? value.pending : [] };
    } catch {
      return { schemaVersion: 1, procedures: [], pending: [] };
    }
  }

  private mutate<T>(change: (state: StoreFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const result = change(state);
      await writeFileAtomic(this.file(), JSON.stringify(state, null, 2));
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(): Promise<Procedure[]> {
    await this.queue;
    return (await this.read()).procedures;
  }

  async offered(): Promise<Procedure[]> {
    return (await this.list()).filter((procedure) => procedure.status !== "demoted");
  }

  /** Record the successful tool calls of a verified turn; returns a procedure when this example completes one. */
  observe(request: string, calls: readonly ObservedCall[]): Promise<Procedure | undefined> {
    const usable = calls.filter((call) => !EXCLUDED.has(call.name));
    if (usable.length < 2 || usable.length > MAX_STEPS) return Promise.resolve(undefined);
    const parsed = usable.map((call) => parseArgs(call.arguments));
    if (parsed.some((args) => args === null)) return Promise.resolve(undefined);
    const signature = signatureOf(usable);
    const example: Example = { request: request.slice(0, 200), steps: parsed.map((args) => Object.fromEntries(Object.entries(args!).map(([key, value]) => [key, canonical(value)]))) };
    return this.mutate((state) => {
      let pending = state.pending.find((item) => item.signature === signature);
      if (!pending) {
        pending = { signature, examples: [] };
        state.pending.unshift(pending);
        state.pending = state.pending.slice(0, MAX_PENDING);
      }
      pending.examples = [...pending.examples, example].slice(-EXAMPLES_TO_LEARN);
      if (state.procedures.some((procedure) => procedure.steps.map((step) => step.tool).join(">") === signature && procedure.status !== "demoted")) return undefined;
      const mined = minePattern(pending.examples, usable.map((call) => call.name));
      if (!mined) return undefined;
      const now = this.now().toISOString();
      const procedure: Procedure = {
        id: `p-${createHash("sha256").update(signature + JSON.stringify(mined.steps)).digest("hex").slice(0, 8)}`,
        name: usable.map((call) => call.name).join(" → "),
        description: `Learned from verified turns such as "${pending.examples[0].request.slice(0, 100)}".`,
        steps: mined.steps,
        slots: mined.slots,
        status: "candidate",
        learnedFrom: pending.examples.length,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      };
      state.procedures = [procedure, ...state.procedures.filter((item) => item.id !== procedure.id)].slice(0, MAX_PROCEDURES);
      state.pending = state.pending.filter((item) => item.signature !== signature);
      return procedure;
    });
  }

  /** Host evidence for procedures used in a settled turn. */
  recordOutcome(ids: readonly string[], outcome: "success" | "failure" | "used"): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.mutate((state) => {
      const now = this.now().toISOString();
      for (const procedure of state.procedures) {
        if (!ids.includes(procedure.id)) continue;
        procedure.lastUsedAt = now;
        procedure.updatedAt = now;
        if (outcome === "success") {
          procedure.successCount += 1;
          procedure.consecutiveFailures = 0;
          if (procedure.status === "candidate" && procedure.successCount >= USES_TO_TRUST) procedure.status = "trusted";
        } else if (outcome === "failure") {
          procedure.failureCount += 1;
          procedure.consecutiveFailures += 1;
          if (procedure.consecutiveFailures >= FAILURES_TO_DEMOTE) procedure.status = "demoted";
        }
      }
    });
  }

  setStatus(id: string, status: ProcedureStatus): Promise<Procedure | undefined> {
    return this.mutate((state) => {
      const procedure = state.procedures.find((item) => item.id === id);
      if (!procedure) return undefined;
      procedure.status = status;
      procedure.consecutiveFailures = 0;
      procedure.updatedAt = this.now().toISOString();
      return procedure;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((state) => {
      state.procedures = state.procedures.filter((item) => item.id !== id);
    });
  }
}

export const procedureStore = new ProcedureStore();
