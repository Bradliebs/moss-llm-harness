// electron/backend/moss/verify/verifier.ts
//
// Runs the user-configured verification commands (e.g. `npm run typecheck`,
// `npm test`) in the workspace after the agent edits files, so the model gets
// pass/fail feedback and can self-correct. Fail-fast: the first failing command
// stops the run, since later checks are usually noise once an earlier one fails.

import { runShellCommand } from "../tools/shell-tool";

/** Per-command output cap (characters) so a noisy failure cannot exhaust the
 *  model's context when the report is fed back. */
const OUTPUT_CAP = 8000;
/** Per-command timeout backstop; a test suite can legitimately run a while. */
const COMMAND_TIMEOUT_MS = 180_000;

export interface VerifyCommandResult {
  command: string;
  ok: boolean;
  /** combined stdout/stderr, capped */
  output: string;
}

export interface VerifyResult {
  /** true only when every command that ran exited 0 */
  ok: boolean;
  results: VerifyCommandResult[];
}

interface RunOptions {
  /** per-command timeout override (ms); for tests */
  commandTimeoutMs?: number;
}

/** Run each command in order, stopping at the first failure. A blank/empty
 *  command list yields an ok result with no entries. */
export async function runVerify(
  commands: string[],
  cwd: string,
  signal: AbortSignal,
  opts: RunOptions = {},
): Promise<VerifyResult> {
  const cleaned = commands.map((c) => c.trim()).filter(Boolean);
  const results: VerifyCommandResult[] = [];

  for (const command of cleaned) {
    if (signal.aborted) break;
    const res = await runOne(command, cwd, signal, opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
    results.push(res);
    if (!res.ok) break;
  }

  return { ok: !signal.aborted && results.every((r) => r.ok), results };
}

async function runOne(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<VerifyCommandResult> {
  const result = await runShellCommand(command, cwd, signal, timeoutMs, OUTPUT_CAP);
  return { command, ok: result.ok, output: result.content };
}

/** Render a verify result into a compact report for the model, prefixed so it
 *  is clearly distinguishable from the tool output it is appended to. On failure
 *  a focus line steers the model to a surgical fix -- change only what the
 *  failing check needs, without re-touching checks that already passed. */
export function formatVerifyReport(result: VerifyResult): string {
  if (result.results.length === 0) return "";
  const lines = result.results.map((r) => {
    const status = r.ok ? "PASS" : "FAIL";
    return r.ok ? `[verification] ${status}: ${r.command}` : `[verification] ${status}: ${r.command}\n${r.output}`;
  });
  if (!result.ok) {
    lines.push(
      "[verification] Focus: fix only what the failing check above requires; do not modify files unrelated to it or re-touch checks that already passed.",
    );
  }
  return lines.join("\n");
}
