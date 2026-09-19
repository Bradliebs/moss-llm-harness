import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(join(tmpdir(), "moss-artifact-profile-"));
const screenshots = mkdtempSync(join(tmpdir(), "moss-artifact-screenshots-"));
const errors = [];
let application;

try {
  application = await electron.launch({ args: [resolve("."), `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await application.evaluate(async ({ app }) => {
    const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
    const { taskStore } = require(`${app.getAppPath()}/dist-electron/electron/backend/moss/task/task-store.js`);
    const { taskArtifactStore } = require(`${app.getAppPath()}/dist-electron/electron/backend/moss/task/task-artifact-store.js`);
    const task = await taskStore.create({ objective: "Inspect the artifact workspace", acceptanceCriteria: [], constraints: [], assumptions: [] }, "artifact-smoke");
    const content = "# Workspace report\n\n## Results\n\n| File | Result |\n| --- | --- |\n| report.md | Ready |\n| analysis.json | Ready |\n\nA saved report beside the conversation.\n\n![remote](https://example.invalid/tracking.png)\n\n<script>window.artifactExecuted = true</script>";
    const report = await taskArtifactStore.save({ taskId: task.id, planRevision: 1, stepId: "report", attemptId: "attempt-1", name: "report.md", summary: "Workspace findings and generated files", content });
    const source = await taskArtifactStore.save({ taskId: task.id, planRevision: 1, stepId: "source", attemptId: "attempt-1", name: "preview.html", summary: "HTML remains inert source text", content: "<h1>Example</h1><script>window.artifactExecuted = true</script>" });
    await taskStore.update(task.id, (snapshot) => ({ ...snapshot, artifacts: [report, source] }));
    return { taskId: task.id, reportId: report.id, sourceId: source.id, content };
  });
  await page.evaluate(({ taskId }) => {
    const now = new Date().toISOString();
    localStorage.setItem("moss.settings", JSON.stringify({ theme: "light", model: "", enableTools: false }));
    localStorage.setItem("moss.sessions", JSON.stringify({ currentId: "artifact-session", sessions: [{ id: "artifact-session", title: "Workspace report", taskId, createdAt: now, updatedAt: now, messages: [{ role: "user", content: "Inspect the saved report." }, { role: "assistant", content: "The report is available in the artifact workspace." }] }] }));
  }, fixture);
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "Open artifacts", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "Artifact workspace" });
  await pane.getByRole("heading", { name: "Workspace report", exact: true }).waitFor();
  assert.equal(await pane.locator("img, script, iframe, a").count(), 0);
  const paneBox = await pane.boundingBox();
  const composerBox = await page.locator("textarea").boundingBox();
  assert.ok(paneBox && composerBox && composerBox.x + composerBox.width <= paneBox.x);
  await page.screenshot({ path: join(screenshots, "desktop.png") });
  await pane.getByRole("button", { name: "Source", exact: true }).click();
  assert.equal(await pane.locator("pre").textContent(), fixture.content);
  await pane.getByRole("button", { name: "Copy artifact", exact: true }).click();
  await pane.getByText("Copied", { exact: true }).waitFor();
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), fixture.content);
  await pane.getByRole("combobox", { name: "Select artifact" }).selectOption(fixture.sourceId);
  await pane.getByRole("button", { name: "Preview", exact: true }).click();
  await pane.locator("pre").filter({ hasText: "<h1>Example</h1>" }).waitFor();
  assert.equal(await page.evaluate(() => window.artifactExecuted), undefined);
  await pane.getByRole("combobox", { name: "Select artifact" }).selectOption(fixture.reportId);
  await pane.getByRole("heading", { name: "Workspace report", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("textarea").isVisible(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, "narrow.png") });
  await pane.getByRole("button", { name: "Close artifact workspace" }).focus();
  await page.keyboard.press("Escape");
  await pane.waitFor({ state: "detached" });
  assert.equal(await page.locator("textarea").isVisible(), true);
  await page.reload();
  await page.getByRole("button", { name: "Open artifacts", exact: true }).click();
  await pane.getByRole("heading", { name: "Workspace report", exact: true }).waitFor();
  await pane.getByRole("button", { name: "Close artifact workspace" }).click();
  await application.evaluate(({ app }, fixture) => {
    const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
    const fs = require("node:fs");
    const path = require("node:path").join(app.getPath("userData"), "task-artifacts", fixture.taskId, `${fixture.reportId}.json`);
    const record = JSON.parse(fs.readFileSync(path, "utf8"));
    fs.writeFileSync(path, JSON.stringify({ ...record, content: "tampered content" }));
  }, fixture);
  await page.getByRole("button", { name: "Open artifacts", exact: true }).click();
  await pane.getByRole("alert").filter({ hasText: "integrity check failed" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS artifact IPC, desktop/narrow layout, inert HTML, copy, reload and tamper rejection. Screenshots: ${screenshots}`);
} finally {
  await application?.close();
  rmSync(profile, { recursive: true, force: true });
}