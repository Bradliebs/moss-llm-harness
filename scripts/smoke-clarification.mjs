import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(join(tmpdir(), "moss-clarification-profile-"));
const screenshots = mkdtempSync(join(tmpdir(), "moss-clarification-screenshots-"));
const questionnaire = '```moss-clarification\n{"version":1,"title":"Report details","questions":[{"id":"format","prompt":"Which format?","options":["Markdown","Plain text"]},{"id":"destination","prompt":"Which destination folder?"}]}\n```';
const requests = [];
const errors = [];
let releaseResponse;
let application;

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "clarification-fixture" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const content = requests.length === 2 ? "The report preferences have been received." : questionnaire;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    if (requests.length !== 2) {
      await new Promise((resolveResponse) => {
        releaseResponse = resolveResponse;
        response.once("close", resolveResponse);
      });
    }
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
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
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate((baseUrl) => {
    localStorage.setItem("moss.settings", JSON.stringify({ theme: "light", presetIndex: 0, kind: "openai-compatible", baseUrl, model: "clarification-fixture", enableTools: false }));
    localStorage.setItem("moss.models", JSON.stringify(["clarification-fixture"]));
  }, `http://127.0.0.1:${address.port}/v1`);
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByPlaceholder("Message…").fill("Create a report; ask for the missing preferences.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("moss-clarification", { exact: true }).waitFor();
  assert.equal(await page.getByRole("form", { name: "Clarification questions" }).count(), 0);
  assert.ok(requests[0].messages.some((message) => message.role === "system" && message.content.includes("moss-clarification")));
  releaseResponse();
  const form = page.getByRole("form", { name: "Clarification questions" });
  await form.waitFor();
  await page.reload();
  await form.waitFor();
  await form.getByLabel("Which format?").selectOption("other");
  await form.getByLabel("Other answer for question 1").fill("CSV");
  await form.getByLabel("Which destination folder?").fill("reports");
  await page.screenshot({ path: join(screenshots, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, "narrow.png") });
  await page.getByPlaceholder("Message…").fill("Keep this composer draft");
  await form.getByRole("button", { name: "Send answers", exact: true }).click();
  await page.getByText("The report preferences have been received.", { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, "user");
  assert.equal(requests[1].messages.at(-1).content, "Answers to Report details:\n\nWhich format?\nCSV\n\nWhich destination folder?\nreports");
  assert.equal(await page.getByPlaceholder("Message…").inputValue(), "Keep this composer draft");
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await page.getByPlaceholder("Message…").fill("Ask again, but I will cancel.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("moss-clarification", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  assert.equal(await page.getByRole("form", { name: "Clarification questions" }).count(), 1);
  assert.equal(await page.locator('form[aria-label="Clarification questions"] fieldset:not([disabled])').count(), 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(errors, []);
  console.log(`PASS clarification streaming, reload, custom answers, ordinary follow-up, draft preservation, Stop and responsive layout. Screenshots: ${screenshots}`);
} finally {
  releaseResponse?.();
  await application?.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  rmSync(profile, { recursive: true, force: true });
}