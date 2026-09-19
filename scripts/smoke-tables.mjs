import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(join(tmpdir(), "moss-table-profile-"));
const screenshots = mkdtempSync(join(tmpdir(), "moss-table-screenshots-"));
const csvPath = join(profile, "results.csv");
const content = "## Workspace results\n\n| File | Score | Status | Notes |\n| --- | ---: | --- | --- |\n| **report.md** | 10 | Ready | =1+1 |\n| analysis.json | 2.5 | Ready | Data export |\n| notes.txt | -1 | Review | Check contents |";
const errors = [];
let application;

try {
  application = await electron.launch({ args: [resolve("."), `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate((content) => {
    const now = new Date().toISOString();
    localStorage.setItem("moss.settings", JSON.stringify({ theme: "light", model: "", enableTools: false }));
    localStorage.setItem("moss.sessions", JSON.stringify({ currentId: "table-session", sessions: [{ id: "table-session", title: "Result tables", createdAt: now, updatedAt: now, messages: [{ role: "user", content: "Compare these files." }, { role: "assistant", content }] }] }));
  }, content);
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  const table = page.getByRole("region", { name: "Result table", exact: true });
  await table.waitFor();
  await table.getByRole("button", { name: "Sort by Score" }).click();
  assert.match(await table.locator("tbody tr").first().textContent(), /notes.txt/);
  await table.getByLabel("Select row 1", { exact: true }).check();
  await table.getByRole("searchbox").fill("ready");
  assert.equal(await table.locator("tbody tr").count(), 2);
  await page.screenshot({ path: join(screenshots, "desktop.png") });

  await application.evaluate(({ session }, path) => {
    globalThis.tableDownload = new Promise((resolveDownload) => {
      const timer = setTimeout(() => resolveDownload("timeout"), 15000);
      session.defaultSession.once("will-download", (_event, item) => {
        item.setSavePath(path);
        item.once("done", (_done, state) => { clearTimeout(timer); resolveDownload(state); });
      });
    });
  }, csvPath);
  await table.getByRole("button", { name: "Export table as CSV" }).click();
  assert.equal(await application.evaluate(() => globalThis.tableDownload), "completed");
  const csv = readFileSync(csvPath, "utf8");
  assert.ok(csv.includes('"report.md","10","Ready","\'=1+1"'));
  assert.ok(!csv.includes("analysis.json"));
  assert.ok(!csv.includes("notes.txt"));
  await table.getByRole("button", { name: "Reset table" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const scroll = table.getByRole("region", { name: "Table data" });
  assert.ok(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth));
  await page.screenshot({ path: join(screenshots, "narrow.png") });
  await table.getByRole("searchbox").fill("missing");
  await table.getByText("No matching rows.").waitFor();
  assert.equal(await table.getByRole("button", { name: "Export table as CSV" }).isDisabled(), true);
  await page.reload();
  await table.waitFor();
  assert.equal(await table.getByRole("searchbox").inputValue(), "");
  assert.equal(await table.locator("tbody tr").count(), 3);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("moss.sessions")).sessions[0].messages.at(-1).content), content);
  assert.deepEqual(errors, []);
  console.log(`PASS table sorting/filtering, stable selection, real formula-safe CSV download, desktop/narrow layout and unchanged transcript. Screenshots: ${screenshots}`);
} finally {
  await application?.close();
  rmSync(profile, { recursive: true, force: true });
}