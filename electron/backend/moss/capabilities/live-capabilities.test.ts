import { describe, expect, it } from "vitest";

import type { Tool } from "../tools/types";
import { routeLiveCapabilities } from "./live-capabilities";

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ ok: true, content: "ok" }),
});

describe("routeLiveCapabilities", () => {
  it("filters known credential-dependent capabilities until configured", () => {
    const route = routeLiveCapabilities(
      [{ source: "built-in", tools: [tool("read_file"), tool("send_email")] }],
      {},
      "win32",
    );

    expect(route.tools.map((item) => item.name)).toEqual(["read_file"]);
    expect(route.unmet.join(" ")).toContain("requires credentials: email");
  });

  it("filters desktop capabilities on unsupported platforms", () => {
    const route = routeLiveCapabilities(
      [{ source: "desktop", tools: [tool("desktop_inspect")] }],
      {},
      "linux",
    );

    expect(route.tools).toEqual([]);
    expect(route.unmet.join(" ")).toContain("does not support platform linux");
  });

  it("returns configured capabilities with their executable tool identity", () => {
    const email = tool("send_email");
    const route = routeLiveCapabilities(
      [{ source: "built-in", tools: [email] }],
      { email: { apiKey: "secret", from: "sender@example.com" } },
      "win32",
    );

    expect(route.tools).toEqual([email]);
    expect(route.unmet).toEqual([]);
  });

  it("offers send_email for a complete SMTP account and withholds it for an incomplete one", () => {
    const email = tool("send_email");
    const smtp = { host: "smtp.gmail.com", port: 465, user: "me@gmail.com", pass: "app pass" };
    const configured = routeLiveCapabilities(
      [{ source: "built-in", tools: [email] }],
      { email: { provider: "smtp", apiKey: "", from: "", smtp } },
      "win32",
    );
    const missingPassword = routeLiveCapabilities(
      [{ source: "built-in", tools: [email] }],
      { email: { provider: "smtp", apiKey: "", from: "", smtp: { ...smtp, pass: " " } } },
      "win32",
    );

    expect(configured.tools).toEqual([email]);
    expect(missingPassword.tools).toEqual([]);
  });
});