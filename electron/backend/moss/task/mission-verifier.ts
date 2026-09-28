import { readFile, stat } from "node:fs/promises";

import type { MissionEvidenceResult, MissionStepVerifier, MissionWorkerResult, MissionWorkOrder } from "./mission-controller";
import type { CriticMaterial, MissionCritic } from "./mission-critic";
import { VerificationRegistry } from "../verify/verification-registry";
import { resolveInWorkspace } from "../tools/path-guard";
import type { CriticVerificationCheck, VerificationCheck } from "../../../../common/verification";
import type { TaskSpec, VerifyConfig } from "../../../../common/types";

const MAX_CRITIC_PATHS = 5;
const MAX_FILE_BYTES = 256 * 1024;

export interface WorkspaceMissionVerifierOptions {
  workspaceRoot: string;
  registry?: VerificationRegistry;
  checks?: readonly VerificationCheck[];
  /** independent critic for criteria bound to one */
  critic?: MissionCritic;
  loadArtifact?: (taskId: string, artifactId: string) => Promise<string | null>;
}

function isCritic(check: VerificationCheck): check is CriticVerificationCheck {
  return check.kind === "critic";
}

export class WorkspaceMissionVerifier implements MissionStepVerifier {
  private readonly registry: VerificationRegistry;

  constructor(private readonly options: WorkspaceMissionVerifierOptions) {
    this.registry = options.registry ?? new VerificationRegistry();
  }

  async verify(
    order: MissionWorkOrder,
    result: MissionWorkerResult,
    signal: AbortSignal,
  ): Promise<MissionEvidenceResult[]> {
    const evidence: MissionEvidenceResult[] = [];
    for (const criterion of order.acceptanceCriteria) {
      const checks = (this.options.checks ?? []).filter((check) => check.criterionId === criterion.id);
      if (checks.length === 0) {
        evidence.push({
          criterionId: criterion.id,
          kind: "external",
          passed: false,
          summary: `No deterministic workspace verification check is bound to '${criterion.description}'; outcome remains unverified`,
        });
        continue;
      }
      const deterministic = checks.filter((check) => !isCritic(check));
      const results = deterministic.length > 0 ? await this.registry.runChecks(deterministic, this.options.workspaceRoot, signal) : [];
      const failed = results.filter((item) => !item.ok);
      const summaries = failed.length === 0
        ? results.map((item) => item.summary)
        : failed.map((item) => item.details ? `${item.summary}: ${item.details}` : item.summary);
      let criticPassed = true;
      for (const check of checks.filter(isCritic)) {
        // A critic only reviews outcomes the deterministic checks already accept.
        if (failed.length > 0 || signal.aborted) break;
        if (!this.options.critic) {
          criticPassed = false;
          summaries.push("This criterion is bound to a critic, but no critic model is configured.");
          continue;
        }
        const outcome = await this.options.critic({
          objective: order.objective,
          criterion: { id: criterion.id, description: criterion.description },
          ...(check.rubric ? { rubric: check.rubric } : {}),
          materials: await this.materials(order, result, check),
        }, signal);
        if (!outcome.passed) criticPassed = false;
        summaries.push(outcome.summary);
      }
      evidence.push({
        criterionId: criterion.id,
        kind: checks.every(isCritic) ? "model-review" : checks.every((check) => check.kind === "command") ? "command" : "external",
        passed: !signal.aborted && failed.length === 0 && criticPassed,
        summary: summaries.join("; "),
      });
    }
    return evidence;
  }

  /** What the critic may read: this step's artifacts, the artifacts it built on,
   *  and the workspace files the criterion names. */
  private async materials(order: MissionWorkOrder, result: MissionWorkerResult, check: CriticVerificationCheck): Promise<CriticMaterial[]> {
    const materials: CriticMaterial[] = result.artifacts.map((artifact) => ({ label: `Artifact "${artifact.name}"`, content: artifact.content }));
    if (this.options.loadArtifact) {
      for (const reference of order.dependencyArtifacts) {
        const content = await this.options.loadArtifact(reference.taskId, reference.id).catch(() => null);
        if (content) materials.push({ label: `Earlier artifact "${reference.name}"`, content });
      }
    }
    for (const path of (check.paths ?? []).slice(0, MAX_CRITIC_PATHS)) {
      try {
        const absolute = resolveInWorkspace(this.options.workspaceRoot, path);
        const info = await stat(absolute);
        if (!info.isFile()) {
          materials.push({ label: `File ${path}`, content: `[${path} is not a file]`, placeholder: true });
          continue;
        }
        const buffer = await readFile(absolute);
        const text = buffer.subarray(0, MAX_FILE_BYTES).toString("utf8");
        materials.push(text.includes("\u0000")
          ? { label: `File ${path}`, content: `[${path} is a binary file]`, placeholder: true }
          : { label: `File ${path}`, content: text });
      } catch (error) {
        materials.push({ label: `File ${path}`, content: `[${path} could not be read: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}]`, placeholder: true });
      }
    }
    return materials;
  }
}

export function buildMissionVerificationChecks(
  spec: TaskSpec,
  verify: VerifyConfig | undefined,
): VerificationCheck[] {
  const configuredCommands = new Set(
    verify?.enabled === true
      ? verify.commands.map((command) => command.trim()).filter(Boolean)
      : [],
  );
  const checks: VerificationCheck[] = [];
  for (const criterion of spec.acceptanceCriteria) {
    const binding = criterion.verification;
    if (!binding) {
      if (criterion.mandatory) {
        throw new Error(`Mandatory criterion '${criterion.description}' requires a verification method`);
      }
      continue;
    }
    if (binding.kind === "commands") {
      const commands = binding.commands.map((command) => command.trim()).filter(Boolean);
      if (commands.length === 0) throw new Error(`Criterion '${criterion.description}' requires a verification command`);
      for (const command of commands) {
        if (!configuredCommands.has(command)) {
          throw new Error(`Mission verification command is not enabled in Settings: ${command}`);
        }
        checks.push({
          id: `${criterion.id}-command-${checks.length + 1}`,
          criterionId: criterion.id,
          kind: "command",
          command,
        });
      }
    } else if (binding.kind === "file-exists") {
      const path = binding.path.trim();
      if (!path) throw new Error(`Criterion '${criterion.description}' requires a path`);
      checks.push({ id: `${criterion.id}-file-exists`, criterionId: criterion.id, kind: "file-exists", path });
    } else if (binding.kind === "file-contains") {
      const path = binding.path.trim();
      const substring = binding.substring.trim();
      if (!path || !substring) throw new Error(`Criterion '${criterion.description}' requires a path and expected text`);
      checks.push({
        id: `${criterion.id}-file-contains`,
        criterionId: criterion.id,
        kind: "file-contains",
        path,
        substring,
      });
    } else if (binding.kind === "critic") {
      const paths = (binding.paths ?? []).map((path) => path.trim()).filter(Boolean);
      if (paths.length > MAX_CRITIC_PATHS) throw new Error(`Criterion '${criterion.description}' can name at most ${MAX_CRITIC_PATHS} files for the critic`);
      checks.push({
        id: `${criterion.id}-critic`,
        criterionId: criterion.id,
        kind: "critic",
        ...(binding.rubric?.trim() ? { rubric: binding.rubric.trim().slice(0, 1_000) } : {}),
        ...(paths.length ? { paths } : {}),
      });
    } else {
      const url = binding.url.trim();
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported");
      } catch {
        throw new Error(`Criterion '${criterion.description}' requires a valid HTTP or HTTPS URL`);
      }
      if (
        binding.expectedStatus !== undefined
        && (!Number.isInteger(binding.expectedStatus)
          || binding.expectedStatus < 100
          || binding.expectedStatus > 599)
      ) {
        throw new Error(`Criterion '${criterion.description}' requires an HTTP status between 100 and 599`);
      }
      checks.push({
        id: `${criterion.id}-http`,
        criterionId: criterion.id,
        kind: "http",
        url,
        ...(binding.expectedStatus !== undefined ? { expectedStatus: binding.expectedStatus } : {}),
      });
    }
  }
  return checks;
}