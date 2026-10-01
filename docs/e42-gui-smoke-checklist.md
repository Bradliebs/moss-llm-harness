---
title: E42 Runtime GUI Smoke Checklist
description: Packaged and live-provider smoke checks for the Moss Electron application
ms.topic: how-to
---

<!-- markdownlint-disable-file -->

## Scope

The automated gate launches the unpacked Windows executable with isolated user
data and verifies the Mission intake through the packaged main process, preload,
and renderer. The live-provider pass still needs an interactive window, a real
provider, and a human watching tool effects and native authorization prompts.

Run both before tagging a release or after changes to the turn loop, mission
runtime, IPC contract, preload bridge, or renderer event handling.

## Automated package gate

Build the unpacked app and run its Playwright Electron smoke:

```powershell
npm run build
npm run pack:ci
npm run smoke:packaged
```

The `pack:ci` command creates an unsigned package without changing the release
configuration. The Windows CI job runs these commands after typechecking, focused
lint, the deterministic test suite, and the coverage gate.

The smoke passes when `Moss.exe` loads and the Chat/Mission selector, mission
review surface, settings dialog semantics, all four budget controls, and mission
contract controls render through the packaged bridge. It also verifies that
Launch remains disabled before the mandatory criterion passes preflight and that
keyboard focus remains trapped in Settings, Escape closes the dialog, and focus
returns to its opener. The smoke also checks the getting-started guide, opens
the command palette with `Ctrl+K` and routes it to Run center, enables local
diagnostics, loads each mission template, and resizes to a 420 by 740 compact
layout. axe must report no serious or critical findings on Welcome, the command
palette, Settings, Run center, mission review, or the compact layout.

The CI build also runs the renderer bundle budget:

```powershell
npm run check:bundle
```

This gate measures the initial JavaScript and stylesheet graph referenced by the
built `dist/index.html`. Secondary Settings, Library, artifact, document parser,
and syntax-language chunks are excluded until the user opens those workflows.

## Prerequisites

### Recorded automated acceptance on 2026-09-22

The unsigned package passed the expanded packaged smoke, including axe checks on
Welcome, Settings, Run center, mission review, and the compact layout. The axe
gate found white text on emerald 600 and low-contrast dark-mode mission labels;
both were corrected before acceptance. Scripted supervised read-only, approval,
denial, reload interruption, and deliberate recovery missions also passed. These
checks used deterministic fixtures and do not establish live-model reliability.

### Recorded automated acceptance on 2026-09-14

The refreshed unsigned package passed the packaged Mission startup gate. A
separate Playwright Electron run with temporary user data also verified theme,
tool enablement, and round-limit persistence across reload; disabling tools
disabled the round-limit control. Conversation creation, hover-revealed rename,
and reload persistence passed. Mission review accepted edits to all four budget
controls. No renderer `pageerror` events were observed during this run.

Screenshots are stored outside the repository under
`%LOCALAPPDATA%/MossEvalDiagnostics/packaged-ui-acceptance-1789401159585`.
No model requests were sent during these checks. The model shown in the isolated
window was selected by the normal model-list loading behavior, not exercised.
These checks do not sign off live streaming, real native authorization dialogs,
dictation, or human-observed tool effects. Those checklist items remain pending.

### Recorded live chat acceptance on 2026-09-14

The rebuilt unsigned package passed a subsequent Playwright run against
`qwen3.5:397b-cloud` using temporary user data and a disposable workspace. It
verified text-delta delivery, immediate and persisted chat titles, approved file
creation, denial preventing file creation, auto-approval provenance after reload,
cancellation during streamed output, and history isolation when switching chats.
No renderer `pageerror` events occurred. The temporary profile and workspace were
removed; production settings were unchanged.

This run exposed a stale `Aborted` status on conversation switches. ChatPanel now
clears transient status when the conversation ID changes. Two regression tests
failed before the repair and passed afterward; all 87 nearby chat, app, and title
tests, typechecking, and the full build passed. The live packaged workflow then
passed with an assertion that waits for the session-change render to settle.

The first approval prompt caused the model to request permission in prose without
calling a tool. The UI exercise therefore explicitly asked it to submit the
`write_file` call and let the application handle approval. This verifies the UI
gate once invoked, not reliable tool submission across arbitrary user wording.
The independent evaluation failures remain unchanged.

Screenshots of chat, pending approval, and persisted auto-approval were inspected
under `%LOCALAPPDATA%/MossEvalDiagnostics/packaged-live-chat-1789403447021`.
Native mission authorization, supervised mission interruption/recovery, and
dictation were not exercised by this chat-only run and still need the applicable
checks below. Automated file assertions are not human signoff of native dialogs.

### Recorded mission and native checks on 2026-09-14

The packaged [mission fixture](../scripts/smoke-missions.mjs) uses a deterministic
local provider, temporary user data, and disposable files. It verified read-only
completion with host-owned command evidence, supervised mutation only after
approval, and denial leaving the requested file absent. It does not measure live
model planning reliability.

The reload-interruption check exposed a lifecycle defect: only destruction of
`webContents` interrupted pending approvals. Reload and renderer crash retained
`waiting_for_approval`. The source fix also handles main-frame document replacement
and renderer process loss, ignores subframe and same-document navigation, and
settles repeated signals once. Its regression failed before the fix and passed
afterward; all 10 IPC integration tests and typechecking passed. The rebuilt
package then exposed a separate renderer gap: the task panel was not restored
after reload. Sessions now persist their task ID and fetch the latest snapshot
on selection, without automatically resuming. Stale lookups cannot populate a
different conversation, and task events retain their owning conversation after
ordinary turn completion.

The final rebuilt package passed the complete supervised fixture. Reload left
the pending write absent, approval interrupted, task paused, and worker leases
released. The restored Resume button started a new attempt; the write remained
absent until a fresh approval, then completed with host verification evidence.
All 134 nearby chat/session tests passed, followed by the full deterministic
suite at 1,319 passed, zero failed, and four live tests skipped.

The [native authorization fixture](../scripts/smoke-native-authorization.mjs)
exercised actual Windows dialogs through the packaged preload and main process.
Windows UI Automation confirmed the displayed objective, disposable workspace,
capability, risk ceiling, and all four budget values. Cancel returned no token;
Authorize mission returned an expiring token. Neither branch launched a task.
This was automation of real native controls, not a mocked `showMessageBox` result,
and not human signoff.

A separate `node scripts/smoke-missions.mjs --policy` run passed the complete
policy-scoped UI path with the scripted provider and actual native controls.
Cancelling preserved the draft and created no task. Authorizing the next launch
completed the disposable write and verification, recorded auto-approval
provenance, stayed within four tool results, and required no per-tool Approve
button. This is end-to-end authorization coverage, not live-model reliability.

Run `node scripts/smoke-missions.mjs` for the supervised path, including reload
and fresh-approval resume. Use `--policy` for the native policy-scoped path and
operate Cancel, then Authorize mission when prompted.

Run the native fixture with `node scripts/smoke-native-authorization.mjs cancel`
or `node scripts/smoke-native-authorization.mjs authorize`, then operate the named
native button within 120 seconds. Its reported PID is Electron's main process,
not the Windows shell wrapper. Both fixtures remove their temporary profiles
and workspaces. Dictation remains conditional on an available Whisper endpoint
and microphone; it was not exercised by these runs.

Final prerequisite inspection found a healthy Windows microphone endpoint
(`ELEGIANT SR030`), but no configured Whisper-compatible endpoint was available
for acceptance. The service on port 8080 is SearXNG, not transcription. Endpoint
metadata checks sent no microphone audio. Real dictation acceptance is blocked
until an endpoint is configured and the microphone workflow can be exercised;
a mocked transcription response is not a substitute. Final refreshed-package
startup and supervised reload/resume checks passed again after the evaluator fixes.

### September 15 dictation lifecycle follow-up

A regression test reproduced a microphone stream remaining open when the
dictation hook unmounted during recording. The hook now stops recording and
releases tracks without submitting audio on teardown. It also releases late
permission grants, ignores late transcription results, prevents duplicate starts
while permission is pending, and releases the stream when recorder construction
or startup fails. An already submitted transcription request is not aborted;
its result is ignored after unmount.

All ten dictation tests and 73 neighboring chat tests passed, as did typechecking,
the production build, refreshed unsigned packaging, and packaged startup smoke.
These use mocked media and transcription, not real microphone acceptance.
No transcription service was listening on the checked local ports (8000, 8001,
8080, 9000, or 11434) during the follow-up. No audio was captured and no service
was installed. A real endpoint and a participant for microphone testing are
still required before closing end-to-end dictation acceptance.

### Environment

- Ollama (or another OpenAI-compatible endpoint) running locally and reachable,
  for example `ollama serve` with at least one pulled model (`ollama pull llama3.1`).
- A clean build: `npm run build`.
- Launch the app: `npm start` (loads `dist-electron/electron/main.js` + `dist/index.html`).

## Smoke steps

1. **Provider setup**
   - Open Settings, enter the base URL (`http://localhost:11434/v1` for Ollama),
     and confirm the model dropdown populates from the provider.
   - Select a model; confirm the header shows the model name.
   - Confirm the Readiness category reports the selected model, workspace,
     approval mode, verification, automation scopes, pricing, and optional
     services.
   - Apply each readiness profile and confirm it never enables automatic
     mutation approval. Run **Test provider connection** before continuing.

2. **Plain chat (tools off)**
   - Disable tools in Settings.
   - Send "Say hello in one word." Confirm streamed text appears token by token
     and the turn ends without a tool card.

3. **New chat titling (regression for the sidebar fix)**
   - Click "+ New chat". Confirm the new row reads "New chat".
   - Send a first message. Confirm the sidebar row title updates to the message
     text immediately on send (not only after the turn completes), truncated near
     40 characters with an ellipsis for long input.
   - Reload the window (Ctrl+R). Confirm the title persists.

4. **Tool approval gate (auto-approve off)**
   - Enable tools, leave auto-approve off, set a workspace root.
   - Ask the model to create a disposable file using `write_file`. Confirm a tool card appears
     with "Approval required", Approve and Deny buttons.
   - Confirm the file does not exist before approval. Click Approve, then confirm
     the file is created and the result renders.
   - In a fresh turn, request a different disposable file and click Deny. Confirm
     the result shows a denial, the file remains absent, and the turn continues.
   - Read-only tools such as `read_file` do not require this mutation approval.

5. **Auto-approve provenance (regression for the inline auto tag)**
   - Enable auto-approve. Confirm the amber "Auto-approving tools" badge shows in
     the header.
   - Ask the model to write a file. Confirm the tool runs without a prompt and the
     tool card shows the inline "auto" tag next to the tool name.
   - Reload the window. Confirm the reloaded tool card still shows the "auto" tag
     (provenance persisted through the session store).
   - Confirm a read-only/allow-listed tool (e.g. read_file) does NOT show "auto".

6. **Abort mid-turn**
   - Start a long generation and click Stop. Confirm the turn ends with "Aborted"
     and the Send button returns.

7. **Dictation (if a Whisper endpoint is configured)**
   - Click Mic, speak, stop. Confirm transcribed text lands in the input box.

8. **Session switching**
   - Create two conversations, switch between them via the sidebar, and confirm
     each shows its own history and the selected row is highlighted.

9. **Supervised read-only mission**
   - Select Mission and open Review mission.
   - Keep Supervised selected and choose only read-only repository capabilities.
   - Describe a measurable acceptance criterion and select its verification
     method. Confirm Launch remains disabled until the method is complete.
   - Launch a repository inspection objective. Confirm no native authorization
     appears, the plan revision and worker role render, and deterministic
     evidence is attached to the acceptance criterion before completion.

10. **Supervised file mutation**
    - Keep Supervised selected and add a file mutation capability.
    - Launch a bounded file change. Confirm the concrete tool card requests
      approval before the write and denial prevents the mutation.
    - Approve a fresh attempt. Confirm the admitted artifact and verification
      evidence appear in Mission details.

11. **Policy-scoped bounded mutation**
    - Select Policy-scoped, set positive time, token, action, and cost budgets,
      then launch a bounded file change.
    - Confirm the native dialog names the objective, acceptance criterion,
      verification method, and authority scope.
    - Cancel once and confirm no task launches and the draft remains. Launch
      again, approve, and confirm usage never exceeds the reviewed budgets.

12. **Mission interruption and recovery**
    - Close or reload the renderer while a mutation approval is pending. Confirm
      the task pauses, the approval becomes interrupted, and the call is not
      replayed after resume.
    - Interrupt a mission while read-only workers are active. Confirm active
      workers settle, their step leases clear, and no dependent exclusive step
      starts until a deliberate resume creates fresh attempts.
    - Trigger a verification failure and confirm **Edit verification** reopens
      mission review instead of offering a blind Resume action.

13. **Background mission inspection**
    - Start a durable mission, then select another conversation while it runs.
      Confirm transient output remains visible only in the owning conversation.
    - Open **Run center**. Confirm the mission shows its current state and the
      **Inspect** action returns to the owning conversation without interrupting
      execution.
    - Expand **Run details** and confirm step state, consumed budgets, evidence
      pass count, and artifact count match the owning mission.
    - For paused or blocked work, select **Review and resume** and confirm Moss
      returns to the owning conversation and its specific recovery controls.
    - Export run diagnostics and confirm the JSON excludes objective text,
      evidence summaries, tool arguments, workspace paths, and artifact content.
    - Pause an executing run and confirm its current attempt stops before the
      durable task enters a resumable paused state.
    - Confirm an active mission can be cancelled from Run center and its final
      cancelled state remains inspectable.

14. **Mission templates**
    - Select each Coding, Research, and Automation template.
    - Confirm each template prefills an editable objective, outcome contract,
      verification method, capabilities, constraints, assumptions, and budgets.
    - Remove a required prerequisite. Confirm the missing workspace, verification
      command, or automation scope is named and Launch remains disabled.

15. **Local product diagnostics**
    - Open **Settings > Diagnostics** and confirm collection is off by default.
    - Enable collection, complete and abort separate turns, then reopen Settings.
      Confirm only categorical events and durations appear, including renderer
      startup, launch-to-first-response, stop settlement, and successful blocker
      or reload recovery when those paths were exercised.
    - Export the redacted JSON and confirm it contains no prompt, response, API
      key, workspace path, file content, or raw tool argument.
    - Clear diagnostics and confirm the retained event count returns to zero
      without changing the consent setting.

16. **Notifications and compact accessibility**
    - Trigger success, warning, and error status messages. Confirm their severity
      is conveyed consistently and errors include a local reference identifier.
    - Trigger a recoverable blocker and confirm its recovery action is reachable
      from the related status presentation.
    - Repeat Welcome, Settings, Run center, and mission review at 420 by 740.
      Confirm controls remain reachable by keyboard without horizontal clipping.
    - Run the packaged smoke suite and confirm axe reports no serious or critical
      findings for those surfaces.

17. **Approval previews, undo, and guidance**
    - Ask Moss to edit an existing file with auto-approve off. Confirm the
      approval card shows a line diff against the current file, and a new file
      is labelled **Create**. Confirm a command approval shows its working folder.
    - After the turn, expand the changed-file list, select **Undo turn**, choose
      **Keep changes** once, then confirm the undo and verify the files revert.
    - Ask for a browser visit to a domain outside the allow-list. Confirm the
      tool card names the allow-list rule and **Open settings** opens Automation.
    - Select a model that does not exist and send a message. Confirm the error
      offers a fix and **Open model settings**.
    - In a workspace with a `package.json` test script, open mission review and
      confirm the suggestion stays inactive until **Use** is selected.

18. **Notifications, shortcuts, and organisation**
    - Start a supervised mutation, then switch conversations or focus another
      application. Confirm a Windows notification appears for the approval and
      selecting it opens the owning conversation.
    - Confirm `Ctrl+K`, `Ctrl+N`, `Ctrl+,`, `Ctrl+J`, `Ctrl+Shift+L`, `Ctrl+L`,
      `Ctrl+B`, and `Esc` behave as documented, and `Ctrl+R` is not intercepted.
    - Pin a conversation, select two conversations, export them together, and
      delete them after confirmation.
    - Edit an earlier message, cancel once, then send an edit and confirm only
      later messages are replaced.
    - Enable larger text and high contrast, reload, and confirm both persist.
      Hide the getting-started guide and restore it from Settings.

19. **Model capability profile**
    - Select a local Ollama model and open **Settings > Models > Capability
      profile**. Run the probe at 8K and confirm progress advances through the
      seven dimensions and **Cancel probe** stops it.
    - Re-run to completion. Confirm scores, failure details, notes, median
      latency, and failed-request counts appear, and that the profile reloads
      after reopening Settings.
    - Select a model without tool support, such as `gemma3`, and confirm tool
      dimensions score 0 with a "does not support tools" note rather than
      counting as failed requests.
    - Select **Apply suggested settings** and confirm only the listed settings
      change; auto-approve and mission authority stay unchanged.
    - Run `npm run probe -- --model A --model B --max-context 8192` and
      confirm the comparison table matches the profiles shown in Settings.

20. **Adaptation, escalation, and replay**
    - Profile a small local model, select a workspace, and send a tool request.
      Confirm a notice names the adaptation and, for a limited model, that only
      one tool call runs per response.
    - Choose an escalation model with **After rejections** at 2, then ask the
      small model to read two files that do not exist. Confirm the escalation
      notice appears and later rounds use the stronger model.
    - Deny an approval and confirm the denial alone does not trigger escalation.
    - Turn on trace recording, complete a turn, and confirm the trace appears in
      **Recorded traces** with its model, call count, and outcome.
    - Replay the trace against another model. Confirm the per-call comparison
      appears, no workspace file changes, and **Cancel replay** stops a run.
    - Select **Delete all** and confirm the trace folder is emptied.

21. **Working state, supervisor, provenance, and skill trust**
    - Open **State**, add `secret.txt` as a protected path, and ask the model to
      overwrite it. Confirm the file is unchanged and the tool card or reply
      names the protection. Add an invariant and confirm the model follows it
      after **Continue in new chat**.
    - Ask the model to record a decision. Confirm it appears in **State** and
      that the model cannot remove it.
    - Ask for a task that loops, such as reading the same file repeatedly.
      Confirm the warning after three stalled rounds and that the turn stops
      and asks for guidance at the limit.
    - With auto-approve on, ask the model to fetch a web page and then write a
      file. Confirm the write asks for approval with the untrusted-content
      warning, and that a URL copied from the page is flagged.
    - Turn off **Ask before changes that follow web, MCP, or browser content**
      under **Settings > Safety** and repeat. Confirm the write runs under
      auto-approve, while a destructive command such as `rm -rf build` still
      asks.
    - In the Library, confirm new skills show their trust status and record.
      Demote a skill and confirm it no longer appears in the model's skill
      index; restore it and roll back to an earlier version.

22. **Constrained output, cross-provider routing, tool recovery, and data-level provenance**
    - Select `qwen2.5:1.5b` or `gemma3` on Ollama, profile it, select a
      workspace, and ask for a two-step task such as reading a file and then
      listing its folder. Confirm the "Using constrained tool output" notice,
      that each step runs as a normal tool card, and that the final answer
      appears.
    - Under **Routing and adaptation**, set **Constrained tool output** to
      **Never** and repeat. Confirm the notice is gone. Return it to
      **Automatic**.
    - Turn off adaptation and confirm constrained output stays off for the
      profiled model unless it is set to **Always**.
    - With a model that writes tool calls as text, confirm the "Recovered 1 tool
      call" and "Repaired" notices and that the call runs.
    - Save an API key for a cloud provider, return to Ollama, and choose that
      provider and a model for **Escalation model**. Confirm the off-machine
      warning in Settings. Trigger two rejections, for example by asking the
      local model to read files that do not exist, and confirm the escalation
      notice names the cloud destination and later rounds come from the cloud
      model.
    - Configure an embeddings model under **Settings > Knowledge**, turn on
      **Rank tools and lessons by meaning**, profile a limited model, and ask
      "why is CI red?". Confirm `run_command` is among the offered tools or
      that the model uses `find_tool` to enable it. Turn the option off and
      confirm no embeddings request reaches the endpoint during a turn.
    - With auto-approve on, fetch a web page, then fetch a link from that page
      exactly as written and run an unrelated web search. Confirm both run
      without a prompt. Then ask the model to fetch a URL the page did not
      contain, or a changed link on the page's host. Confirm each asks and the
      approval card shows the rule that applied.
    - Connect an MCP server that declares a read-only tool, check **trust
      read-only** under **Settings > Knowledge**, and confirm that tool runs
      without a prompt while its other tools still ask.

23. **Setup, live scores, context window, voting, Why, practice, quarantine, and procedures**
    - On a PC with Ollama, select **Set up for this PC** in the first-run guide.
      Confirm the proposal names models that fit the GPU, lists the context
      check and profiling, and changes nothing until **Apply**. Untick one line,
      apply, and confirm the progress list and that approval settings did not
      change.
    - Under **Capability profile**, confirm **Live results on your work** fills in
      after a few verified turns and that **Forget results** clears it.
    - Select **Check context window** for a large local model. Confirm the report
      shows served, trained, and GPU figures; when it offers a variant, create it
      and confirm the model switches and the original model still exists in
      `ollama list`.
    - With a limited, fast local model and constrained output on, confirm the
      "Voting on each step" notice, and set **Vote on each step** to **Never** to
      turn it off.
    - After an adapted turn, open **Why?** under the reply. Confirm the entries
      and that each settings link opens the right category.
    - Turn on trace recording and verification in a clean git workspace, finish
      a coding task, then select **Practice now** with two local candidates.
      Confirm the report, that the workspace, its `node_modules`, and
      `git worktree list` are unchanged afterwards, and that applying a
      recommendation changes only the named model. Confirm that a turn which
      fetched a web page is not re-run forward.
    - Turn on the quarantine reader under **Settings > Safety**, fetch a page
      containing an instruction to the assistant, and confirm **Why?** shows
      "Quarantined fetch_url output" and that the model does not act on the
      instruction.
    - Repeat the same verified two-step tool task three times. Confirm a
      candidate procedure appears in the Library, that the next similar request
      offers `run_procedure`, that each expanded step still asks for approval
      when it would, and that **Demote** removes it from the offer.

24. **Mission critic, judged replay, Run center decisions, and headless runs**
    - Under **Settings > Models > Routing and adaptation**, set **Critic for
      mission reviews** to a model from the same family as the chat model.
      Confirm the independence note, and that a mission with a critic check
      cannot launch. Pick a model from another family and confirm launch is
      allowed, with a weak-tier warning for a limited critic.
    - Launch a Research mission with a critic check bound to its report and a
      rubric requirement the report misses. Confirm the check fails with the
      unmet requirement named, and that a corrected report passes. Confirm
      **Why?** shows the critic decision.
    - Open **Run center**, select the run, and confirm **Why?** lists the
      decisions from every attempt.
    - Replay a recorded trace with the critic set. Confirm the report shows
      the reasonable and better counts for divergent steps.
    - In a terminal, run `npm run moss -- --model NAME --workspace DIR
      --approve safe --verify "npm test" --prompt "Fix the failing test"` on a
      workspace with one failing test. Confirm the exit code is 0 only when
      the test passes, 1 otherwise, and that `--approve deny` leaves the
      workspace unchanged.

25. **Email accounts and Playwright MCP defaults**
    - Under **Settings > Services > Email**, choose **Gmail or other SMTP
      account**, enter an address and an app password, and set **From name**
      to a plain name. Ask Moss to email yourself. Confirm the approval card
      appears, the message arrives from `Name <you@gmail.com>`, and that
      `moss.settings` in the renderer's localStorage (devtools > Application)
      shows empty `smtpPass` and `emailApiKey` values. Restart and confirm the
      password field is still filled.
    - Enter a wrong app password and confirm the reply explains that Gmail
      needs an app password.
    - With the Playwright MCP server enabled and no extra settings, confirm
      **Settings > Knowledge** shows it with 24 tools and both **trust
      read-only** and **ignore destructive flags** checked. With auto-approve
      on, ask Moss to open a review site and summarize a page. Confirm
      navigation and snapshots run without asking with the untrusted-content
      gate on, that a click asks while the gate is on and runs when it is off,
      and that clicking a button named "Submit order" always asks.
    - Middle-click and shift-click a link in a reply: it opens in your
      browser, not in a new Moss window. Drop an `.html` file onto the Moss
      window: nothing happens. Navigating Playwright to `file:///C:/` or
      `http://localhost:3000` asks for approval.
    - Choose **GitHub Copilot** under **Settings > Models > Provider** with the
      GitHub CLI signed in and **GitHub token** empty. Select **Load** and
      confirm your Copilot models appear. Ask a question that needs a file read
      and an edit: confirm the edit asks for approval as usual and the answer
      streams in. Enter a wrong token and confirm **Load** explains the sign-in
      problem.
    - Read a web page, then select **I have reviewed the earlier content** on
      the next approval card. Confirm that card still asks, and that changes in
      your next message no longer do.

## Pass criteria

- No uncaught errors in the main-process console or the renderer devtools.
- Streaming, tool approval, auto-approve provenance, abort, titling, background
  inspection, templates, diagnostics, notifications, compact layout, approval
  previews, undo, shortcuts, conversation organisation, mission authority,
  constrained output, cross-provider escalation, data-level provenance, setup,
  live scores, context fit, voting, Why, practice runs, quarantine, learned
  procedures, the mission critic, judged replay, headless runs, SMTP email with
  secure credential storage, the Playwright MCP defaults, and the GitHub Copilot
  provider behave as
  described above.
- Reload preserves session history, titles, task state, and the "auto" provenance
  tag without replaying an interrupted action.
