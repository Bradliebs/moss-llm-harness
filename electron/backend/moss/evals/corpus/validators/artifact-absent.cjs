const { existsSync } = require("node:fs");
const { resolve, sep } = require("node:path");

const workspaceRoot = resolve(process.cwd());
const candidate = resolve(workspaceRoot, process.argv[2] || "");
const insideWorkspace = candidate.startsWith(`${workspaceRoot}${sep}`);

process.exitCode = insideWorkspace && !existsSync(candidate) ? 0 : 1;