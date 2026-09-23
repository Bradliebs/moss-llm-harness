---
title: Moss
description: A local-first agentic desktop harness for completing and verifying work across files, commands, browsers, and desktop applications
author: Moss contributors
ms.date: 2026-09-23
ms.topic: overview
keywords:
  - ai agent
  - electron
  - ollama
  - model context protocol
  - desktop automation
estimated_reading_time: 12
---

<p align="center">
  <img src="./build/icon.png" alt="Moss logo" width="180">
</p>

## Overview

Moss is a local-first desktop AI harness built to carry tasks from request to
verified completion. It combines streamed model conversations with durable task
state, workspace tools, browser and desktop automation, reusable skills,
persistent memory, and Model Context Protocol (MCP) integrations.

Moss can connect to a local Ollama server, the Anthropic Messages API, or an
OpenAI-compatible endpoint such as OpenAI, LM Studio, vLLM, Groq, or OpenRouter.
The selected model must support the behavior required by the task. Models vary
substantially in tool use, instruction following, and context capacity.

> [!IMPORTANT]
> Moss can execute commands and modify files. Select a dedicated workspace,
> review approval requests, and keep backups or source control enabled.

## Highlights

* Runs multi-step tasks through an explicit, recoverable lifecycle
* Requires task evidence and configured verification before claiming completion
* Starts missions from editable Coding, Research, and Automation templates
* Monitors background missions from an accessible Run center
* Guides setup through readiness profiles and categorized, searchable Settings
* Records opt-in, content-free product diagnostics locally
* Previews file diffs and command context before you approve changes
* Notifies you when background work needs attention, with per-turn undo
* Offers a command palette, keyboard shortcuts, larger text, and high contrast
* Reads, writes, searches, and checkpoints files inside the selected workspace
* Runs shell commands with risk classification and approval controls
* Uses isolated, domain-allow-listed Playwright browser sessions
* Automates allow-listed Windows applications through semantic UI Automation
* Connects to local or remote MCP servers over standard I/O or HTTP
* Stores durable memories and reusable skills between conversations
* Indexes a codebase through a configurable embeddings endpoint
* Supports image, Word (.docx), PDF, and text attachments, dictation, and optional email delivery
* Streams safe GitHub-flavored Markdown with highlighted, copyable code
* Tracks token usage, context consumption, estimated cost, and tool history
* Persists multiple independent conversations with search and management controls
* Supports conversation-specific personalities and memory-informed adaptive tone
* Evaluates runtime and prompt variants through isolated, resumable task matrices

## Requirements

* Windows 10 or Windows 11 for the packaged application and desktop automation
* Node.js 20 or later
* npm
* At least one supported model provider

Ollama users need a running Ollama installation and at least one downloaded chat
model. The default provider URL is `http://localhost:11434/v1`.

## Quick start

Install dependencies, build the main process and renderer, then launch Electron:

```powershell
npm install
npm run dev
```

On Windows, you can also use the launcher, which stops stale Electron processes,
rebuilds the application, and starts Moss:

```powershell
.\start.bat
```

After the application opens:

1. Open **Settings**.
2. Select Ollama, OpenAI, Anthropic, or Custom.
3. Enter the provider URL and API key when required.
4. Select a model from the automatically refreshed list; refresh again if needed.
5. Choose a workspace before enabling file or command tools.
6. Configure optional verification commands for coding tasks.
7. Start a conversation and describe the outcome you want.

### Guided readiness and profiles

The welcome screen summarizes provider, workspace, tools, verification,
automation, pricing, and optional-service readiness. Open **Settings** for the
complete checklist and a provider connection test.

Settings includes safe starting profiles:

* Chat only disables tools and automation
* Coding enables workspace tools while retaining explicit mutation approval
* Research enables browser tooling while retaining explicit approval
* Desktop automation enables Windows automation while retaining explicit
  approval
* Custom preserves direct control of every setting

Profiles never enable automatic mutation approval or invent verification
commands. Search Settings or use its category routes to focus on readiness,
diagnostics, models, tools, automation, knowledge, services, safety, or general
preferences.
The **Copy diagnostics** action exports a local readiness snapshot without API
keys or the workspace path.

The separate **Diagnostics** category can enable local product diagnostics.
Collection is off by default. When enabled, Moss retains bounded timing, outcome,
approval, blocker, verification, startup, first-response, stop-settlement, and
recovery categories for 7, 30, or 90 days. It never stores prompts, responses,
file contents, API keys, workspace paths, or raw tool arguments. You can inspect
recent event categories, clear them, or export the redacted JSON from Settings.

Status notifications use consistent info, success, warning, and error severity.
Errors remain assertive for assistive technology and include a stable local
reference when no correlation identifier is supplied. Recovery actions can be
attached to the same notification instead of being presented as unrelated UI.

## Optional TypeSafe Jev integration

Jev is a structured decision model, not a replacement for your chat provider.
Moss exposes it as the optional `jev_evaluate` tool in ordinary chat, using
TypeSafe's official SDK and `jev-latest` model. It can answer a narrow yes/no
question with a probability, select a choice, or score text against a rubric.

1. Open **Settings**, then find **TypeSafe / Jev**.
2. Enter your TypeSafe API key and select the save icon. The key is encrypted
  with Electron's OS-backed credential storage, not saved in localStorage.
3. Turn on **Use Jev** and keep the main tools switch enabled.
4. Ask Moss to use Jev for a structured judgment, then review and approve the
  proposed context before it is sent to TypeSafe.

The global switch defaults off and takes effect on the next turn. Saving a key
does not enable it. Turning the switch off removes the tool from subsequent
turns; use **Stop** to cancel a current turn. Removing the key also disables Jev.
The assistant decides whether to call the tool. Enabling Jev does not call it
on every message, automatically review answers, or automatically route requests.

To request it explicitly, include the text to evaluate and ask, for example:

* "Use Jev to choose whether this ticket is billing, technical, or sales."
* "Use Jev to score this proposal using the levels unclear, adequate, and clear."
* "Use Jev to assess whether this message requests urgent help."

If the assistant calls Jev, a `jev_evaluate` approval request appears before
any context is sent. Declining it means no TypeSafe API call. Jev cannot browse
or inspect files itself; the assistant must supply the relevant evidence.

Each call requires approval even when general tool auto-approval is enabled.
Only the supplied state and question are sent, not the whole conversation
automatically. Review them for sensitive data. TypeSafe charges are separate
from Moss's chat-model cost display and budget cap. Requests have a 15-second
timeout and no automatic retries; cancellation cannot undo data already sent.
Results are advisory and never replace tool permissions or host verification.
Durable missions do not expose Jev because their budgets do not account for it.

See the [TypeSafe introduction](https://docs.typesafe.ai/introduction) for the
question types. After building, `node scripts/smoke-jev.mjs` checks settings,
encrypted key persistence, opt-in routing, approval, and responsive layout
with a disposable profile and mocked TypeSafe responses. It uses no real key
and does not establish live API reliability.

## Conversation management

Each conversation keeps its own message history and personality override. Moss
persists conversations locally, restores the selected conversation after a
reload, and derives a title from the first user message.

Use the left sidebar to create, search, select, rename, pin, export, copy, or
delete conversations. Pinned conversations stay at the top of the list. Choose
**Select conversations** to export several conversations into one Markdown file
or delete them together after a confirmation. Collapse the sidebar to a narrow
rail with its toolbar button or `Ctrl+B`; Moss remembers the choice. In a compact
window, open the same conversation list from the menu button in the chat header.
Creating or selecting a conversation closes the compact list and displays that
conversation's history.

Select **Edit** on an earlier message to load it into the composer. The original
conversation is unchanged until you send the edit, which replaces that message
and everything after it. **Cancel edit** or `Esc` restores the empty composer.

The **Clear** action removes messages from the selected conversation while
keeping its entry. **Continue in new chat** creates a separate conversation with
a bounded summary of the current context and leaves the original unchanged.

When a configured context window approaches its input budget, Moss summarizes
the oldest model-facing turns into a bounded assistant-authored note. The
summary call cannot use tools, excludes raw tool output and arguments, and is
counted in token usage. If summarization fails, Moss falls back to deterministic
trimming. Saved conversation history is never changed. Provider-reported
context overflow uses the same compaction path for one retry.

Large tool results remain complete in saved conversation history and the live
tool card. To protect model context, Moss stores an oversized result as an
opaque application artifact and sends the model a bounded head-and-tail preview
with an artifact ID. The read-only `read_tool_output` tool can retrieve another
range or search the stored text without exposing its host path. Artifacts are
kept outside the selected workspace and are pruned after seven days or when the
store exceeds 200 records.

### Clarification questions

In ordinary chat, Moss can ask up to four questions in a compact form when it
needs preferences or missing details. Choose an option, use **Other** for a
custom answer, or fill in a text field, then select **Send answers**. The answers
become one normal user message; they do not approve tools or launch a mission.
An existing composer draft and its attachments stay separate.

Only the latest completed questionnaire is actionable. Older forms are disabled;
interrupted, incomplete, or malformed responses stay as text. Model support for
the format varies. Unsubmitted form entries reset when you reload or switch
conversations. Do not enter credentials or secrets into clarification fields.

After building, run `node scripts/smoke-clarification.mjs` to check streaming,
submission, reload, Stop, and responsive layout with a local scripted provider
and disposable profile. This checks the interface, not live model reliability.

### Artifact workspace

When a mission has saved artifacts, use **Open artifacts** in the chat header
or select an artifact under **Mission details**. The workspace opens beside
the conversation on wide windows and fills the chat area on narrow windows.
Choose an artifact, switch between **Preview** and **Source**, or copy its text.
Close the pane with its close button or Escape.

This view reads stored mission snapshots, not arbitrary workspace files or the
separate oversized-tool-output store. Markdown reports render without active
HTML, external images, or navigable links; other file types display as text.
The host checks task membership and content integrity before returning content.
Previewing an artifact does not verify its claims or execute tools.

After building, run `node scripts/smoke-artifacts.mjs` for a disposable-profile
Electron check covering previews, copy, reload, integrity rejection, and desktop
and narrow-window screenshots. It makes no model calls.

### Interactive result tables

Completed chat responses and Markdown artifact previews provide sorting,
filtering, row selection, and CSV export for rectangular tables with up to
1,000 rows and 30 columns. Streaming responses and larger tables retain their
plain rendering. Click a column heading to cycle through ascending, descending,
and original order. Filtering searches all cells; selection stays with each row.

CSV export includes visible rows in their current order. When rows are selected,
only selected visible rows are exported. Hidden selections remain selected but
are not exported. Formula-like values, including negative numbers, receive a
leading apostrophe so they are treated as literal text by spreadsheet importers
that honor this convention. Export does not preserve Markdown formatting.

Reset clears the filter, sort, and selection. These controls are temporary and
reset on reload or when switching conversations or artifacts; they never change
the saved response or verify the underlying data. Existing link and HTML
restrictions still apply.

After building, run `node scripts/smoke-tables.mjs` to check sorting, filtering,
selection, an actual CSV download, and desktop and narrow-window layouts in a
disposable Electron profile without model calls.

## Provider configuration

| Provider | Kind | Default base URL | API key |
|----------|------|------------------|---------|
| Ollama | OpenAI-compatible | `http://localhost:11434/v1` | Not normally required |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` | Required |
| Anthropic | Anthropic | `https://api.anthropic.com` | Required |
| Custom | OpenAI-compatible | User supplied | Provider dependent |

Custom OpenAI-compatible servers must expose model listing and chat completion
endpoints compatible with `/models` and `/chat/completions`.

### Optional endpoints

Moss can reuse the active provider connection for several optional services, or
you can configure dedicated endpoints in Settings:

* Speech-to-text through an OpenAI-compatible `/audio/transcriptions` endpoint
* Codebase embeddings through an OpenAI-compatible `/embeddings` endpoint
* Email delivery through Resend with a verified sender address

## Task execution

A durable Moss task records its objective, acceptance criteria, execution steps,
attempts, evidence, blockers, and current state. The runtime persists this state
so interrupted work can be inspected and resumed instead of silently discarded.

The task lifecycle includes planning, execution, verification, recovery, pause,
resume, cancellation, failure, and evidence-gated completion. Verification can
combine task-specific evidence with newline-separated commands configured in
Settings, such as tests, type checks, or builds.

### Mission contract preflight

Before launch, every mandatory acceptance criterion needs a measurable outcome
and an explicit verification method. The mission review supports configured
commands, file existence, file content, and HTTP status checks. File and command
checks also require a selected workspace. Commands must exactly match entries
enabled under **Settings > Verification**.

Launch remains disabled until the contract passes preflight. Constraints and
assumptions are optional, but become part of the reviewed mission specification
when supplied. Policy-scoped authorization binds the complete contract,
capabilities, budgets, and automation scopes to its token. Editing any bound
field requires fresh authorization.

Mission intake includes Coding, Research, and Automation templates. Each template
prefills an editable objective, outcome contract, verification method,
capabilities, constraints, assumptions, and budget. Missing workspace,
verification, browser, or desktop prerequisites remain visible and continue to
block launch. Templates use the same preflight and native authorization paths as
manually authored missions.

When a workspace is selected, mission review suggests verification commands
inferred from project files such as `package.json` scripts, `pyproject.toml`,
`Cargo.toml`, `go.mod`, .NET projects, Maven, Gradle, and Makefile test targets.
Suggestions stay inactive until you select **Use**, which enables the command
under **Settings > Verification** and binds it to the first eligible mandatory
criterion.

While a mission runs, the task status bar warns when any action, token, cost,
or time budget reaches 80 percent, before the mission blocks on exhaustion.

When a turn changes files, Moss creates a checkpoint. The response footer lists
each changed file and whether the turn created or modified it. **Undo turn**
asks for confirmation, then restores modified files and deletes created ones
while the checkpoint remains available.

### Durable approvals and task history

Approval requests for durable tasks are persisted before Moss waits for a
decision. The record correlates the task, turn, and tool call, and the renderer
can attach an optional reason to an approval or denial. Moss persists the
decision before releasing the waiting runner, so a displayed task state does not
claim that approval is pending after execution has begun.

An unresolved approval cannot be bypassed through the generic Resume action. If
the application or renderer stops while a decision is pending, Moss records the
approval as interrupted and pauses the task. Resuming creates a new model
attempt; Moss never replays the interrupted tool call automatically.

Each task also exposes an ordered, read-only timeline derived from its append-only
journal. The renderer receives concise transitions, attempts, approval outcomes,
and evidence results. Raw snapshots, tool arguments, approval comments, model
output, and evidence summaries are excluded from this history projection.

### Run center and background inspection

Use **Run center** in the conversation sidebar to inspect active, waiting,
blocked, paused, completed, failed, and cancelled missions. Each run remains
bound to the conversation that launched it. Switching conversations does not
interrupt durable work, and transient output never appears in another
conversation. While a run is active elsewhere, other conversations remain
read-only until you return to the owning conversation or cancel the run.

The sidebar marks conversations with mission state. Run center summarizes step
progress, consumed budgets, passing evidence, and artifact counts. It can open
the owning conversation, route paused or blocked work to its recovery controls,
cancel an active durable task through the main-process task controller, or
pause active work, or export a sanitized per-run diagnostic summary. Pausing
aborts the current attempt before the durable task enters its resumable state.

### Agent execution design

Moss applies selected ideas from [12-Factor Agents](https://github.com/humanlayer/12-factor-agents),
[Agent Control Plane](https://github.com/humanlayer/agentcontrolplane), and
[HumanLayer](https://github.com/humanlayer/humanlayer) without adding those
runtimes as dependencies. The shared principles include explicit control-flow
ownership, structured tool calls, compacted context, persisted approval state,
human feedback, restart reconciliation, and an observable event timeline.

Moss remains a local, single-process desktop application. Per-task serialization,
revision checks, atomic snapshots, and the append-only journal provide the
coordination required in that environment. The project does not adopt Kubernetes
controllers, custom resources, distributed leases, remote approval channels,
webhook triggers, or a separate agent daemon. Those mechanisms become relevant
only if multiple processes or machines can advance the same task.

## Tools and integrations

### Workspace tools

Workspace tools can inspect directories, search source, read and write files,
apply patches, and run commands. Path validation keeps file operations inside the
selected workspace. Command operations are classified as read-only, mutating, or
destructive before execution.

Tools that explicitly support cooperative cancellation can declare an execution
deadline. Moss aborts the tool at that deadline and waits for its cleanup to
settle before reporting a timeout. Tools that do not declare this capability do
not receive a generic deadline that could abandon work in the background.

During one turn, Moss also tracks consecutive calls with the same tool name and
canonical arguments. At increasing thresholds it adds an advisory to the
model-facing result, prompting the model to inspect prior evidence or change its
approach. The advisory does not block the call or alter the result retained in
conversation history.

### Browser automation

Browser automation uses Playwright sessions scoped to a durable task. It can
navigate, inspect accessibility or text content, interact with controls, capture
screenshots, and assert page state. Navigation is limited to explicitly allowed
domains, including redirects and subsequent requests.

Enable browser automation and add allowed hostnames in Settings before use.

### Desktop automation

Desktop automation uses Windows UI Automation rather than unrestricted screen
coordinates. Sessions are restricted to configured process names and exact
window titles. Supported operations include semantic inspection, control
interaction, text entry, option selection, screenshots, and state assertions.

Enable desktop automation and configure both process and window allowlists in
Settings before use.

### Model Context Protocol

Moss can connect to MCP servers using standard I/O or HTTP transports. The
Library and Settings surfaces expose server status and management, while the
runtime adapts MCP tool names to provider-safe identifiers.

Server configuration may include commands, arguments, working directories,
environment variables, URLs, and headers. Treat third-party MCP servers as code
with the same access as the account running Moss.

### Memory and skills

Memory stores durable facts and preferences for later conversations. Skills store
reusable instructions that the model can load when their descriptions match a
task. Both can be reviewed and managed from the Library.

Use **Import folder** in the Library to recursively install directories that
contain `SKILL.md` files. Moss preserves supporting files and license documents,
skips existing skill IDs, and leaves imported skills disabled until you review
and enable them. Supporting text files are available to enabled skills through
the skill-resource tool without granting access outside the skill directory.

Adaptive tone uses remembered preferences to adjust wording, formality, and
detail without replacing the selected personality or built-in safety guidance.

## Safety model

Moss separates reversible work from actions that can create external or
irreversible effects.

* Retrieved files, command output, web pages, and tool results are treated as
  untrusted data rather than instructions
* File paths are resolved inside the configured workspace
* Browser destinations are checked against a domain allowlist
* Desktop sessions require process and window allowlists
* Tool approvals are tied to runtime call identity instead of model-authored text
* Destructive commands and final browser or desktop actions require approval
* Verification failures prevent successful task completion
* Run journals and learned patterns are sanitized before persistence

Auto-approval can reduce prompts for eligible reversible actions. It does not
bypass controls for irreversible operations.

Approval prompts describe the effect instead of showing only raw arguments.
File writes show a line diff against the file's current workspace content, or
mark the file as new. Edits show the replaced snippet, moves show both paths,
and commands show the working folder and time limit. The raw arguments remain
available beneath the preview. When a tool is blocked, the tool card names the
rule that applied, such as the workspace sandbox, a browser or desktop
allow-list, mission authority, or your denial, and links to the Settings
category that controls it.

## Response experience

Assistant responses render sanitized GitHub-flavored Markdown. Raw model HTML is
not executed. Safe links open through the Electron shell bridge, and fenced code
uses a curated set of lazily loaded Shiki grammars.

The response surface supports headings, nested lists, task lists, tables,
blockquotes, inline code, highlighted code blocks, copy controls, regeneration,
checkpoint reversion, token details, and a streaming indicator. User messages
remain compact bubbles while assistant responses use a wider document layout.

Recognized provider failures include a short fix and a direct action: rejected
API keys, unavailable models, unreachable providers, and spending caps open model
settings; rate limits and temporary server errors offer **Retry**; context
overflow offers **Continue in new chat**.

### Notifications, shortcuts, and accessibility

Moss shows a Windows notification when background work needs approval, a
mission blocks, or a reply finishes or fails while the window is unfocused or
you are viewing another conversation. Selecting the notification focuses Moss
and opens the owning conversation. Turn this off under **Settings > General**.

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open the command palette for actions and conversations |
| `Ctrl+N` | Start a new chat |
| `Ctrl+,` | Open Settings |
| `Ctrl+J` | Open Run center |
| `Ctrl+Shift+L` | Open Library |
| `Ctrl+L` | Focus the message box |
| `Ctrl+B` | Collapse or expand the sidebar |
| `Esc` | Stop the current response, or cancel an edit |

Shortcuts avoid Electron's reload and developer-tools accelerators. **Settings >
General** also offers larger text, a high-contrast mode with stronger borders and
focus outlines, and a keyboard shortcut reference. Screen readers hear concise
announcements when a reply completes, fails, or needs approval, instead of every
streamed token. Settings reopens on the category you last used.

New installations show a three-step getting-started guide: connect a model,
choose an optional workspace, and try a safe read-only request. Hide it from the
welcome screen and restore it from **Settings > General**.

### Chat attachments

Use Attach, drop files onto the composer, or paste files from the clipboard.
Images are limited to 10 MB each and require a model that supports the image
format. Common image extensions are recognized even when MIME metadata is missing.
Markdown (`.md`, including `.MD`) and other text files are limited to 256 KB each.

Word `.docx` and PDF files are limited to 10 MB each. Moss extracts their text
locally and attaches it as a document, with a 256 KB extracted-text limit.
Word formatting and embedded images are not included; scanned PDFs require OCR
outside Moss. Empty, unreadable, or oversized documents produce an error.
Legacy `.doc` files must be saved as `.docx` before attaching.

Run `node scripts/smoke-attachments.mjs` after building to check Word, Markdown,
and image attachment handling in a disposable Electron profile.

## Development commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Build both application layers and launch Electron |
| `npm run dev:renderer` | Start the Vite renderer server without Electron preload APIs |
| `npm run start` | Launch Electron from existing build output |
| `npm run typecheck` | Type-check the renderer and Electron projects |
| `npm run lint` | Lint the product-quality surfaces with zero warnings allowed |
| `npm test` | Run the Vitest test suite once |
| `npm run test:deterministic` | Run the deterministic CI test tier |
| `npm run test:coverage` | Run the deterministic tier with focused V8 coverage thresholds |
| `npm run test:sandbox` | Run four live containment tests with a provisioned, digest-pinned Linux Node.js image |
| `npm run eval -- dry-run scripts/eval-pilots.cjs` | Validate the evaluation matrix without invoking a model |
| `npm run eval:health` | Validate corpus, reference solution, and grader publication health |
| `npm run build` | Build the Electron main process and Vite renderer |
| `npm run check:bundle` | Enforce initial renderer JavaScript and CSS budgets |
| `npm run pack` | Create an unpacked application directory |
| `npm run pack:ci` | Create an unsigned unpacked application for CI and local smoke checks |
| `npm run smoke:packaged` | Check packaged setup, Run center, templates, diagnostics, accessibility, and compact layout |
| `node scripts/smoke-missions.mjs` | Run supervised approval, denial, reload, and recovery mission smokes |
| `npm run dist` | Build a Windows NSIS installer |

The renderer alone expects APIs injected by `electron/preload.cjs`. Running
`npm run dev:renderer` in a normal browser is useful for targeted UI work only
when those APIs are mocked.

## Project structure

```text
common/                  Shared IPC contracts, types, logging, and personalities
electron/
  backend/moss/          Agent runtime, tools, tasks, providers, and persistence
  ipc/                   Main-process IPC handlers
  main.ts                Electron composition root
  preload.cjs            Restricted renderer bridge
src/
  components/            React application surfaces
  lib/                   Renderer stores, formatting, pricing, and utilities
docs/                    Design notes and operational checklists
scripts/                 Repository maintenance utilities
```

The main process owns provider calls, tools, durable tasks, MCP connections, and
privileged operating-system access. The React renderer communicates through the
typed preload and IPC contracts instead of importing Node.js APIs directly.

## Testing

Run all checks used for normal development:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm run check:bundle
```

Before a release, also run `npm run pack:ci`, `npm run smoke:packaged`, and
`node scripts/smoke-missions.mjs`.

Tests cover renderer behavior, IPC, providers, tool execution, permissions,
approvals, checkpoints, capability acquisition, browser and desktop boundaries,
task recovery, verification, memory, skills, learning, and the evaluation harness.
The bundle gate follows the renderer assets referenced by `dist/index.html` and
limits initial JavaScript and CSS independently. Settings, Library, Run center,
the command palette, artifact preview, PDF extraction, DOCX extraction, and
syntax languages load only when their workflows need them.

The evaluation harness runs production-loop tasks in isolated workspaces and
grades their end state with independent validators. It supports governed corpus
splits, matched approval and tool-recovery scenarios, mechanism-specific metrics,
paired family-level release comparisons, and resumable concurrent matrices.

The representative corpus contains 30 cases in 15 matched pairs. Budget,
destructive-action, permanent-failure, verification, context, resume, browser,
desktop, and MCP cases exercise their runtime mechanisms. Browser and desktop
cases use production tools with stateful injected fakes, not live applications.
MCP cases use the production namespaced adapter with a fake client, not network
transport. Context cases force compaction and durable retrieval; resume cases
seed `TaskStore` and recover through `TaskEngine.recoverInterruptedTasks`, not a
full `MissionController` restart. Expected budget stops and verification blocks
pass only with exact structural traces and mandatory artifact checks; evaluation
success does not necessarily mean task completion.

A separate product UX corpus covers nine deterministic setup, recovery,
intervention, and background-run scenarios. Cases include provider setup
recovery, unverifiable criteria, unknown pricing, unavailable capabilities,
approval denial, post-compaction continuation, reload during approval,
configuration-change recovery, and background mission inspection. Sanitized
trace metrics measure intervention count, recovery attempts, approval latency,
user-visible error quality, and false completion. Each case also names the
executable regression that supplies its evidence, and corpus health checks fail
when that evidence is missing.

Contributor quality gates include focused ESLint checks for the refactored
product-quality surfaces and V8 coverage thresholds of 75% statements, 60%
branches, 70% functions, and 75% lines. The packaged smoke suite runs serious
and critical axe checks on Welcome, Settings, Run center, mission review, and a
420 by 740 compact layout. Run `npm run lint`, `npm run test:coverage`, and
`npm run smoke:packaged` to exercise these gates locally.

Default contributor runs use `MOSS_EVAL_EXECUTION=local` and
`MOSS_EVAL_PURPOSE=iteration`: three pilot cases or 20 representative development
cases, without Docker. Representative local iteration excludes six container
cases and four validation cases. A named local release selects 24 of 30 cases;
a full release with two variants and three repetitions contains 180 cells.
Command-capable cases and enabled command verification require a digest-pinned
Linux container; there is no host-shell fallback. The four live containment tests
require Docker's Linux engine, cgroup v2, and `MOSS_EVAL_SANDBOX_IMAGE`.

Commands run in a 32 MiB tmpfs workspace with read-only host input and validated
snapshot copy-back. The kernel quota applies to commands, not host-side file
tools. Snapshot replacement is not transactional under host disk failure, and
host concurrency is trusted. This evaluation isolation does not sandbox ordinary
desktop chat commands.

Compact reports exclude raw transcripts. Rich, sanitized diagnostic capture is
local and opt-in through `--diagnostics-dir`; review it before sharing because
redaction cannot guarantee removal of all sensitive content. Production failures
become draft case families that require human review and health checks before
explicit regression promotion. Portable datasets preserve split and lineage
metadata. Full release comparisons require complete coverage, a named release
measurement, and a compatible reviewed baseline; passing local tests alone is
not provider-backed release evidence.

September 2026 verification includes passing deterministic tests, typechecking,
four live containment tests, packaged startup, and scripted supervised missions
covering approval, denial, reload interruption, and explicit resume. All 30 cases
passed corpus health. Scripted GUI checks do not establish live-model reliability.

The latest complete 180-cell cloud measurement recorded 175 task passes and
180 security passes using explicit fixture approval in the distinct
`phase5-baseline-gated` and `phase5-candidate-gated` variants. Five model refusals
left the planned denial unexercised without executing any tools. All artifact
checks passed and protected inputs remained intact. The September 14 full
deterministic suite passed 1,325 tests with zero failures and four gated live tests
skipped. The September 15 dictation lifecycle follow-up passed 83 focused tests,
typechecking, the production build, and refreshed packaged startup checks. See
the [dictation lifecycle evidence](docs/e42-gui-smoke-checklist.md#september-15-dictation-lifecycle-follow-up)
for the tested fixes and real-audio acceptance limits.
Historical reports, including the earlier auto-approval mismatch, remain unchanged.
Real dictation still requires a configured Whisper-compatible endpoint. Release
acceptance and baseline promotion remain subject to the evidence and review gates.

The September 22 harness and UX audit verification passed 1,483 deterministic
tests with four gated live tests skipped, 18 mission IPC end-to-end tests, focused
lint, and coverage of 92.1% statements and 82.51% branches. The production build
measured 625.2 KiB of initial JavaScript and 62.9 KiB of CSS. The unsigned package
passed axe serious and critical checks on Welcome, Settings, Run center, mission
review, and the compact layout, plus supervised mission smokes. Production
dependencies reported no npm audit vulnerabilities. Remaining advisories affect
development tooling only and require the gated Vitest and electron-builder major
upgrades.

The September 23 UX follow-up passed 1,531 deterministic tests with four gated
live tests skipped, 18 mission IPC end-to-end tests, focused lint, and coverage
of 94.04% statements and 85.57% branches. The initial renderer bundle measured
656.1 KiB of JavaScript and 66.5 KiB of CSS. The packaged smoke added axe checks
for the command palette and verified the getting-started guide; supervised
mission smokes passed. Windows notifications and approval diffs still need the
interactive checks in the [GUI smoke checklist](docs/e42-gui-smoke-checklist.md).

See the [harness feedback loop guide](docs/harness-feedback-loop.md) for corpus
selection, provider runs, report inspection, resume behavior, and CI tiers.

## Packaging

Create an unpacked Windows build:

```powershell
npm run pack
```

Create the NSIS installer:

```powershell
npm run dist
```

Build artifacts are written to `release/`. The installer is per-user by default,
supports a custom installation directory, and packages the application in an
ASAR archive.

## Troubleshooting

### No models appear

Confirm the provider is running, the base URL is correct, and the API key is
valid. For Ollama, verify the model has been pulled locally before refreshing the
model list.

### The renderer is blank in a browser

Launch Moss with `npm run dev` or `npm start`. The application depends on the
Electron preload bridge and is not designed to run as a standalone website.

### A task cannot use files or commands

Choose a workspace in Settings and confirm tools are enabled. Operations outside
that workspace are rejected by design. The tool card names the rule that blocked
the call and links to the Settings category that controls it.

### Browser navigation is denied

Add the destination hostname to the browser domain allowlist. Every redirect and
request must remain within the configured set. **Open settings** on the blocked
tool card opens the Automation category directly.

### Desktop controls are unavailable

Desktop automation requires Windows, an allowed process name, an exact allowed
window title, and controls exposed through Windows UI Automation.

### A task remains blocked after a failed check

Use the recovery action shown with the blocker. Verification failures reopen the
mission contract so you can edit the criterion or verification method. Budget
failures reopen mission review. Credential and unavailable-service blockers open
Settings, while user-decision blockers focus the composer for guidance.
Resumable external interruptions retain the Resume action. Moss does not convert
failed verification into completion or blindly repeat the same failed check.

### Notifications do not appear

Confirm **Settings > General > Notify me when background work needs approval,
blocks, or finishes** is on, and that Windows notifications are allowed for Moss
under **Settings > System > Notifications**. Moss only notifies when its window
is unfocused or you are viewing a different conversation. Unpackaged
development builds started with `npm run dev` may not show Windows notifications,
because Windows associates them with an installed app shortcut.

### A keyboard shortcut does nothing

Global shortcuts pause while a dialog such as Settings or Run center is open,
except `Ctrl+K`, which still closes the command palette. Close the dialog first,
or open **Settings > General > Keyboard shortcuts** for the full list.

### An approval shows no diff

Comparing an overwrite with the existing file needs a selected workspace;
without one, Moss shows only the new content. Files larger than 256 KB, binary
files, and changes over 1,500 combined lines show a summary instead. Expand
**Raw arguments** to review the exact request.

## Additional documentation

* [Historical chat checkpoint (June 2026)](docs/chat_checkpoint.md)
* [Electron 42 GUI smoke checklist](docs/e42-gui-smoke-checklist.md)
* [Planned Electron Builder 26 upgrade](docs/electron-builder-26-upgrade.md)
* [Harness feedback loop](docs/harness-feedback-loop.md)
* [Harness reliability audit (September 2026)](docs/harness-reliability-audit-2026-09-18.md)
