import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSandboxWorkspace } from "./sandbox-tools";

export const WORKSPACE_BYTES = 32 * 1024 * 1024;
export const SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

interface SnapshotEntry {
  path: string;
  mode: number;
  content?: string;
}

export function applySandboxSnapshot(root: string, value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error("Invalid sandbox snapshot entries");
  const entries: SnapshotEntry[] = [];
  const paths = new Map<string, boolean>();
  let bytes = 0;
  const candidates: readonly unknown[] = value;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") throw new Error("Invalid sandbox snapshot entry");
    const item = candidate as Record<string, unknown>;
    if (typeof item.path !== "string" || item.path.length > 1024 || typeof item.mode !== "number"
      || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error("Invalid sandbox snapshot entry");
    const parts = item.path.split("/");
    if (parts.length > 64 || parts.some((part: string) => !part || part === "." || part === ".."
      || /[\\:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid sandbox snapshot path");
    const key = item.path.toLowerCase();
    if (paths.has(key)) throw new Error("Duplicate sandbox snapshot path");
    if (item.content !== undefined) {
      if (typeof item.content !== "string" || item.content.length > Math.ceil(WORKSPACE_BYTES / 3) * 4
        || Buffer.from(item.content, "base64").toString("base64") !== item.content) {
        throw new Error("Invalid sandbox snapshot content");
      }
      bytes += Buffer.byteLength(item.content, "base64");
      if (bytes > WORKSPACE_BYTES) throw new Error("Sandbox snapshot exceeds workspace limit");
    }
    paths.set(key, item.content === undefined);
    entries.push({ path: item.path, mode: item.mode, ...(typeof item.content === "string" ? { content: item.content } : {}) });
  }
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split("/");
    for (let count = 1; count < parts.length; count++) {
      if (paths.get(parts.slice(0, count).join("/")) !== true) throw new Error("Invalid sandbox snapshot parent");
    }
  }
  assertSandboxWorkspace(root);
  const staging = mkdtempSync(join(dirname(root), ".moss-snapshot-"));
  try {
    for (const entry of entries.filter((entry) => entry.content === undefined).sort((left, right) => left.path.length - right.path.length)) {
      mkdirSync(join(staging, entry.path), { recursive: true });
    }
    for (const entry of entries.filter((entry) => entry.content !== undefined)) {
      writeFileSync(join(staging, entry.path), Buffer.from(entry.content!, "base64"), { flag: "wx", mode: entry.mode });
      chmodSync(join(staging, entry.path), entry.mode);
    }
    assertSandboxWorkspace(root);
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    for (const name of readdirSync(staging)) cpSync(join(staging, name), join(root, name), { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export const SANDBOX_SUPERVISOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const limit = ${WORKSPACE_BYTES};
function snapshot(root) {
  const entries = [];
  let bytes = 0;
  function visit(relative, depth) {
    if (depth > 64 || entries.length >= 20000) throw new Error('Sandbox workspace exceeds inspection limit');
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
      throw new Error('Sandbox workspace contains a link or special file');
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, mode: stat.mode & 511 });
      for (const name of fs.readdirSync(absolute)) visit(path.join(relative, name), depth + 1);
    } else {
      bytes += stat.size;
      if (bytes > limit) throw new Error('Sandbox snapshot exceeds workspace limit');
      const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const content = fs.readFileSync(descriptor);
        if (content.length !== stat.size) throw new Error('Sandbox workspace changed during export');
        entries.push({ path: relative, mode: stat.mode & 511, content: content.toString('base64') });
      } finally { fs.closeSync(descriptor); }
    }
  }
  for (const name of fs.readdirSync(root)) visit(name, 1);
  return entries;
}
function fail(error) { process.stdout.write(JSON.stringify({ schemaVersion: 1, error: error.message })); }
try {
  snapshot('/input');
  for (const name of fs.readdirSync('/input')) fs.cpSync(path.join('/input', name), path.join('/workspace', name), { recursive: true });
  const child = spawn('/bin/sh', ['-lc', process.argv[1]], { cwd: '/workspace', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, 8000); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 8000); });
  child.on('error', fail);
  child.on('close', (exitCode) => {
    try {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      process.stdout.write(JSON.stringify({ schemaVersion: 1, exitCode, stdout, stderr, entries: snapshot('/workspace') }));
    } catch (error) { fail(error); }
  });
} catch (error) { fail(error); }
`;