import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import axe from "axe-core";
import { _electron as electron } from "playwright";

const executablePath = resolve("release", "win-unpacked", "Moss.exe");
assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);

const userDataDir = resolve(".smoke-packaged-user-data");
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir);
let application;
try {
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  });
  await application.context().addInitScript({ content: axe.source });
  const window = await application.firstWindow({ timeout: 30_000 });
  await window.reload();
  await window.getByRole("heading", { name: "Moss" }).waitFor();
  async function assertAccessible(surface) {
    await window.waitForTimeout(500);
    const results = await window.evaluate(async () => window.axe.run(document));
    const serious = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
    assert.deepEqual(serious, [], `${surface} has serious accessibility violations:\n${JSON.stringify(serious, null, 2)}`);
  }
  await assertAccessible("Welcome");
  const settingsButton = window.getByRole("banner").getByRole("button", { name: "Settings", exact: true });
  await settingsButton.click();
  const settingsDialog = window.getByRole("dialog", { name: "Settings" });
  const closeSettings = window.getByRole("button", { name: "Close settings" });
  await settingsDialog.waitFor();
  await assertAccessible("Settings");
  assert.equal(await settingsDialog.getAttribute("aria-modal"), "true");
  assert.equal(await closeSettings.evaluate((element) => element === document.activeElement), true);
  await window.keyboard.press("Shift+Tab");
  assert.equal(
    await settingsDialog.evaluate((dialog) => dialog.contains(document.activeElement)),
    true,
    "Shift+Tab must keep focus in the Settings dialog",
  );
  await window.keyboard.press("Tab");
  assert.equal(await closeSettings.evaluate((element) => element === document.activeElement), true);
  await settingsDialog.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await settingsDialog.getByRole("checkbox", { name: /Collect local product diagnostics/ }).check();
  await settingsDialog.getByText("0 retained events").waitFor();
  await window.keyboard.press("Escape");
  await window.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
  assert.equal(await settingsButton.evaluate((element) => element === document.activeElement), true);
  await window.getByRole("button", { name: "Run center" }).click();
  const runCenter = window.getByRole("dialog", { name: "Run center" });
  await runCenter.waitFor();
  await assertAccessible("Run center");
  assert.equal(await runCenter.getAttribute("aria-modal"), "true");
  await runCenter.getByRole("button", { name: "Close run center" }).click();
  await runCenter.waitFor({ state: "detached" });
  await window.getByRole("button", { name: "Mission" }).click();
  for (const name of ["coding", "research", "automation"]) {
    await window.getByRole("button", { name }).waitFor();
  }
  await window.getByRole("button", { name: "coding" }).click();
  await window.getByText("Review mission").click();
  await window.getByLabel("Mission review").waitFor();
  await assertAccessible("Mission review");
  await window.getByLabel("Acceptance criterion 1").waitFor();
  await window.getByLabel("Verification method 1").waitFor();
  for (const label of ["Mission Minutes", "Mission Tokens", "Mission Actions", "Mission Cost USD"]) {
    await window.getByLabel(label).waitFor();
  }
  assert.equal(await window.getByRole("button", { name: "Launch" }).isDisabled(), true);
  await window.setViewportSize({ width: 420, height: 740 });
  await window.getByRole("button", { name: "Open conversations" }).waitFor();
  await assertAccessible("Compact mission layout");
  console.log("Packaged setup, Run center, diagnostics, templates, accessibility, and Mission preflight smoke passed.");
} finally {
  await application?.close().catch(() => undefined);
  rmSync(userDataDir, { recursive: true, force: true });
}