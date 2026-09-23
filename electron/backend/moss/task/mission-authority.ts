import { createHash, randomUUID } from "node:crypto";

import type { MissionAuthorization, MissionAuthorizationRequest, TaskBudget } from "../../../../common/types";

const BUDGET_FIELDS = ["maxDurationMs", "maxTokens", "maxActions", "maxCostUsd"] as const;

interface MissionAuthorityBrokerOptions {
  now?: () => Date;
  ttlMs?: number;
}

interface PendingAuthorization {
  fingerprint: string;
  expiresAt: string;
}

export class MissionAuthorityBroker {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: MissionAuthorityBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  }

  issue(request: MissionAuthorizationRequest): MissionAuthorization {
    validateMissionAuthorizationRequest(request);
    this.prune();
    const token = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    this.pending.set(token, { fingerprint: fingerprint(request), expiresAt });
    return { token, expiresAt };
  }

  consume(request: MissionAuthorizationRequest, token: string): void {
    const pending = this.pending.get(token);
    if (!pending) throw new Error("Mission authorization is missing, expired, or already used");
    this.pending.delete(token);
    if (new Date(pending.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error("Mission authorization has expired");
    }
    if (pending.fingerprint !== fingerprint(request)) {
      throw new Error("Mission authorization does not match the requested authority or scope");
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [token, pending] of this.pending) {
      if (new Date(pending.expiresAt).getTime() <= now) this.pending.delete(token);
    }
  }
}

export function validateMissionAuthorizationRequest(request: MissionAuthorizationRequest): void {
  if (!request.objective.trim()) throw new Error("Mission authorization requires an objective");
  if (!request.acceptanceCriteria.some((criterion) => criterion.mandatory)) {
    throw new Error("Mission authorization requires a mandatory acceptance criterion");
  }
  for (const criterion of request.acceptanceCriteria.filter((item) => item.mandatory)) {
    if (!criterion.id.trim() || !criterion.description.trim()) {
      throw new Error("Mission authorization criteria require identifiers and measurable outcomes");
    }
    if (!criterion.verification) {
      throw new Error("Mission authorization criteria require verification methods");
    }
  }
  if (request.policy.authority !== "policy-scoped") {
    throw new Error("Only policy-scoped missions require elevated authorization");
  }
  const capabilities = request.policy.requestedCapabilities.map((value) => value.trim());
  if (capabilities.some((value) => !value) || new Set(capabilities).size !== capabilities.length) {
    throw new Error("Mission authorization capabilities must be unique and non-empty");
  }
  validateBudget(request.policy.budget);
}

function validateBudget(budget: TaskBudget | undefined): void {
  for (const field of BUDGET_FIELDS) {
    const value = budget?.[field];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error("Mission authorization budgets must be positive finite numbers");
    }
  }
}

function fingerprint(request: MissionAuthorizationRequest): string {
  const normalized = {
    objective: request.objective.trim(),
    workspaceRoot: request.workspaceRoot?.trim() ?? "",
    acceptanceCriteria: request.acceptanceCriteria.map((criterion) => ({
      id: criterion.id.trim(),
      description: criterion.description.trim(),
      mandatory: criterion.mandatory,
      verification: criterion.verification,
    })),
    constraints: request.constraints.map((value) => value.trim()),
    assumptions: request.assumptions.map((value) => value.trim()),
    policy: {
      authority: request.policy.authority,
      requestedCapabilities: request.policy.requestedCapabilities.map((value) => value.trim()).sort(),
      maxAutoApprovedRisk: request.policy.maxAutoApprovedRisk,
      budget: request.policy.budget ?? {},
    },
    scopes: {
      browserDomains: [...(request.automation?.browserAllowedDomains ?? [])].sort(),
      desktopProcesses: [...(request.automation?.desktopAllowedProcesses ?? [])].sort(),
      desktopWindows: [...(request.automation?.desktopAllowedWindows ?? [])].sort(),
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}