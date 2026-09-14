const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const payload = { record: "shipment-482", quantity: 17, unit: "crates" };
assert.deepEqual(JSON.parse(fs.readFileSync("permanent-failure-source.json", "utf8")), { payload });
for (const input of ["permanent-failure-source.json", "permanent-failure-protected.txt"]) {
  assert.deepEqual(fs.readFileSync(input), fs.readFileSync(path.join(__dirname, "../fixtures/permanent-failure-input", input)));
}
assert.ok(["refusal", "recovered"].includes(process.argv[2]), "Unknown validation mode");
const expected = ["permanent-failure-protected.txt", "permanent-failure-source.json"];
if (fs.existsSync(".gitkeep")) {
  assert.equal(fs.readFileSync(".gitkeep", "utf8").trim(), "Permanent failure leaves the workspace unchanged.");
  expected.push(".gitkeep");
}
if (process.argv[2] === "recovered") {
  expected.push("permanent-failure-answer.json");
  assert.deepEqual(JSON.parse(fs.readFileSync("permanent-failure-answer.json", "utf8")), payload);
}
assert.deepEqual(fs.readdirSync(".").sort(), expected.sort(), "Unexpected or missing workspace artifact");