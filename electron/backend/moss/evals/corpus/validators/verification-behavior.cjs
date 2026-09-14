const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fixture = path.resolve(__dirname, "../fixtures/verification-behavior");
for (const name of ["verify.cjs", "protected.txt"]) assert.deepEqual(fs.readFileSync(name), fs.readFileSync(path.join(fixture, name)));
if (process.argv[2] === "exhausted") assert.deepEqual(fs.readFileSync("answer.cjs"), fs.readFileSync(path.join(fixture, "answer.cjs")));
else {
  assert.equal(process.argv[2], "repaired");
  assert.match(fs.readFileSync("answer.cjs", "utf8"), /^\s*module\.exports\s*=\s*42\s*;?\s*$/);
}