// src/lib/toolPreview.ts
//
// Turns raw tool-call arguments into a reviewable description for approval
// prompts: file writes and edits become line diffs, commands show where they
// run, and anything else falls back to formatted JSON.

export type DiffLine = { type: "same" | "add" | "remove"; text: string };

export type ToolPreviewModel =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; oldText: string; newText: string; replaceAll: boolean }
  | { kind: "move"; from: string; to: string }
  | { kind: "command"; command: string }
  | { kind: "generic"; formatted: string };

const MAX_DIFF_LINES = 1500;

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function describeToolCall(name: string, args: string): ToolPreviewModel {
  const parsed = parseArgs(args);
  const text = (key: string): string | null => typeof parsed?.[key] === "string" ? parsed[key] : null;
  if (name === "write_file" && text("path") !== null && text("content") !== null) {
    return { kind: "write", path: text("path")!, content: text("content")! };
  }
  if (name === "edit_file" && text("path") !== null && text("oldText") !== null && text("newText") !== null) {
    return { kind: "edit", path: text("path")!, oldText: text("oldText")!, newText: text("newText")!, replaceAll: parsed?.replaceAll === true };
  }
  if (name === "move_file" && text("from") !== null && text("to") !== null) {
    return { kind: "move", from: text("from")!, to: text("to")! };
  }
  if (name === "run_command" && text("command") !== null) return { kind: "command", command: text("command")! };
  return { kind: "generic", formatted: parsed ? JSON.stringify(parsed, null, 2) : args };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff using a longest-common-subsequence table. Inputs beyond the size
 *  limit return null so callers can show a summary instead of freezing. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length + b.length > MAX_DIFF_LINES) return null;
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "remove", text: a[i++] });
    } else {
      lines.push({ type: "add", text: b[j++] });
    }
  }
  while (i < a.length) lines.push({ type: "remove", text: a[i++] });
  while (j < b.length) lines.push({ type: "add", text: b[j++] });
  return lines;
}

export type CompactDiffLine = DiffLine | { type: "gap"; count: number };

/** Collapse long unchanged runs, keeping a few lines of context around changes. */
export function compactDiff(lines: DiffLine[], context = 3): CompactDiffLine[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: CompactDiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ type: "gap", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: "gap", count: skipped });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "remove").length,
  };
}
