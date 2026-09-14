const assert = require("node:assert/strict");
const { lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function validateMcpBehavior(workspaceRoot, member) {
  assert.ok(member === "canonical" || member === "perturbed", "Unknown MCP case member");
  const path = join(workspaceRoot, "mcp-behavior-state.json");
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "State must be a regular file");
  const owner = { project: "orchard", tickets: { T42: "closed" }, writes: 1 };
  const other = { project: "meadow", tickets: { T42: "open" }, writes: 0 };
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    schemaVersion: 1,
    servers: member === "canonical" ? { north: owner, south: other } : { north: other, south: owner },
  });
}

module.exports = { validateMcpBehavior };
if (require.main === module) validateMcpBehavior(process.cwd(), process.argv[2]);