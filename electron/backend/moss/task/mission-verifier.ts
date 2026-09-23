import type { MissionEvidenceResult, MissionStepVerifier, MissionWorkerResult, MissionWorkOrder } from "./mission-controller";
import { VerificationRegistry } from "../verify/verification-registry";
import type { VerificationCheck } from "../../../../common/verification";
import type { TaskSpec, VerifyConfig } from "../../../../common/types";

export interface WorkspaceMissionVerifierOptions {
  workspaceRoot: string;
  registry?: VerificationRegistry;
  checks?: readonly VerificationCheck[];
}

export class WorkspaceMissionVerifier implements MissionStepVerifier {
  private readonly registry: VerificationRegistry;

  constructor(private readonly options: WorkspaceMissionVerifierOptions) {
    this.registry = options.registry ?? new VerificationRegistry();
  }

  async verify(
    order: MissionWorkOrder,
    _result: MissionWorkerResult,
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
      const results = await this.registry.runChecks(checks, this.options.workspaceRoot, signal);
      const failed = results.filter((item) => !item.ok);
      evidence.push({
        criterionId: criterion.id,
        kind: checks.every((check) => check.kind === "command") ? "command" : "external",
        passed: !signal.aborted && failed.length === 0,
        summary: failed.length === 0
          ? results.map((item) => item.summary).join("; ")
          : failed.map((item) => item.details ? `${item.summary}: ${item.details}` : item.summary).join("; "),
      });
    }
    return evidence;
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