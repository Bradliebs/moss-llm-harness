import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(join(tmpdir(), "moss-attachments-profile-"));
const screenshots = mkdtempSync(join(tmpdir(), "moss-attachments-screenshots-"));
const docx = "UEsDBAoAAAAAAJCMNl0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAAAAhXN78bRiZAAAA7AAAABEAAAB3b3JkL2RvY3VtZW50LnhtbG2PTQoCMQxGr1J6gMnowsUwP4dw4Tq2dTowbUoaHb297YAI4uaF8PjykX56hlU9HOeF4qAPTaunsd86S+YeXBRVdMzdNmgvkjqAbLwLmBtKLhZ3Iw4oZeUZNmKbmIzLeYlzWOHYticIuERdT17JvupMFVwh46VEFIqg8XubuCw9VFPJO9Nv6OwMRasSMs6Myf8JwKcOvq+Mb1BLAQIUAAoAAAAAAJCMNl0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAAAAAAB3b3JkL1BLAQIUAAoAAAAIAAAAIVze/G0YmQAAAOwAAAARAAAAAAAAAAAAAAAAACMAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAHIAAADrAAAAAAA=";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const errors = [];
let application;

try {
  application = await electron.launch({ args: [resolve("."), `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    localStorage.setItem("moss.settings", JSON.stringify({ theme: "light", model: "", enableTools: false }));
  });
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  const input = page.getByLabel("Attach files", { exact: true });
  await input.setInputFiles([
    { name: "report.DOCX", mimeType: "application/octet-stream", buffer: Buffer.from(docx, "base64") },
    { name: "notes.MD", mimeType: "", buffer: Buffer.from("# Markdown attachment\n\nBody text") },
  ]);
  await page.getByText("report.DOCX", { exact: true }).waitFor();
  await page.getByText("notes.MD", { exact: true }).waitFor();

  await input.evaluate((element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "photo.PNG"));
    element.files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, image);
  await page.getByRole("button", { name: "Attach (3)", exact: true }).waitFor();
  const preview = page.getByAltText("attachment", { exact: true });
  await preview.evaluate((element) => element.decode());
  assert.match(await preview.getAttribute("src"), /^data:image\/png;base64,/);
  assert.equal(await page.getByPlaceholder("Message…").inputValue(), "");
  assert.equal(await page.getByText("Word attachment test", { exact: true }).count(), 0);
  await page.screenshot({ path: join(screenshots, "desktop.png") });

  await input.setInputFiles({ name: "broken.docx", mimeType: "", buffer: Buffer.from("not a zip") });
  await page.getByText(/broken\.docx:/).waitFor();
  await page.getByRole("button", { name: "Attach (3)", exact: true }).waitFor();
  await input.setInputFiles({ name: "legacy.doc", mimeType: "application/msword", buffer: Buffer.from("legacy") });
  await page.getByText(/legacy\.doc files are not supported|legacy \.doc files are not supported/).waitFor();
  await page.screenshot({ path: join(screenshots, "errors.png") });
  assert.deepEqual(errors, []);
  console.log(`PASS real DOCX parsing, Markdown upload, MIME-less image preview, malformed/legacy Word errors, and unchanged composer. Screenshots: ${screenshots}`);
} finally {
  await application?.close();
  rmSync(profile, { recursive: true, force: true });
}