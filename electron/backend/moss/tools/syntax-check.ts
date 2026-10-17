// electron/backend/moss/tools/syntax-check.ts
//
// A cheap check after a file tool writes JavaScript or JSON: does the result
// still parse? Verification commands are off unless the user sets them, so
// without this a model that breaks a file's syntax hears nothing until someone
// runs it. The code is only compiled, never run.

import { Script } from "node:vm";

/** Files that look like JSON but allow comments. */
const JSON_WITH_COMMENTS = /(?:^|[\\/])(?:[tj]sconfig[^\\/]*|devcontainer|\.eslintrc|settings|launch|tasks|extensions)\.json$/i;
/** Module syntax that a script compile rejects although the file is fine, and
 *  constructs a plain script compile cannot judge (CommonJS top-level return, JSX). */
const MODULE_ONLY = /import statement outside a module|Unexpected token 'export'|await is only valid|import\.meta|Cannot use import|Illegal return|Unexpected token '<'/i;

/** A one-line description of why `content` no longer parses, or undefined. */
export function syntaxProblem(path: string, content: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".cjs")) {
    try {
      new Script(content, { filename: path });
      return undefined;
    } catch (error) {
      if (!(error instanceof SyntaxError) || MODULE_ONLY.test(error.message)) return undefined;
      const line = /^[^\n]*:(\d+)\n/.exec(error.stack ?? "")?.[1];
      return `SyntaxError: ${error.message}${line ? ` (line ${line})` : ""}`;
    }
  }
  if (lower.endsWith(".json") && !JSON_WITH_COMMENTS.test(path)) {
    try {
      JSON.parse(content);
      return undefined;
    } catch (error) {
      return `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

/** The note appended to a write or edit result when the change broke the
 *  file's syntax. A file that did not parse before is left alone: the check
 *  cannot tell its dialect from a mistake, and the edit did not cause it. */
export function syntaxNote(path: string, content: string, before?: string): string {
  if (before !== undefined && syntaxProblem(path, before)) return "";
  const problem = syntaxProblem(path, content);
  if (!problem) return "";
  return `\n[check] ${path} ${before === undefined ? "does not parse" : "no longer parses"}: ${problem}. Fix this before running it.`;
}
