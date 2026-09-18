// electron/backend/moss/providers/sse.ts
//
// Server-Sent-Events line reader over a fetch Response body. Works against the
// undici (web) ReadableStream that Electron's global fetch returns. Yields the
// assembled data payload from each SSE event.

import { createParser } from "eventsource-parser";

/** `body` is the `ReadableStream<Uint8Array>` from a fetch Response. Typed as
 *  `unknown` and narrowed via `getReader` to avoid pulling DOM lib types into
 *  the Node-targeted main-process tsconfig. */
export async function* readSSE(body: unknown, signal: AbortSignal): AsyncGenerator<string> {
  const reader = (body as { getReader: () => ReadableStreamReader }).getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let trailingCarriageReturn = false;
  const parser = createParser({
    maxBufferSize: 1_048_576,
    onEvent: (event) => {
      if (event.data.length > 1_048_576) throw new Error("SSE event exceeds buffer limit");
      events.push(event.data);
    },
    onError: (error) => {
      if (error.type === "max-buffer-size-exceeded") throw error;
    },
  });
  const cancel = () => { void reader.cancel?.().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        parser.feed(decoder.decode() + (trailingCarriageReturn ? "\n" : ""));
        for (const event of events.splice(0)) yield event;
        break;
      }
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (text) trailingCarriageReturn = text.endsWith("\r");
        for (let offset = 0; offset < text.length; offset += 16_384) {
          parser.feed(text.slice(offset, offset + 16_384));
          for (const event of events.splice(0)) {
            if (signal.aborted) return;
            yield event;
          }
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel?.().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* stream already closed */
    }
  }
}

interface ReadableStreamReader {
  read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel?: () => Promise<void>;
  releaseLock: () => void;
}
