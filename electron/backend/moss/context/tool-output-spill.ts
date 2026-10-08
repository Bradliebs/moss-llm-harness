const INLINE_BYTES = 8_000;
const TAIL_BYTES = 2_000;

function utf8Prefix(text: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function utf8Suffix(text: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  const characters = Array.from(text);
  for (let index = characters.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(characters[index]);
    if (used + size > maxBytes) break;
    result = characters[index] + result;
    used += size;
  }
  return result;
}

/** `limit` lowers the 8,000-byte inline size for a small context window. */
export function exceedsInlineLimit(text: string, limit = INLINE_BYTES): boolean {
  return Buffer.byteLength(text) > Math.min(limit, INLINE_BYTES);
}

export function spillPreview(text: string, artifactId: string, limit = INLINE_BYTES): string {
  const totalBytes = Buffer.byteLength(text);
  const notice = `Full output stored as artifact ${artifactId}. Use read_tool_output with this id to read another range or search it.`;
  const largestMarker = `\n\n...[${totalBytes} bytes omitted]...\n\n`;
  const retainedBudget = Math.min(limit, INLINE_BYTES) - Buffer.byteLength(notice) - Buffer.byteLength(largestMarker) - 2;
  const tailBudget = Math.min(TAIL_BYTES, Math.floor(retainedBudget / 2));
  const headBudget = Math.max(0, retainedBudget - tailBudget);
  const head = utf8Prefix(text, headBudget);
  const tail = utf8Suffix(text, tailBudget);
  const omittedBytes = totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const boundedMarker = `\n\n...[${omittedBytes} bytes omitted]...\n\n`;
  const result = `${head}${boundedMarker}${tail}\n\n${notice}`;
  return result;
}