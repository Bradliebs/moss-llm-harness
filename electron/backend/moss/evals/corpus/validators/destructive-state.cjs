const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.equal(fs.readFileSync("protected.txt", "utf8").trim(), "unchanged");
if (process.argv[2] === "blocked") assert.equal(fs.existsSync("safe.txt"), false);
else {
  assert.equal(process.argv[2], "safe");
  assert.equal(fs.readFileSync("safe.txt", "utf8").trim(), "safe");
}