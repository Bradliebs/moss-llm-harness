// electron/backend/moss/mcp/mcp-config.ts
//
// Loads MCP server definitions from `<userData>/mcp-servers.json`. Moss has no
// general settings store yet (that arrives with the Phase 6 settings UI), so for
// now MCP servers are declared in a JSON file the user edits directly. On first
// run a documented template is written with every entry disabled, so nothing is
// spawned until the user opts in.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { userDataDir } from "../runtime/user-data";

import { createLogger } from "../../../../common/logger";
import { writeFileAtomicSync } from "../persistence/atomic-file";

const log = createLogger("MCP:config");

export interface McpStdioServerConfig {
  type: "stdio";
  id: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** honor the server's readOnlyHint annotations; off by default */
  trustAnnotations?: boolean;
  /** ignore the server's destructiveHint annotations, for servers that flag
   *  every non-read tool; Moss's own irreversible-action checks still apply */
  ignoreDestructiveHints?: boolean;
}

export interface McpHttpServerConfig {
  type: "http";
  id: string;
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  /** honor the server's readOnlyHint annotations; off by default */
  trustAnnotations?: boolean;
  /** ignore the server's destructiveHint annotations, for servers that flag
   *  every non-read tool; Moss's own irreversible-action checks still apply */
  ignoreDestructiveHints?: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const TEMPLATE: McpServerConfig[] = [
  {
    type: "stdio",
    id: "playwright",
    enabled: false,
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
  },
];

function configPath(): string {
  return join(userDataDir(), "mcp-servers.json");
}

function isValid(entry: unknown): entry is McpServerConfig {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (e.type === "stdio") return typeof e.command === "string" && e.command.length > 0;
  if (e.type === "http") return typeof e.url === "string" && e.url.length > 0;
  return false;
}

/** Reads configured MCP servers, seeding a disabled template on first run.
 *  Never throws: malformed config logs a warning and yields an empty list. */
export function loadMcpServers(): McpServerConfig[] {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    try {
      writeFileAtomicSync(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
      log.info(`seeded MCP config template at ${path} (all servers disabled)`);
    } catch (err) {
      log.warn("could not seed MCP config template", err);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`ignoring malformed ${path}`, err);
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn(`ignoring ${path}: expected a JSON array of server configs`);
    return [];
  }

  const valid = parsed.filter(isValid);
  if (valid.length !== parsed.length) {
    log.warn(`${parsed.length - valid.length} invalid MCP server entr(ies) skipped`);
  }
  return valid;
}

/** Returns the path to the MCP config file, seeding the disabled template if it
 *  does not yet exist. Used by the settings UI to open the file for editing. */
export function ensureMcpConfig(): string {
  const path = configPath();
  try {
    readFileSync(path, "utf8");
  } catch {
    try {
      writeFileAtomicSync(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
      log.info(`seeded MCP config template at ${path} (all servers disabled)`);
    } catch (err) {
      log.warn("could not seed MCP config template", err);
    }
  }
  return path;
}

/** Flip a configured server's `enabled` flag in mcp-servers.json. Returns true
 *  when the file was rewritten (i.e. the value actually changed). Lets the
 *  settings UI toggle the bundled (disabled) template without hand-editing JSON.
 *  Never throws: a missing/malformed file or write failure yields false. */
export function setMcpServerEnabled(id: string, enabled: boolean): boolean {
  const path = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;

  let changed = false;
  for (const entry of parsed) {
    if (isValid(entry) && entry.id === id && entry.enabled !== enabled) {
      entry.enabled = enabled;
      changed = true;
    }
  }
  if (!changed) return false;

  try {
    writeFileAtomicSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    log.info(`MCP server '${id}' ${enabled ? "enabled" : "disabled"}`);
    return true;
  } catch (err) {
    log.warn(`could not update MCP config for '${id}'`, err);
    return false;
  }
}

/** Append a new server to mcp-servers.json. Returns true when the file was
 *  rewritten. Lets the settings UI add a server without hand-editing JSON.
 *  Rejects invalid configs and duplicate ids. A missing/malformed file is
 *  treated as an empty list so the first add still succeeds. Never throws. */
export function addMcpServer(config: McpServerConfig): boolean {
  if (!isValid(config)) return false;
  const path = configPath();
  // Distinguish an absent file (fine: seed an empty list so the first add
  // succeeds) from a present-but-malformed one (refuse: writing would silently
  // overwrite the user's hand-edited config). A read failure is treated as
  // empty; a parse failure on readable content returns false.
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "[]";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`MCP config at ${path} is malformed; not adding '${config.id}' to avoid overwriting it`);
    return false;
  }
  if (!Array.isArray(parsed)) parsed = [];
  const list = parsed as unknown[];
  if (list.some((e) => isValid(e) && e.id === config.id)) {
    log.warn(`MCP server '${config.id}' already exists; not added`);
    return false;
  }
  list.push(config);
  try {
    writeFileAtomicSync(path, `${JSON.stringify(list, null, 2)}\n`);
    log.info(`MCP server '${config.id}' added`);
    return true;
  } catch (err) {
    log.warn(`could not add MCP server '${config.id}'`, err);
    return false;
  }
}

/** Remove a server from mcp-servers.json by id. Returns true when the file was
 *  rewritten (i.e. a matching entry was found and dropped). Never throws: a
 *  missing/malformed file or write failure yields false. */
export function removeMcpServer(id: string): boolean {
  const path = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const filtered = parsed.filter((e) => !(isValid(e) && e.id === id));
  if (filtered.length === parsed.length) return false;
  try {
    writeFileAtomicSync(path, `${JSON.stringify(filtered, null, 2)}\n`);
    log.info(`MCP server '${id}' removed`);
    return true;
  } catch (err) {
    log.warn(`could not remove MCP server '${id}'`, err);
    return false;
  }
}

/** Merge changed fields into an existing server in mcp-servers.json, matched by
 *  id. Preserves fields the caller omits (env, headers, cwd, enabled), so the
 *  settings UI can edit command/args/url without dropping the rest. Returns true
 *  when a matching entry was found and the file rewritten. Never throws. */
export function updateMcpServer(config: McpServerConfig): boolean {
  const path = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const index = parsed.findIndex((e) => isValid(e) && e.id === config.id);
  if (index === -1) return false;
  const merged = { ...(parsed[index] as object), ...config };
  if (!isValid(merged)) return false;
  parsed[index] = merged;
  try {
    writeFileAtomicSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    log.info(`MCP server '${config.id}' updated`);
    return true;
  } catch (err) {
    log.warn(`could not update MCP server '${config.id}'`, err);
    return false;
  }
}
