// electron/backend/moss/providers/sse.test.ts
//
// Unit tests for the SSE line reader. A fake reader hands back arbitrary byte
// chunks so these exercise the reader's own buffering: yielding data payloads,
// reassembling blocks split across reads, ignoring non-data lines, honoring the
// abort signal, and releasing the lock on the way out.

import { describe, expect, it } from "vitest";

import { readSSE } from "./sse";

const enc = new TextEncoder();

/** Build a fetch-body stand-in whose reader replays the given string chunks. */
function bodyOf(chunks: string[], onRelease?: () => void) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(chunks[i++]) };
        },
        releaseLock() {
          onRelease?.();
        },
      };
    },
  };
}

async function collect(body: unknown, signal: AbortSignal = new AbortController().signal) {
  const out: string[] = [];
  for await (const d of readSSE(body, signal)) out.push(d);
  return out;
}

describe("readSSE", () => {
  it("yields the payload following a data: field", async () => {
    expect(await collect(bodyOf(["data: hello\n\n"]))).toEqual(["hello"]);
  });

  it("yields multiple blocks in order", async () => {
    expect(await collect(bodyOf(["data: a\n\ndata: b\n\n"]))).toEqual(["a", "b"]);
  });

  it("reassembles a block whose payload is split across reads", async () => {
    expect(await collect(bodyOf(["data: hel", "lo\n\n"]))).toEqual(["hello"]);
  });

  it("reassembles when the block separator itself is split across reads", async () => {
    expect(await collect(bodyOf(["data: x\n", "\ndata: y\n\n"]))).toEqual(["x", "y"]);
  });

  it("ignores non-data lines within a block", async () => {
    expect(await collect(bodyOf(["event: ping\ndata: z\n\n"]))).toEqual(["z"]);
  });

  it("passes [DONE] through as a literal payload (termination is the caller's job)", async () => {
    expect(await collect(bodyOf(["data: [DONE]\n\n"]))).toEqual(["[DONE]"]);
  });

  it("yields nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect(bodyOf(["data: a\n\n"]), controller.signal)).toEqual([]);
  });

  it("stops once the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    let reads = 0;
    const body = {
      getReader() {
        return {
          async read() {
            reads++;
            if (reads === 1) {
              controller.abort();
              return { done: false, value: enc.encode("data: first\n\n") };
            }
            return { done: false, value: enc.encode("data: second\n\n") };
          },
          releaseLock() {
            /* no-op */
          },
        };
      },
    };
    expect(await collect(body, controller.signal)).toEqual([]);
  });

  it("releases the reader lock when the stream ends", async () => {
    let released = false;
    await collect(bodyOf(["data: a\n\n"], () => (released = true)));
    expect(released).toBe(true);
  });

  it.each(["\r\n", "\r", "\n"])("handles fragmented %j line endings and multiline data", async (ending) => {
    const stream = `: comment${ending}data: first${ending}data: second${ending}${ending}data: [DONE]${ending}${ending}`;
    expect(await collect(bodyOf([...stream]))).toEqual(["first\nsecond", "[DONE]"]);
  });

  it("preserves meaningful whitespace in payloads", async () => {
    expect(await collect(bodyOf(["data:  spaced  \n\n"]))).toEqual([" spaced  "]);
  });

  it("rejects oversized unterminated events", async () => {
    await expect(collect(bodyOf(["data: " + "x".repeat(1_048_577)]))).rejects.toThrow();
  });

  it("cancels a blocked reader on abort", async () => {
    const controller = new AbortController();
    let release!: (result: { done: boolean; value: undefined }) => void;
    let cancelled = false;
    const pending = collect({ getReader: () => ({
      read: () => new Promise<{ done: boolean; value: undefined }>((resolve) => { release = resolve; }),
      cancel: async () => { cancelled = true; release({ done: true, value: undefined }); },
      releaseLock: () => undefined,
    }) }, controller.signal);
    controller.abort();
    expect(await pending).toEqual([]);
    expect(cancelled).toBe(true);
  });
});
