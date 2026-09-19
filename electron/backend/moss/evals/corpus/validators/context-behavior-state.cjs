const assert = require("node:assert/strict");
const fs = require("node:fs");

assert.equal(fs.readFileSync("protected.txt", "utf8").trim(), "unchanged");
const mode = process.argv[2];
if (mode === "resume") {
  const prepared = fs.readFileSync("prepared.txt", "utf8");
  assert.equal(prepared.trim(), "shipment-ready-8532");
  assert.equal(fs.readFileSync("delivered.txt", "utf8"), `Delivered: ${prepared.trim()}\n`);
} else if (mode === "missing") {
  assert.equal(fs.existsSync("durable-state.txt"), false);
  assert.equal(fs.existsSync("recovered-state.txt"), false);
} else {
  assert.equal(mode, "retained");
  const durable = fs.readFileSync("durable-state.txt", "utf8");
  assert.equal(durable.trim(), "shipment-cedar-7419");
  assert.equal(fs.readFileSync("recovered-state.txt", "utf8"), `Recovered: ${durable.trim()}\n`);
}