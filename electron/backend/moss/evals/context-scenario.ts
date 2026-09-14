import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "../../../../common/evals";
import type { AgentMessage } from "../../../../common/types";
import type { RunTurnOptions } from "../agent-runner";
import { TaskEngine } from "../task/task-engine";
import { TaskStore } from "../task/task-store";
import { buildTaskProgressPacket, renderTaskProgressPacket, selectDependencyReadyStep } from "../task/progress-packet";

export const CONTEXT_STATE_VALUE = "shipment-cedar-7419";
export const CONTEXT_STATE_PATH = "durable-state.txt";

export interface ContextScenarioSetup {
  messages: AgentMessage[];
  options: Pick<RunTurnOptions, "contextLimit" | "completionGuard">;
}

export interface ResumeScenarioSetup extends ContextScenarioSetup {
  checkpoint: { root: string; taskId: string };
  dispose(): Promise<void>;
}

export function createContextScenarioSetup(testCase: EvalCase, messages: AgentMessage[]): ContextScenarioSetup | undefined {
  if (testCase.family !== "context-pressure") return undefined;
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const request = messages.slice(system.length);
  return {
    messages: [
      ...system,
      { role: "user", content: "Inspect the previous shipment state. " + "Historical work completed. ".repeat(400) },
      { role: "assistant", content: "Reading the shipment state.", toolCalls: [{ id: "historical-state", name: "read_file", arguments: JSON.stringify({ path: CONTEXT_STATE_PATH }) }] },
      { role: "tool", toolCallId: "historical-state", content: CONTEXT_STATE_VALUE },
      { role: "assistant", content: "The inspection finished. " + "Archived progress. ".repeat(400) },
      ...request,
    ],
    options: { contextLimit: 2_048 },
  };
}

export async function createResumeScenarioSetup(
  testCase: EvalCase,
  workspaceRoot: string,
  messages: AgentMessage[],
): Promise<ResumeScenarioSetup | undefined> {
  if (testCase.family !== "resume-checkpoint") return undefined;
  const root = await mkdtemp(join(tmpdir(), "moss-context-checkpoint-"));
  const taskId = "context-resume";
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const prepared = await readFile(join(workspaceRoot, "prepared.txt"), "utf8");
    const engine = new TaskEngine(new TaskStore(root));
    await engine.create(testCase.task, taskId);
    await engine.setPlan(taskId, [
      { id: "prepare", description: "Prepare the shipment in prepared.txt", state: "pending", dependsOn: [], requiredCapabilities: ["write_file"] },
      { id: "deliver", description: "Read prepared.txt and write delivered.txt as 'Delivered: <prepared trimmed>' followed by a newline, using the trimmed contents of prepared.txt. Do not repeat prepare or change prepared.txt.", state: "pending", dependsOn: ["prepare"], requiredCapabilities: ["read_file", "write_file"] },
    ]);
    const prior = await engine.beginAttempt(taskId, "prepare", "prepared-turn");
    await engine.finishAttempt(taskId, prior.attempt.id, "succeeded");
    if (testCase.perturbation?.class === "interruption") {
      await engine.beginAttempt(taskId, "deliver", "interrupted-turn");
    } else {
      await engine.pause(taskId, "Preparation completed; delivery deliberately paused.");
    }
    const restoredStore = new TaskStore(root);
    const restoredEngine = new TaskEngine(restoredStore);
    await restoredEngine.recoverInterruptedTasks();
    const restored = await restoredStore.get(taskId);
    if (!restored) throw new Error("Durable resume fixture could not be reloaded");
    const next = selectDependencyReadyStep(restored);
    if (next?.id !== "deliver") throw new Error("Durable resume fixture selected an unexpected next step");
    const packet = renderTaskProgressPacket(buildTaskProgressPacket(restored));
    const resumed = await restoredEngine.beginAttempt(taskId, next.id, "resumed-turn");
    let accepted = false;
    return {
      messages: messages[0]?.role === "system"
        ? [{ ...messages[0], content: `${messages[0].content}\n\n${packet}` }, ...messages.slice(1)]
        : [{ role: "system", content: packet }, ...messages],
      options: {
        completionGuard: async () => {
          let delivered: string;
          try {
            delivered = await readFile(join(workspaceRoot, "delivered.txt"), "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return { accept: false, feedback: "The current step requires delivered.txt; finish the file operation before claiming success." };
          }
          if (delivered !== `Delivered: ${prepared.trim()}\n` || await readFile(join(workspaceRoot, "prepared.txt"), "utf8") !== prepared) {
            return { accept: false, feedback: "Preserve prepared.txt and write delivered.txt as 'Delivered: <prepared trimmed>' followed by a newline, using the trimmed contents of prepared.txt." };
          }
          if (!accepted) await restoredEngine.finishAttempt(taskId, resumed.attempt.id, "succeeded");
          accepted = true;
          return { accept: true };
        },
      },
      checkpoint: { root, taskId },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}