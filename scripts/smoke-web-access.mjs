// scripts/smoke-web-access.mjs
//
// Browser access end to end against the packaged app: Moss starts with browser
// access on (isolated profile), a real Chromium page opens the link, takes the
// desktop settings, runs a chat turn whose tool writes a page, and previews that
// page with its module script running. A wrong link is refused. The desktop
// window then previews the same page under its own CSP and frame rules.
// Run after `npm run build && npm run pack:ci`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { _electron as electron, chromium } from "playwright";

const executablePath = resolve("release", "win-unpacked", "Moss.exe");
assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);

const profile = mkdtempSync(join(tmpdir(), "moss-web-profile-"));
const workspace = mkdtempSync(join(tmpdir(), "moss-web-workspace-"));
const token = randomBytes(24).toString("base64url");
const page = '<h1 id="x">Preview works</h1><script type="module">document.getElementById("x").dataset.module = "ran";</script>';
const errors = [];
let application;
let browser;

const provider = createServer(async (request, response) => {
  try {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "web-fixture" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const wrote = input.messages.some((message) => message.role === "tool");
    const delta = wrote
      ? { content: "Browser reply works." }
      : { tool_calls: [{ index: 0, id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "index.html", content: page }) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: wrote ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    errors.push(error.message);
    response.writeHead(500);
    response.end();
  }
});

try {
  await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  // What the desktop window hands a browser opening Moss for the first time.
  const settings = {
    presetIndex: 0, kind: "openai-compatible", baseUrl, model: "web-fixture", enableTools: true,
    autoApproveTools: true, maxToolRounds: 8, workspaceRoot: workspace, theme: "light",
    modelRates: { "web-fixture": { inputPer1M: 0, outputPer1M: 0 } },
  };
  writeFileSync(join(profile, "web-access.json"), JSON.stringify({ enabled: true, token, port: 0, settings: JSON.stringify(settings) }));

  application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], timeout: 30000 });
  const desktop = await application.firstWindow();
  await desktop.getByRole("heading", { name: "Moss", exact: true }).waitFor();
  let port = 0;
  for (let i = 0; i < 50 && !port; i++) {
    port = JSON.parse(readFileSync(join(profile, "web-access.json"), "utf8")).port;
    if (!port) await new Promise((wait) => setTimeout(wait, 100));
  }
  assert.ok(port > 0, "browser access did not start");

  browser = await chromium.launch();
  const tab = await (await browser.newContext()).newPage();
  tab.setDefaultTimeout(30000);
  tab.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await tab.goto(`http://127.0.0.1:${port}/#token=${token}`);
  await tab.getByRole("heading", { name: "Moss", exact: true }).waitFor();
  // The key moved from the address into storage, and the desktop settings arrived.
  await tab.waitForFunction(() => JSON.parse(localStorage.getItem("moss.settings") ?? "{}").model === "web-fixture");
  assert.equal(new URL(tab.url()).hash, "");
  assert.equal(await tab.evaluate(() => typeof window.moss?.chat?.send), "function");

  await tab.getByPlaceholder("Message…").fill("Write the page");
  await tab.getByRole("button", { name: "Send", exact: true }).click();
  await tab.getByText("Browser reply works.").waitFor();
  assert.equal(readFileSync(join(workspace, "index.html"), "utf8"), page);

  await tab.getByRole("button", { name: "Preview", exact: true }).click();
  const heading = tab.frameLocator('iframe[title="Preview of index.html"]').locator("#x");
  await heading.waitFor();
  assert.equal(await heading.textContent(), "Preview works");
  // Served over http, so the page's module script runs (it would not from a file).
  await tab.frameLocator('iframe[title="Preview of index.html"]').locator('#x[data-module="ran"]').waitFor();

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`http://127.0.0.1:${port}/#token=wrong-token`);
  await stranger.getByText("This link is no longer valid", { exact: false }).waitFor();

  // The same preview inside the desktop window, under its CSP and frame rules.
  desktop.setDefaultTimeout(30000);
  desktop.on("pageerror", (error) => errors.push(`desktop: ${error.message}`));
  await desktop.evaluate((saved) => localStorage.setItem("moss.settings", saved), JSON.stringify(settings));
  await desktop.reload();
  await desktop.getByPlaceholder("Message…").fill("Write the page");
  await desktop.getByRole("button", { name: "Send", exact: true }).click();
  await desktop.getByText("Browser reply works.").waitFor();
  await desktop.getByRole("button", { name: "Preview", exact: true }).click();
  await desktop.frameLocator('iframe[title="Preview of index.html"]').locator('#x[data-module="ran"]').waitFor();

  assert.deepEqual(errors, []);
  console.log(`Browser access smoke passed on port ${port}.`);
} finally {
  await browser?.close().catch(() => undefined);
  await application?.close().catch(() => undefined);
  provider.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
