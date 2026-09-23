import { describe, expect, it } from "vitest";

import type { MissionAuthorizationRequest } from "../../../../common/types";
import { MissionAuthorityBroker } from "./mission-authority";

const REQUEST: MissionAuthorizationRequest = {
  objective: "Implement the feature",
  workspaceRoot: "C:\\workspace",
  acceptanceCriteria: [{
    id: "done",
    description: "The feature exists",
    mandatory: true,
    verification: { kind: "file-exists", path: "feature.ts" },
  }],
  constraints: [],
  assumptions: [],
  policy: {
    authority: "policy-scoped",
    requestedCapabilities: ["read_file", "write_file"],
    maxAutoApprovedRisk: "mutating",
    budget: { maxActions: 10 },
  },
};

describe("MissionAuthorityBroker", () => {
  it("issues scope-bound authorization that can be consumed exactly once", () => {
    const broker = new MissionAuthorityBroker();
    const authorization = broker.issue(REQUEST);

    expect(() => broker.consume(REQUEST, authorization.token)).not.toThrow();
    expect(() => broker.consume(REQUEST, authorization.token)).toThrow("already used");
  });

  it("rejects policy or scope changes after authorization", () => {
    const broker = new MissionAuthorityBroker();
    const authorization = broker.issue(REQUEST);
    const changed = { ...REQUEST, workspaceRoot: "C:\\other" };

    expect(() => broker.consume(changed, authorization.token)).toThrow("does not match");
  });

  it("rejects expired authorization", () => {
    let now = new Date("2026-08-24T00:00:00.000Z");
    const broker = new MissionAuthorityBroker({ now: () => now, ttlMs: 1_000 });
    const authorization = broker.issue(REQUEST);
    now = new Date("2026-08-24T00:00:01.000Z");

    expect(() => broker.consume(REQUEST, authorization.token)).toThrow("expired");
  });
});