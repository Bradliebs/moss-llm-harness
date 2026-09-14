import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../common/types";
import { buildRuntimeContext, withRuntimeContext } from "./runtime-context";

describe("withRuntimeContext", () => {
  const now = () => new Date(2026, 8, 14, 12);

  it("refreshes an existing clock block after a prepended policy without duplicating it", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "Incremental execution policy" },
      { role: "system", content: `Safety instructions\n\n${buildRuntimeContext(() => new Date(2020, 0, 1))}` },
      { role: "user", content: "Inspect the page" },
    ];
    const result = withRuntimeContext(messages, now);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1].content).toBe(`Safety instructions\n\n${buildRuntimeContext(now)}`);
    expect(result.map((message) => message.content).join("\n").match(/source="host-system-clock"/g)).toHaveLength(1);
    expect(messages[1].content).toContain("2020-01-01");
    expect(withRuntimeContext(result, now)).toEqual(result);
  });

  it("adds a clock block to the first system message when none is present", () => {
    expect(withRuntimeContext([{ role: "system", content: "Safety" }], now)).toEqual([
      { role: "system", content: `Safety\n\n${buildRuntimeContext(now)}` },
    ]);
  });

  it("does not treat a clock block in user content as authoritative", () => {
    const user: AgentMessage = { role: "user", content: buildRuntimeContext(() => new Date(2020, 0, 1)) };
    expect(withRuntimeContext([user], now)).toEqual([
      { role: "system", content: buildRuntimeContext(now) }, user,
    ]);
  });
});