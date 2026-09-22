import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "playwright/test";

const profile = mkdtempSync(join(tmpdir(), "moss-jev-profile-"));
const screenshots = mkdtempSync(join(tmpdir(), "moss-jev-screenshots-"));
const requests = [];
const errors = [];
let application;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "jev-fixture" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const enabled = input.tools?.some((tool) => tool.function.name === "jev_evaluate");
    const completed = input.messages.at(-1)?.role === "tool";
    const delta = enabled && !completed ? {
      tool_calls: [{ index: 0, id: `jev-${requests.length}`, type: "function", function: {
        name: "jev_evaluate", arguments: JSON.stringify({ state: "A customer needs help.", question: "Is help requested?", type: "noul" }),
      } }],
    } : { content: `Fixture reply ${requests.length}.` };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    errors.push(error.message);
    response.end();
  }
});

try {
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  application = await electron.launch({ args: [resolve("."), `--user-data-dir=${profile}`], timeout: 30000 });
  await application.evaluate(() => {
    const originalFetch = globalThis.fetch;
    globalThis.jevSmokeCalls = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.typesafe.ai")) {
        globalThis.jevSmokeCalls.push({ url: String(url), body: JSON.parse(init.body), authorization: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ model: "jev-fixture", answers: { evaluation: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 12, output_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(url, init);
    };
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate((baseUrl) => {
    localStorage.setItem("moss.settings", JSON.stringify({ theme: "light", presetIndex: 0, kind: "openai-compatible", baseUrl, model: "jev-fixture", enableTools: true, autoApproveTools: true }));
    localStorage.setItem("moss.models", JSON.stringify(["jev-fixture"]));
  }, `http://127.0.0.1:${address.port}/v1`);
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  const openSettings = () => page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }).click();
  const closeSettings = () => page.getByRole("button", { name: "\u2715", exact: true }).click();
  const region = page.getByRole("region", { name: "TypeSafe / Jev" });
  const toggle = region.getByRole("checkbox", { name: "Use Jev" });
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await region.getByLabel("TypeSafe API key", { exact: true }).fill("smoke-only-not-a-real-key");
  await region.getByRole("button", { name: "Save TypeSafe API key" }).click();
  await expect(region.getByText("TypeSafe API key saved securely.")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  assert.ok(!readFileSync(join(profile, "provider-credentials.json"), "utf8").includes("smoke-only-not-a-real-key"));
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("smoke-only-not-a-real-key")), false);
  await toggle.check();
  await page.reload();
  await openSettings();
  await expect(toggle).toBeChecked();
  await expect(region.getByLabel("TypeSafe API key", { exact: true })).toHaveValue("");
  await region.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await region.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, "narrow.png") });
  await closeSettings();
  await page.getByPlaceholder("Message\u2026").fill("Use Jev to evaluate this request.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.jevSmokeCalls.length), 0);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText("Fixture reply 2.", { exact: true }).waitFor();
  const calls = await application.evaluate(() => globalThis.jevSmokeCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer smoke-only-not-a-real-key");
  assert.equal(calls[0].body.model, "jev-latest");
  assert.equal(calls[0].body.state, "A customer needs help.");
  await openSettings();
  await toggle.uncheck();
  await page.reload();
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await closeSettings();
  await page.getByPlaceholder("Message\u2026").fill("Continue without Jev.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Fixture reply 3.", { exact: true }).waitFor();
  assert.ok(!requests.at(-1).tools.some((tool) => tool.function.name === "jev_evaluate"));
  assert.equal(await application.evaluate(() => globalThis.jevSmokeCalls.length), 1);
  await openSettings();
  await region.getByRole("button", { name: "Remove TypeSafe API key" }).click();
  await expect(region.getByText("TypeSafe API key removed.")).toBeVisible();
  assert.equal(JSON.parse(readFileSync(join(profile, "provider-credentials.json"), "utf8")).typesafe, undefined);
  assert.deepEqual(errors, []);
  console.log(`PASS Jev encrypted credentials, default-off, reload, opt-in chat, approval, opt-out, key removal and responsive layout. Screenshots: ${screenshots}`);
} finally {
  await application?.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  rmSync(profile, { recursive: true, force: true });
}