import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_REDIRECTS = 5;
/** Largest response body read into memory; tools show far less than this. */
const MAX_BODY_BYTES = 5 * 1_048_576;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

export interface OutboundHttpResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OutboundHttpDependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<RawHttpResponse>;
  beforeRequest?: (url: URL) => Promise<void>;
}

export async function fetchPublicUrl(
  rawUrl: string,
  signal: AbortSignal,
  dependencies: OutboundHttpDependencies = {},
): Promise<OutboundHttpResponse> {
  const resolve = dependencies.resolve ?? resolveHost;
  const request = dependencies.request ?? requestPinned;
  let current = parseHttpUrl(rawUrl);

  for (let redirects = 0; ; redirects += 1) {
    const addresses = await resolvePublicAddresses(current.hostname, resolve, signal);
    await dependencies.beforeRequest?.(current);
    const response = await request(current, addresses[0], signal);
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return {
        ok: response.status >= 200 && response.status < 300,
        ...response,
        finalUrl: current.toString(),
      };
    }
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    current = parseHttpUrl(new URL(location, current).toString());
  }
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
  return url;
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family: resolvedFamily }) => ({
    address,
    family: resolvedFamily === 6 ? 6 : 4,
  }));
}

async function resolvePublicAddresses(
  hostname: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await abortable(resolve(hostname), signal);
    } catch (error) {
      throw new Error(`DNS resolution failed for ${hostname}: ${(error as Error).message}`);
    }
  }
  if (addresses.length === 0) throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  for (const address of addresses) {
    const family = isIP(address.address);
    const blocked = family === 4
      ? blockedIpv4.check(address.address, "ipv4")
      : family === 6 && blockedIpv6.check(address.address, "ipv6");
    if (family !== address.family || blocked) {
      throw new Error(`Refusing non-public destination ${address.address}`);
    }
  }
  return addresses;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
}

export function requestPinned(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<RawHttpResponse> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
      signal,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      const finish = (): void => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
        }
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers, body: truncated ? `${body}\n\n[Moss stopped reading after ${MAX_BODY_BYTES / 1_048_576} MB.]` : body });
      };
      // A page larger than any tool could show is cut off rather than held in memory.
      response.on("data", (chunk: Buffer | string) => {
        if (truncated) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const room = MAX_BODY_BYTES - received;
        chunks.push(buffer.length > room ? buffer.subarray(0, room) : buffer);
        received += Math.min(buffer.length, room);
        if (received >= MAX_BODY_BYTES) {
          truncated = true;
          response.destroy();
          finish();
        }
      });
      response.on("end", () => {
        if (!truncated) finish();
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}