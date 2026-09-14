import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const decision = process.argv[2];
assert.ok(["cancel", "authorize"].includes(decision), "Specify cancel or authorize, then operate the native dialog.");
const profile = mkdtempSync(join(tmpdir(), "moss-native-profile-"));
const workspace = mkdtempSync(join(tmpdir(), "moss-native-workspace-"));
let application;
let deadline;
try {
  application = await electron.launch({
    executablePath: resolve("release/win-unpacked/Moss.exe"),
    args: [`--user-data-dir=${profile}`], timeout: 30000,
  });
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "Moss", exact: true }).waitFor();
  console.log(JSON.stringify({ processId: await application.evaluate(() => process.pid), decision, workspace }));
  const started = Date.now();
  const result = await Promise.race([
    page.evaluate((workspaceRoot) => window.moss.mission.authorize({
      objective: "Native authorization fixture; no task will be launched",
      workspaceRoot,
      policy: {
        authority: "policy-scoped", requestedCapabilities: ["write_file"],
        maxAutoApprovedRisk: "mutating",
        budget: { maxActions: 1, maxTokens: 1000, maxDurationMs: 30000, maxCostUsd: 0.01 },
      },
    }), workspace),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Native dialog was not answered within 120 seconds")), 120000); }),
  ]);
  if (decision === "cancel") assert.equal(result, null);
  else {
    assert.equal(typeof result?.token, "string");
    assert.ok(result.token.length > 0);
    const expires = Date.parse(result.expiresAt);
    assert.ok(expires > started && expires <= Date.now() + 300000);
  }
  assert.deepEqual(await page.evaluate(() => window.moss.task.list()), []);
  console.log(`PASS native ${decision}: ${decision === "cancel" ? "no token issued" : "expiring token issued"}; no task launched`);
} finally {
  clearTimeout(deadline);
  await application?.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}