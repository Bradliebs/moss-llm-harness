import * as https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPublicUrl, type OutboundHttpDependencies } from "./outbound-http";

vi.mock("node:https", () => ({ request: vi.fn() }));

const signal = new AbortController().signal;
const publicAddress = { address: "93.184.216.34", family: 4 as const };

afterEach(() => vi.restoreAllMocks());

function dependencies(overrides: OutboundHttpDependencies = {}): OutboundHttpDependencies {
  return {
    resolve: vi.fn(async () => [publicAddress]),
    request: vi.fn(async () => ({ status: 200, headers: {}, body: "ok" })),
    ...overrides,
  };
}

describe("fetchPublicUrl", () => {
  it.each([true, false])("returns the pinned lookup shape for all=%s", async (all) => {
    const callback = vi.fn();
    vi.mocked(https.request).mockImplementation((_url, options) => {
      if (typeof options !== "object" || !options.lookup) throw new Error("Missing pinned lookup");
      options.lookup("example.com", { all }, callback);
      throw new Error("transport intercepted");
    });
    await expect(fetchPublicUrl("https://example.com", signal, {
      resolve: async () => [publicAddress],
    })).rejects.toThrow("transport intercepted");
    if (all) expect(callback).toHaveBeenCalledWith(null, [publicAddress]);
    else expect(callback).toHaveBeenCalledWith(null, publicAddress.address, publicAddress.family);
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"])(
    "rejects non-public destination %s before requesting it",
    async (address) => {
      const request = vi.fn(async () => ({ status: 200, headers: {}, body: "unsafe" }));
      const deps = dependencies({
        resolve: vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]),
        request,
      });
      await expect(fetchPublicUrl("https://example.com", signal, deps)).rejects.toThrow(/non-public destination/);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects a mixed public and private DNS answer", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "unsafe" }));
    const deps = dependencies({
      resolve: vi.fn(async () => [publicAddress, { address: "10.0.0.1", family: 4 }]),
      request,
    });
    await expect(fetchPublicUrl("https://example.com", signal, deps)).rejects.toThrow(/10\.0\.0\.1/);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the validated DNS address into the request", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "safe" }));
    const result = await fetchPublicUrl("https://example.com/path", signal, dependencies({ request }));
    expect(result.body).toBe("safe");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ hostname: "example.com" }), publicAddress, signal);
  });

  it("revalidates a redirect target before making the redirected request", async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: "http://127.0.0.1/admin" }, body: "" }));
    const deps = dependencies({ request });
    await expect(fetchPublicUrl("https://example.com", signal, deps)).rejects.toThrow(/non-public destination/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect and returns the final URL", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: { location: "https://cdn.example.com/page" }, body: "" })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: "redirected" });
    const result = await fetchPublicUrl("https://example.com", signal, dependencies({ request }));
    expect(result.body).toBe("redirected");
    expect(result.finalUrl).toBe("https://cdn.example.com/page");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("caps redirect chains", async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: "/again" }, body: "" }));
    await expect(fetchPublicUrl("https://example.com", signal, dependencies({ request }))).rejects.toThrow(
      /Too many redirects/,
    );
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("stops waiting for DNS when the turn is aborted", async () => {
    const controller = new AbortController();
    const neverResolves = new Promise<never>(() => {});
    const pending = fetchPublicUrl("https://example.com", controller.signal, dependencies({
      resolve: vi.fn(() => neverResolves),
    }));
    controller.abort(new Error("turn aborted"));
    await expect(pending).rejects.toThrow(/turn aborted/);
  });

  it("rejects embedded credentials", async () => {
    const request = vi.fn();
    await expect(fetchPublicUrl("https://user:pass@example.com", signal, dependencies({ request }))).rejects.toThrow(
      /embedded credentials/,
    );
    expect(request).not.toHaveBeenCalled();
  });
});