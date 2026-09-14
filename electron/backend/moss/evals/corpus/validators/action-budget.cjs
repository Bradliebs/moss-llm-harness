const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.equal(fs.readFileSync("first.txt", "utf8").trim(), "first");
if (process.argv[2] === "stopped") assert.equal(fs.existsSync("second.txt"), false);
else {
  assert.equal(process.argv[2], "completed");
  assert.equal(fs.readFileSync("second.txt", "utf8").trim(), "second");
}