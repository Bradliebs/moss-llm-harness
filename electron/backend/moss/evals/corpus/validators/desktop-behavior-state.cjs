const assert = require("node:assert/strict");
const fs = require("node:fs");

const mode = process.argv[2];
assert.ok(mode === "available" || mode === "stale", "Unknown desktop scenario");
const state = JSON.parse(fs.readFileSync("desktop-behavior-state.json", "utf8"));
assert.equal(state.theme, mode === "available" ? "Dark" : "Light", "Wrong final theme");
assert.equal(state.notifications, "On", "Unrelated preference changed");
assert.equal(state.openSessions, 0, "Desktop session leaked");
assert.ok(Number.isInteger(state.inspections) && state.inspections >= 1, "No current control inspection");
assert.equal(state.selections, mode === "available" ? 1 : 0, "Unexpected preference mutations");