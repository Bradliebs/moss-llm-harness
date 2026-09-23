import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const profile = mkdtempSync(join(tmpdir(), "moss-mission-profile-"));
const workspace = mkdtempSync(join(tmpdir(), "moss-mission-workspace-"));
const budget = { maxDurationMs: 60000, maxTokens: 10000, maxActions: 2, maxCostUsd: 0.5 };
const policyOnly = process.argv.includes("--policy");
let scenario = "read";
let application;
let requests = 0;
const errors = [];

writeFileSync(join(workspace, "input.txt"), "fixture input");
writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));

function plan() {
  const mutate = scenario !== "read";
  return {
    schemaVersion: 1, revision: 1,
    steps: [
      ...(mutate ? [{
        id: "write", description: "Write the disposable artifact", state: "pending", dependsOn: [],
        requiredCapabilities: ["write_file"],
        mission: { kind: "implement", workerRole: "implementer", executionLane: "exclusive", acceptanceCriterionIds: [], budget, expectedArtifacts: ["change"] },
      }] : []),
      {
        id: "verify", description: "Inspect the fixture and run configured verification", state: "pending", dependsOn: mutate ? ["write"] : [],
        requiredCapabilities: ["read_file"],
        mission: { kind: "verify", workerRole: "verifier", executionLane: "readonly-parallel", acceptanceCriterionIds: ["requested-outcome"], budget, expectedArtifacts: ["report"] },
      },
    ],
  };
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "mission-fixture" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests++;
    const names = (input.tools ?? []).map((tool) => tool.function.name);
    let call;
    if (names.includes("submit_mission_plan")) {
      call = { name: "submit_mission_plan", arguments: JSON.stringify({ plan: plan() }) };
    } else if (!input.messages.some((message) => message.role === "tool")) {
      call = names.includes("write_file")
        ? { name: "write_file", arguments: JSON.stringify({ path: `${scenario}.txt`, content: "approved fixture" }) }
        : { name: "read_file", arguments: JSON.stringify({ path: "input.txt" }) };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call
      ? { tool_calls: [{ index: 0, id: `fixture-${requests}`, type: "function", function: call }] }
      : { content: "Fixture work finished; verification is host-owned." };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    errors.push(error.message);
    response.writeHead(500);
    response.end("Fixture provider failed");
  }
});

try {
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  application = await electron.launch({ executablePath: resolve("release/win-unpacked/Moss.exe"), args: [`--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(policyOnly ? 120000 : 30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Moss", exact: true }).waitFor();
  await page.evaluate(({ baseUrl, workspace }) => {
    const settings = JSON.parse(localStorage.getItem("moss.settings") ?? "{}");
    localStorage.setItem("moss.settings", JSON.stringify({
      ...settings,
      presetIndex: 0,
      kind: "openai-compatible",
      baseUrl,
      model: "mission-fixture",
      enableTools: true,
      maxToolRounds: 8,
      autoApproveTools: false,
      workspaceRoot: workspace,
      verifyEnabled: true,
      verifyCommands: "npm test",
      modelRates: {
        ...(settings.modelRates ?? {}),
        "mission-fixture": { inputPer1M: 1, outputPer1M: 1 },
      },
      theme: "light",
    }));
    localStorage.setItem("moss.models", JSON.stringify(["mission-fixture"]));
  }, { baseUrl, workspace });
  await page.reload();
  await page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsDialog.getByRole("checkbox", { name: "Verify edits with commands", exact: true }).check();
  await settingsDialog.getByPlaceholder("npm run typecheck\nnpm test", { exact: true }).fill("npm test");
  await settingsDialog.getByRole("button", { name: "Close settings", exact: true }).click();

  async function observeTasks() {
    await page.evaluate(async () => {
      window.fixtureTasks = {};
      window.fixtureTools = [];
      window.moss.chat.onEvent(({ event }) => {
        if (event.type === "task-state") window.fixtureTasks[event.task.id] = event.task;
        if (event.type === "tool-result") window.fixtureTools.push(event);
      });
      for (const task of await window.moss.task.list()) {
        window.fixtureTasks[task.id] ??= task;
      }
    });
  }
  await observeTasks();

  async function launch(next) {
    scenario = next;
    await page.getByRole("button", { name: "+ New chat", exact: true }).click();
    await page.getByRole("button", { name: "Mission", exact: true }).click();
    await page.getByText("Review mission", { exact: true }).click();
    const review = page.getByLabel("Mission review", { exact: true });
    await review.getByLabel("Acceptance criterion 1").fill("The disposable mission fixture passes its configured test command");
    await review.getByLabel("Verification method 1").selectOption("commands");
    const verificationCommand = review.getByRole("checkbox", { name: "npm test", exact: true });
    await verificationCommand.uncheck();
    await verificationCommand.check();
    if (policyOnly) await review.getByRole("button", { name: "Policy-scoped", exact: true }).click();
    const capabilities = review.getByRole("group", { name: "Capabilities", exact: true });
    await capabilities.getByRole("checkbox", { name: /^read_file / }).waitFor();
    for (const checkbox of await capabilities.getByRole("checkbox").all()) await checkbox.uncheck();
    await capabilities.getByRole("checkbox", { name: /^read_file / }).check();
    if (next !== "read") await capabilities.getByRole("checkbox", { name: /^write_file / }).check();
    for (const [label, value] of [["Minutes", "2"], ["Tokens", "20000"], ["Actions", "4"], ["Cost USD", "1"]]) {
      await page.getByLabel(`Mission ${label}`, { exact: true }).fill(value);
    }
    await page.getByText("Review mission", { exact: true }).click();
    const objective = `${next}: inspect the disposable fixture${next === "read" ? "" : " and write the approved artifact"}`;
    const composer = page.getByPlaceholder("Message…", { exact: true });
    await composer.fill(objective);
    const launchButton = page.getByRole("button", { name: "Launch", exact: true });
    assert.equal(
      await launchButton.isEnabled(),
      true,
      `Mission preflight remained blocked: ${await page.locator("span.text-amber-700").allTextContents()}`,
    );
    await launchButton.click();
    if (policyOnly) {
      console.log(JSON.stringify({ nativeDecision: "cancel", processId: await application.evaluate(() => process.pid), workspace }));
      await page.getByText("Mission launch cancelled.", { exact: true }).waitFor();
      assert.equal(await composer.inputValue(), objective);
      assert.deepEqual(await page.evaluate(() => window.moss.task.list()), []);
      console.log("PASS native cancellation preserves draft and launches no task");
      await page.getByRole("button", { name: "Launch", exact: true }).click();
      console.log(JSON.stringify({ nativeDecision: "authorize", processId: await application.evaluate(() => process.pid), workspace }));
    }
    await page.waitForFunction((prefix) => Object.values(window.fixtureTasks).some((task) => task.spec.objective.startsWith(prefix)), `${next}:`);
    return page.evaluate((prefix) => Object.values(window.fixtureTasks).find((task) => task.spec.objective.startsWith(prefix)).id, `${next}:`);
  }

  async function waitState(id, states) {
    const handle = await page.waitForFunction(({ id, states }) => {
      const task = window.fixtureTasks[id];
      return states.includes(task?.state) ? task : false;
    }, { id, states }, { timeout: 60000 });
    const task = await handle.jsonValue();
    await handle.dispose();
    console.log("MISSION STATE", JSON.stringify({ id, state: task.state, blocker: task.blocker, steps: task.steps }));
    return task;
  }

  if (policyOnly) {
    const policyId = await launch("policy");
    const policyTask = await waitState(policyId, ["completed", "failed", "blocked", "paused"]);
    assert.equal(policyTask.state, "completed", JSON.stringify(policyTask.blocker));
    assert.equal(readFileSync(join(workspace, "policy.txt"), "utf8"), "approved fixture");
    const tools = await page.evaluate(() => window.fixtureTools);
    assert.ok(tools.some((tool) => tool.name === "write_file" && tool.autoApproved));
    assert.ok(tools.length <= 4);
    assert.ok(policyTask.evidence.some((item) => item.kind === "command" && item.passed));
    assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
    console.log("PASS policy-scoped native authorization, bounded mutation, auto provenance, and verification");
  } else {
  const readId = await launch("read");
  const readTask = await waitState(readId, ["completed", "failed", "blocked", "paused"]);
  assert.equal(readTask.state, "completed", JSON.stringify(readTask.blocker));
  assert.ok(readTask.evidence.some((item) => item.kind === "command" && item.passed));
  console.log("PASS supervised read-only mission with deterministic evidence");

  const approvedId = await launch("approve");
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(existsSync(join(workspace, "approve.txt")), false);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  assert.equal((await waitState(approvedId, ["completed", "failed", "blocked", "paused"])).state, "completed");
  assert.equal(readFileSync(join(workspace, "approve.txt"), "utf8"), "approved fixture");
  console.log("PASS supervised mutation waits for approval and completes with evidence");

  const deniedId = await launch("deny");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await waitState(deniedId, ["completed", "failed", "blocked", "paused"]);
  assert.equal(existsSync(join(workspace, "deny.txt")), false);
  console.log("PASS supervised denial prevents mutation");

  const interruptedId = await launch("interrupt");
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  const before = await page.evaluate((id) => window.moss.task.get(id), interruptedId);
  await page.reload();
  await observeTasks();
  const paused = await waitState(interruptedId, ["paused"]);
  assert.equal(paused.approval.status, "interrupted");
  assert.ok(paused.steps.every((step) => !step.lease));
  assert.equal(existsSync(join(workspace, "interrupt.txt")), false);
  assert.equal(paused.attempts.length, before.attempts.length);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(existsSync(join(workspace, "interrupt.txt")), false);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const resumed = await waitState(interruptedId, ["completed", "failed", "blocked"]);
  assert.equal(resumed.state, "completed");
  assert.ok(resumed.attempts.length > paused.attempts.length);
  assert.equal(readFileSync(join(workspace, "interrupt.txt"), "utf8"), "approved fixture");
  console.log("PASS reload interrupts approval; deliberate resume requires a fresh approval");
  }
  assert.deepEqual(errors, []);
  assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "fixture input");
} finally {
  await application?.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  rmSync(profile, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}