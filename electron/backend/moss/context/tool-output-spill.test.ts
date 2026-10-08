import { describe, expect, it } from "vitest";

import { exceedsInlineLimit, spillPreview } from "./tool-output-spill";

describe("tool output spill preview", () => {
  it("keeps the full replacement within 8000 UTF-8 bytes", () => {
    const preview = spillPreview("🙂".repeat(5000), "00000000-0000-4000-8000-000000000000");

    expect(exceedsInlineLimit("🙂".repeat(5000))).toBe(true);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(8000);
    expect(preview).not.toContain("�");
    expect(preview).toContain("bytes omitted");
    expect(preview).toContain("read_tool_output");
  });

  it("spills and previews at a lower limit for a small context window", () => {
    const text = "y".repeat(5_000);
    expect(exceedsInlineLimit(text)).toBe(false);
    expect(exceedsInlineLimit(text, 3_000)).toBe(true);
    const preview = spillPreview(text, "art-1", 3_000);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(3_000);
    expect(preview).toContain("art-1");
    expect(exceedsInlineLimit("z".repeat(9_000), 20_000)).toBe(true);
  });

  it("does not classify an exactly 8000-byte result as oversized", () => {
    expect(exceedsInlineLimit("x".repeat(8000))).toBe(false);
    expect(exceedsInlineLimit("x".repeat(8001))).toBe(true);
  });
});