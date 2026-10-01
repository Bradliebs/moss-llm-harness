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
substantially in tool use, instruction following, and context capacity, so Moss
measures each model, adapts its tools and guidance to it, and can route hard work
to a stronger model on another provider.

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
* Sets itself up for your PC in one click: best local models that fit your GPU, escalation, embeddings, profiling, and the context window
* Profiles each model's tool, JSON, context, and planning reliability before you rely on it, then keeps score of how it does on your own verified work
* Adapts tools and guidance to the measured model, constrains small local models to schema-valid tool calls, escalates rejected work to a stronger model on any provider, and replays recorded turns against alternatives
* Keeps protected paths, invariants, and decisions in governed working state, stops unproductive loops, lets skills earn trust, and never lets untrusted content authorize a side effect
* Can read web and MCP content through a quarantine model with no tools, so planted instructions never reach the model that acts
* Practices on your recorded work while the PC is idle, learns procedures from repeated verified work, and shows why it made each decision in a turn
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

After the application opens, the quickest path on a PC with Ollama is **Set up
for this PC** in the first-run guide or at the top of **Settings > Models**. It
proposes a complete setup and applies only the lines you keep ticked. To
configure by hand:

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
For an independent review inside a mission, bind a critic check to a criterion
instead (see [Mission contract preflight](#mission-contract-preflight)).

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
| GitHub Copilot | GitHub Copilot | Not needed | Optional GitHub token; otherwise your GitHub CLI sign-in |
| Custom | OpenAI-compatible | User supplied | Provider dependent |

Custom OpenAI-compatible servers must expose model listing and chat completion
endpoints compatible with `/models` and `/chat/completions`.

### GitHub Copilot

Choose **GitHub Copilot** under **Settings > Models > Provider** to use the
models in your Copilot subscription, such as Claude, GPT, and Grok models. Moss
connects through GitHub's official Copilot SDK; GitHub retired the separate
GitHub Models API in July 2026.

* **Sign-in.** Moss uses your GitHub CLI sign-in (`gh auth login`), reading the
  token from `gh auth token` each time it connects and never storing it. To use
  another account, enter a GitHub token in **GitHub token**; it is kept in the
  OS-backed credential store. Select **Load** to check the sign-in and list the
  models your plan allows.
* **Usage.** You need a Copilot subscription, and prompts count toward your
  Copilot allowance. A turn that runs several tool rounds stays on one Copilot
  session, so the model's tool calls do not each start a new prompt.
* **Who runs the tools.** Copilot only decides which of Moss's tools to call.
  Copilot's own tools (shell, file edits, web) are never enabled; Moss runs every
  call itself, with its approvals, untrusted-content gate, protected paths, and
  verification. Tool names are sent to Copilot with a `moss_` prefix so they
  cannot be confused with its built-in tools.
* **Routing.** Copilot works as the chat model, the escalation or fast model, or
  the mission critic. It counts as a remote route, so escalating to it shows the
  usual notice. Pick a critic from a different model family than the worker.
* **Cost caps.** Copilot is billed by subscription, so Moss does not know a
  per-token price. A mission with a cost cap refuses a model without a known
  rate; set a rate for the model under pricing (0 if only your allowance
  matters) to use it there.
* **Headless.** `npm run moss -- --kind github-copilot --model claude-sonnet-5`
  works the same way, with `--api-key-env` naming a variable that holds a GitHub
  token when the GitHub CLI is not signed in.
* **Size.** The SDK includes the Copilot runtime, which adds about 130 MB to the
  installed app. Responses that must match a JSON schema are requested in the
  system message, because Copilot has no constrained-output option.

### Set up for this PC

**Set up for this PC** (in the first-run guide and at the top of **Settings >
Models**) checks your local Ollama server and models, your GPU, and any cloud
provider with a saved API key, then proposes a complete setup:

* **Chat model:** the strongest installed local model whose weights leave room
  in free GPU memory for an 8K-token context. Measured and live tiers come
  first; unprofiled models are ranked by size.
* **Fast model:** a smaller local model for summaries and read-only subagents.
  If your chat model stays on a cloud provider, it is set up as an Ollama route.
* **Escalation:** a strong model on a cloud provider you have a key for, or an
  Ollama cloud model, with a note that escalated turns leave this PC.
* **Ranking by meaning:** `nomic-embed-text` on this PC, downloaded if missing.
* **Profiling** of the chosen models, and a **context-window check** that
  creates a correctly sized variant when needed.

Each line can be unticked, and nothing changes until you select **Apply**. If
you already use a cloud provider, switching the chat model to a local one starts
unticked. Approval and authority settings are never part of the proposal. A
progress list shows each download, probe, and check as it runs.

### Model capability profiles

Models differ sharply in how reliably they call tools, return JSON, and stay on
track across several steps. **Settings > Models > Capability profile** measures
the selected model instead of assuming. The probe sends about 30 short requests
with fake tools that never run on your system, grades each reply locally, and
stores the latest profile per provider, endpoint, and model.

| Dimension | What it measures |
|-----------|------------------|
| Tool calling | Native function calls with correct arguments, and calls written as text instead |
| Tool selection | Choosing the right tool from five options |
| Tool restraint | Answering directly when no tool is needed |
| Structured output | Exact JSON objects, with partial credit when JSON is wrapped in prose or fences |
| Instruction following | Verifiable format rules, including one set in the system prompt |
| Usable context | Recalling a buried passcode at growing prompt sizes, and server-side truncation |
| Plan coherence | Finishing sequential tool chains of three, five, and seven calls against fake registers |

Each profile has a weighted score, a tier (strong, capable, limited, or
unreliable), a recommended scaffolding level, median response latency, and notes
such as Ollama's default context length, tool calls emitted as text, or argument
names outside the schema. When a native tool call fails, the probe also records
whether Moss's tool-call repair would have recovered a correct call; scores stay
native. **Apply suggested settings** can set the maximum tool rounds and context
limit. For Anthropic it turns tools off when tool calling fails most probes; for
OpenAI-compatible endpoints such as Ollama it leaves tools on, because
constrained tool output carries those models instead. It never changes approval
or authority settings.

Probes sample at temperature 0 so repeated runs are comparable. An untimed
warm-up request loads a local model before any probe is timed; a model that
cannot answer it is reported as unavailable instead of scored. Requests that
fail or time out are excluded from scores and listed separately, because a slow
reply says nothing about whether the answer would have been right. A server
response that the model does not support tools counts as a measured tool
failure. The usable-context probe recalibrates its prompt size from the
provider's reported token counts, and only suggests a context limit when a size
actually fails.

Run the same suite from a terminal to compare models on your own endpoint:

```powershell
npm run probe -- --model llama3.1:8b --model qwen2.5:7b --max-context 32768 --output profiles.json
npm run probe -- --kind anthropic --base-url https://api.anthropic.com --api-key-env ANTHROPIC_API_KEY --model claude-sonnet-4-5
```

The command defaults to local Ollama, reads an API key from the environment
variable named by `--api-key-env` (default `MOSS_PROBE_API_KEY`), accepts
`--only tool-calling,plan-coherence` to run selected dimensions and
`--timeout 240` for slow or reasoning models, and prints a side-by-side table.
It exits with status 1 when a model is unavailable. Cloud providers charge for
the tokens used; the profile records the total.

#### Live results on your work

A probe is a starting point; how a model does on your own work is the real
measure. After each turn Moss records host evidence for the model that ran it,
by task kind (coding, research, automation, missions, chat): verified passes and
failures, completed or blocked tasks, harness rejections, stalls, round caps,
and escalations away. The model's own claims never count, and turns with nothing
to grade, such as plain chat or a provider outage, are not scored.

**Capability profile** shows these results with a 95% confidence interval. Once
a model has at least 10 graded runs, clear evidence moves the tier that adaptation
uses by one step: up when even the pessimistic success rate is at least 75
percent, down when even the optimistic one is at most 45 percent. The probe tier
itself is unchanged, the Why timeline notes the adjustment, and **Forget
results** clears the evidence. Route pickers show each model's success rate on
your work next to its tier.

#### Context window

Ollama serves each model with a context window that may truncate long prompts,
or may be larger than your GPU can hold, which moves part of the model onto the
CPU and slows it several times. **Check context window** loads the selected
Ollama model and compares what the server actually serves with what the model
was trained for and what fits in free GPU memory (read with `nvidia-smi` when
available). When the window is too small, or the model spilled to the CPU, Moss
offers **Create variant and switch**: it creates a named copy such as
`qwen2.5:7b-ctx16k` with the right `num_ctx`, copies the capability profile to
it, and selects it. Your original model is never changed.

### Adaptive scaffolding

Once a model has a capability profile, Moss adjusts the structure of each tool
turn to it, using the tier as adjusted by live results on your work. Strong
models keep every tool and no extra guidance. Capable models
get guidance to work in small verified steps and at most 24 task-relevant tools.
Limited and unreliable models get a numbered-plan, one-step-per-response
instruction, at most 8 task-relevant tools (plus `find_tool` and any learned
procedures), and only the first tool call of each response runs; the model is told to issue the next call on its own. Models that
ignored a system-prompt rule during probing also get a short reminder in the
latest user turn. A notice describes each adaptation.

Tool relevance starts from word overlap between the request and each tool's name
and description, with core workspace tools preferred and housekeeping tools such
as memory and skill management ranked last unless the request names them. Turn
on **Rank tools and lessons by meaning** under **Routing and adaptation** to add
each tool's similarity in meaning, using the embeddings model from **Settings >
Knowledge** (for example `nomic-embed-text` on Ollama). "Why is CI red?" then
keeps `run_command` although it shares no words with it. The option is off by
default because each request's text goes to the embeddings endpoint. Tool
vectors are cached; a slow first request falls back to words and finishes in the
background for the next turn, and an endpoint that fails is left alone for 10
minutes. Whenever tools are narrowed, the model also
gets `find_tool`: it describes what it needs, and the best matching hidden tools
become available on its next step. Calling a hidden tool by name brings it in
too. A tool the harness withheld never counts toward escalation.

The adaptation changes only the model-facing request: saved conversations keep
the original messages. Missions keep their granted capabilities unchanged. Turn
it off under **Settings > Models > Routing and adaptation**.

### Constrained tool output and repair

Small local models often know which tool to use but write the call as text, use
argument names outside the schema, or wander between prose and JSON. Moss fixes
this in the provider adapter rather than hoping the model improves.

**Constrained output.** For OpenAI-compatible endpoints such as Ollama, each
request can carry a JSON schema instead of native tool definitions. Every
response must be either a call to one offered tool, with arguments that match
its schema, or a final answer, and the server enforces this with
grammar-constrained decoding. Moss turns each step back into an ordinary tool
call, so approvals, verification, and traces are unchanged. It also works for
models without native tool support, such as `gemma3`. On a three-step lookup
task through the real turn loop, `qwen2.5:1.5b` went from 0 of 3 with native
tool calling to 2 of 3 constrained, and `gemma3` from 0 of 3 to 3 of 3.

Choose it per model under **Routing and adaptation > Constrained tool output**:
**Automatic** (the default) turns it on for models whose stored profile is
limited or unreliable, **Always** forces it, and **Never** keeps native tool
calling. Automatic follows adaptive scaffolding, so turning adaptation off turns
it off too. Anthropic always uses native tools. Constrained answers arrive in
one piece rather than streaming, and a notice names the models it applies to.

**Tool-call repair** runs on every model, constrained or not, before anything
executes:

* Calls written as text are recovered from `<tool_call>` tags, `[TOOL_CALLS]`,
  JSON code blocks, bare JSON, and `name({...})`. Only offered tool names are
  accepted, so prose and code samples are not misread as calls.
* Tool names that differ only in case or punctuation are corrected.
* Argument names outside the schema are mapped by alias (`file` to `path`), by
  close spelling, or when one unknown argument matches the one missing required
  argument. Echoed schemas such as `{"type":"string","value":"Paris"}` are
  unwrapped, and numbers and strings are converted to the declared type.
* A call that still misses required arguments does not run. The model gets a
  precise error naming the missing and expected properties.

Each repair appears as a notice. The first schema error per tool is treated as a
correction rather than a rejection, so one fixable mistake does not trigger
escalation.

**Voting** makes constrained steps more reliable on local models. Moss samples
each step three times at a moderate temperature and runs the most common one
(the same tool with the same arguments). On the three-step lookup task above,
`qwen2.5:1.5b` went from 7 of 12 to 10 of 12 with voting, at about 2.5 times
the time per turn. Choose **Vote on each step** per model: **Automatic** votes
for limited and unreliable local models whose median reply takes under 4
seconds, **Always** votes whenever constrained output is on, and **Never** turns
it off. Cloud models never vote. The Why timeline notes steps where the samples
disagreed.

### Routing and escalation

**Settings > Models > Routing and adaptation** can route work across models and
providers:

* A fast model handles context-compaction summaries and read-only subagents
  started with the `delegate` tool
* An escalation model takes over a turn after Moss rejects the chat model's
  work a set number of times (default 2)
* A critic reviews mission outputs bound to a critic check, and judges replays.
  It must come from a different model family than the chat, escalation, and
  fast models, so the model that did the work never grades it. Moss refuses the
  check when a family is unknown or shared, and warns when the critic's measured
  tier is weak

Each route picks a provider and a model. **This connection** uses a model on the
current provider, including Ollama cloud models. Any other provider you have
configured, such as Anthropic or OpenAI, can be chosen too, so a local
`llama3.1:8b` can do most of the turns and escalate to Claude, or a cloud chat
model can hand summaries down to a local model. API keys stay in secure storage;
the main process looks up each provider's saved key, so select a provider under
**Provider** once to save its key before routing to it. Each route gets its own
daily budget guard, trace recording, and constrained-output decision.

Escalating off your machine sends the conversation and workspace context with
it. Settings warns when a route leaves the machine, and each escalation that
crosses from a local model to a remote one shows a notice naming the
destination, for example `api.anthropic.com` or Ollama's cloud service for
`:cloud` models served through a local Ollama.

Rejections are harness evidence only: a failed tool call, failed verification,
an empty response, or a refused task completion. Your own denials, policy
refusals, and tools the harness withheld never count, and the model cannot
request escalation itself. A plain chat answer that is merely unhelpful gives
the harness nothing to reject, so it does not escalate. Escalation applies to
ordinary turns, turn tasks, and missions. Mission budgets price every step at
the model that actually ran it, so a local step costs nothing unless you set a
rate for it and an escalated cloud step is charged at the cloud rate; a
cost-capped mission still refuses a remote model with no known rate. Each choice
shows the model's stored capability tier and latency.

### Turn traces and replay

Turn on **Record turn traces for replay** to save every model request and
response for a turn under the Moss user data folder. Traces contain conversation
and workspace content, so recording is off by default, nothing is uploaded, and
traces are deleted after 14 days or beyond the newest 200. Images are replaced
with placeholders.

Replay sends each recorded request, with exactly the context the original model
saw, to another model and compares the decisions: the same tool or answer,
arguments that fit the tool schema, and latency. No tool runs during replay, so
it cannot change your workspace; it measures decisions rather than end results.
A warm-up request loads the candidate model first. Replay from the trace list in
Settings, or from a terminal:

```powershell
npm run replay -- --dir "$env:APPDATA\moss\turn-traces" --last 5 --model qwen2.5:7b --model ministral-3:8b
npm run replay -- --trace path\to\trace.json --model llama3.1:8b --output replay.json
npm run replay -- --dir "$env:APPDATA\moss\turn-traces" --model qwen2.5:7b --judge glm-5.3-flash:cloud
```

The folder name follows the application's user data directory; **Open folder**
in Settings shows the exact location. The command reuses each trace's provider
endpoint unless you pass `--base-url` and `--kind`.

Agreement with the first model is not the same as doing well, so a replay can
also be judged. With a judge (the critic route in Settings, or `--judge` with
optional `--judge-base-url`, `--judge-kind`, and `--judge-api-key-env`), each
step where the candidate chose differently is graded on its own: does it serve
the request, does it rely on facts nobody has seen yet, and is it irrelevant or
premature? The baseline step gets the same questions, so the report shows how
many divergent steps were reasonable and how many were better than the
original. The judge must be from a different model family than the models it
grades.

### Practice runs

Your own work history becomes the benchmark. **Settings > Models > Practice
runs** compares local candidate models on your recorded turns:

* **Decisions.** Each candidate replays recent traces as above, and Moss
  compares tool choices, argument validity, and latency.
* **Outcomes.** When a trace was recorded in a clean git workspace with
  verification commands, Moss notes the commit. A practice run checks out that
  exact commit into a disposable `git worktree`. If verification already passes
  there, the trace cannot tell models apart and is skipped. Otherwise the
  candidate works the task forward in the copy, and your original verification
  commands grade the result.

Candidates get file tools inside the copy only: no shell commands, network,
browser, email, or anything that would ask for approval. Dependency folders such
as `node_modules` are linked into the copy so tests can run, and writes to them
are blocked. So are files that decide what verification runs, such as
`package.json`, lockfiles, `*.config.*`, `pyproject.toml`, `Makefile`,
`scripts/`, and `.github/`. Your verification commands still execute the
candidate's edits to source and test files inside the copy, as they do after
any turn. A trace whose recorded context includes web, MCP, browser, or other
untrusted content is used for decision replay only and never run forward
unattended. The copy is removed afterwards without following the dependency
links, and your workspace is never touched. Only models on this PC take part.

Turn on **Practice while this PC is idle** to run after 20 idle minutes on mains
power, at most once every 20 hours; starting a turn stops a run immediately. **Practice
now** runs on demand. The report shows each candidate's decision agreement,
valid arguments, median reply time, and verified tasks, and practice outcomes
feed the live scores at half weight. Moss recommends a change only with clear
evidence (a candidate passed more verified tasks than the models that ran them,
or matched at least 85 percent of decisions at no more than 0.6 times the
latency), and nothing changes until you select the recommendation. In a test
repository with a failing test, `qwen3.5:4b` fixed the bug in its practice copy
while `qwen2.5:1.5b` did not, and the original repository stayed unchanged.

### Why each decision was made

Every reply that the harness adapted has a **Why?** disclosure listing, in
order, what it decided and why: scaffolding and live-score adjustments,
constrained output and voting, tool-call repairs, `find_tool`, escalation,
approvals required by untrusted content, stalls, quarantined content, and
learned procedures. Each entry links to the setting that controls it. Recorded
traces keep the same list.

### Optional endpoints

Moss can reuse the active provider connection for several optional services, or
you can configure dedicated endpoints in Settings:

* Speech-to-text through an OpenAI-compatible `/audio/transcriptions` endpoint
* Codebase embeddings through an OpenAI-compatible `/embeddings` endpoint
* Email delivery through Resend with a verified sender address, or through
  Gmail or another SMTP account over TLS. Gmail needs an app password (Google
  Account > Security > App passwords), not your normal password. A bare name in
  **From name** sends as that name at the account address. The Resend key and
  the SMTP password are kept in the OS-backed credential store, not in
  localStorage; values saved by earlier versions move there on the next start.
  On a PC without secure credential storage they stay in Moss's settings
  instead, and the field says they are stored unencrypted.
  Every send asks for approval.

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
commands, file existence, file content, HTTP status, and critic review checks.
File and command checks also require a selected workspace. Commands must exactly
match entries enabled under **Settings > Verification**.

A critic check is for work a command cannot grade, such as a research report or
a summary. The critic from **Settings > Models > Routing and adaptation** reads
the step's artifacts and up to five bound workspace files, then answers a
numbered checklist. Moss numbers the requirements itself: each line or sentence
of the rubric, or the criterion when there is no rubric. The critic reports, per
requirement and item, whether it is met, with a quote as evidence. Moss decides
the verdict, not the critic: every numbered requirement must be checked and met,
and quoted evidence must actually appear in the materials. A checklist that
skips a requirement is sent back once, naming what it missed. A review with
invented quotes fails, and so does one where fewer than
half the checks quote verified evidence. Materials flagged for prompt injection,
or no materials at all, are refused rather than reviewed. Critic calls are
charged to the mission budget. In testing, small local critics that approved a
flawed report when asked for a single verdict caught it every time with the
checklist.

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
**Why?** on a run lists the harness decisions made during its attempts, such as
scaffolding, constrained output, escalation, and critic reviews.

### Harness layers

Moss treats the model as a replaceable, fallible component and keeps knowledge
about the task in the harness:

| Layer | How Moss implements it |
|-------|------------------------|
| Event record | Durable task journal, checkpoints, and opt-in replayable turn traces |
| Model profiles | Capability probe suite, live scores from your verified work, and context-window fit |
| Model adapter | Constrained step protocol for weak tool callers and tool-call repair for every model |
| Adjustable scaffolding | Meaning-ranked tool narrowing with `find_tool`, step guidance, and per-round call limits |
| Routing | Fast and escalation routes on any configured provider, with per-model mission pricing |
| Governed state | Per-conversation working state, rendered every round and never summarized away |
| Independent verification | Host-run checks bound to mission criteria, and a checklist critic from another model family; the model never grades itself |
| Earned memory | Skill trust ledger with versions, recalled lessons, and learned procedures that run without planning |
| Supervisor | No-progress detection, loop reminders, budgets, and a stop that asks you |
| Provenance security | Untrusted content can inform decisions but never authorize a side effect; an optional quarantine reader keeps raw content away from the acting model |
| Evaluation | Replay and practice runs against your own recorded work, graded by your verification or an independent judge |
| Front ends | The same kernel runs headless through `npm run moss`, for CI jobs and other hosts |

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

MCP tools ask for approval by default, because Moss cannot verify what they do.
Servers can annotate tools as read-only or destructive. A **destructive**
annotation is always honored, since it only adds a prompt. A **read-only**
annotation relaxes the policy, so it counts only for servers you trust: check
**trust read-only** next to a connected server under **Settings > Knowledge**. The
count shows how many tools that server declares read-only. Trusted read-only
tools run without a prompt, also after untrusted content, unless their
arguments derive from that content. The setting is stored as
`trustAnnotations` in `mcp-servers.json`.

Some servers flag every tool that is not a pure read as destructive. The
Playwright MCP server does this, which would mean a prompt before every
navigation or click on every site. Moss recognizes Playwright MCP and handles it
without any setup:

* Its blanket destructive flags are ignored, and its read-only flags (snapshot,
  screenshot, console) are trusted.
* `browser_evaluate` and `browser_run_code` are hidden from the model, which
  reads pages with `browser_snapshot` instead.
* Opening a page counts as a read, like the built-in browser: after untrusted
  content it asks only when the URL derives from that content rather than being
  a link followed exactly as written. Only public `http` and `https` pages count;
  `file:`, `javascript:`, and `data:` URLs, and addresses on this computer or a
  private network, always ask.

With auto-approve on under **Settings > Tools**, navigation, snapshots, clicks,
and typing then run without asking on any site. While **Ask before changes that
follow web, MCP, or browser content** is on (the default), clicks and typing
after a page has loaded still ask, as every change after untrusted content does;
reads and plain navigation do not. Uploads and installs always ask, and so does
any click or entry on a control named for an irreversible action such as buy,
order, pay, send, submit, or delete. Page code runs with your signed-in session, and Moss
cannot tell a script that only reads text from one that clicks or sends data,
which is why the code tools are hidden rather than auto-approved.

For other servers that flag everything, check **ignore destructive flags** next
to the server under **Settings > Knowledge**; the count shows how many tools it
flags. In `mcp-servers.json`, `trustAnnotations`, `ignoreDestructiveHints`, and
`hiddenTools` (raw tool names) override these defaults for any server, including
Playwright; for example `"hiddenTools": []` offers Playwright's code tools
again, and they ask every time they run.

A stdio server without a configured working directory runs in its own folder
under the Moss data folder (`mcp-servers/<id>`), so files it saves, such as
Playwright snapshots and screenshots, land there rather than in the folder Moss
was started from. A server launched with a relative path, such as
`node ./server.js`, needs `cwd` set in its configuration.

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

#### Skills earn trust

Every skill has a trust status that changes only with host evidence: passing
verification or a completed task, never the model's own claim.

* Skills you write or import start **trusted**. Skills the agent writes, and any
  version the agent rewrites, start as **candidates**.
* A candidate becomes trusted after three verified successes on its current
  version. Candidates are marked as unproven in the model's skill index.
* A skill is **demoted** after two consecutive failures, three failures in its
  last five uses, or its first failure after 90 days unused. Demoted skills
  leave the skill index and cannot be loaded until you restore them.
* Each content change creates a new version. The Library keeps the last five
  versions, shows each skill's verified record, and lets you trust, demote,
  restore, or roll back to an earlier version.

#### Lessons from earlier runs

Completed and failed tasks leave lessons: what worked, what failed, and why.
When a new request shares key words with a lesson, or is close in meaning to it
with **Rank tools and lessons by meaning** on, up to three are added to the
system prompt as guidance, not instructions. Lessons about failures are recalled
whenever failures back them; lessons about successes need a success rate of at
least 50 percent.

#### Learned procedures

When the same sequence of tools passes verification in three turns, Moss learns
it as a procedure. Argument values that never changed stay fixed, values that
varied become slots, and positions that always shared a value share one slot.
The model can then call `run_procedure` with just the slots. Moss expands it
into the procedure's ordinary tool calls, and each one goes through the normal
permission, provenance, and approval checks. The run stops at the first failed
step so the model can continue by hand.

Procedures matter most when they carry a step a model would otherwise forget.
Given a procedure learned from earlier version bumps that also updated
`CHANGELOG.md`, `qwen3.5:4b` updated both files in 3 of 3 runs, against 0 of 3
without it. A new procedure starts as a candidate, becomes trusted after three
verified uses, and is demoted after two failures in a row. Review, trust,
demote, restore, or delete procedures in the Library. Turn learning off under
**Settings > Knowledge > Learned procedures**; missions never use them.

### Working state

Long conversations lose detail when older turns are summarized. Moss keeps a
separate, typed **working state** for each conversation that is never
summarized away: invariants, protected paths, decisions with their reasons, open
questions, and established facts. Open it with **State** in the chat header.

* You can add any entry and remove any entry.
* The model records decisions, facts, and questions with the `working_state`
  tool. It can retire its own facts and answered questions, but it cannot remove
  invariants, protected paths, decisions, or anything you wrote.
* After untrusted content has entered the conversation, an invariant,
  decision, or protected path the model records needs your approval while the untrusted-content
  gate is on, because it would steer every later round. Facts and questions it
  records then are marked as coming after untrusted content.
* At 200 entries the oldest model facts, questions, and decisions make room
  first; your entries, invariants, and protected paths are never evicted.
* The state is rendered into the system message on every model round and sized
  to the context window: invariants and protected paths are always included,
  and older facts are dropped first when space runs short.
* **Protected paths** accept files, folders, and globs such as `migrations/**`.
  Moss refuses writes, edits, and moves that touch them, and commands that are
  not read-only and name them, before any approval prompt appears.
* **Continue in new chat** carries the working state into the new conversation.
  Missions render and enforce it too.

### No-progress supervisor

A round makes progress when it produces a new result or a file change Moss has
not seen before. Repeated identical calls, failed calls, rewriting a file with
the same content, and edits that undo earlier edits do not count. After three
stalled rounds Moss tells the model to change approach; at the limit (five by
default) it stops. An ordinary turn ends with a message asking you how to
proceed, and a task turn blocks so you can add guidance and resume. Set the
limit under **Settings > Tools**; 0 turns the stop off.

## Safety model

Moss separates reversible work from actions that can create external or
irreversible effects.

* Retrieved files, command output, web pages, and tool results are treated as
  untrusted data rather than instructions
* File paths are resolved inside the configured workspace, including through
  symbolic links and junctions, which may not point outside it
* Commands run without a prompt only when every part is a known read-only
  command that stays in the workspace: no `&` or `;` chains to other commands,
  input or output redirection, `$` or `%VAR%` expansion (which could print API
  keys), `env`, options that write files or run programs such as
  `--output` or `--pre`, or paths outside the workspace, including ones after an
  option such as `--file=/etc/passwd`
* While verification has commands to run, changes to the files that define
  the checks need approval even under auto-approve, so a model cannot make the
  checks pass without a fix. That covers `package.json`, lockfiles,
  `tsconfig*.json`, `*.config.*`, Python, Rust, Go, Maven, Gradle, .NET, and Ruby
  build files, `scripts/`, and CI workflows, whether a file tool or a command
  such as `npm pkg set` or `sed -i` changes them, and moving a folder that holds
  them
* Browser destinations are checked against a domain allowlist
* Desktop sessions require process and window allowlists
* Tool approvals are tied to runtime call identity instead of model-authored text
* The app window only ever shows Moss's own interface: links open in your
  browser, new windows are refused, and requests to add MCP servers, read or
  store keys, or authorize missions are answered only for the app's own page
* Destructive commands and final browser or desktop actions require approval.
  Final actions are recognized by the label of the control: buy, order,
  checkout, pay, transfer, book, send, submit, publish, confirm, delete, and
  similar words. A button labelled only with an icon or an unusual word is not
  recognized
* Untrusted content can inform a decision but never authorize a side effect
* Working-state protected paths are enforced by the host
* Verification failures prevent successful task completion
* Run journals and learned patterns are sanitized before persistence

Auto-approval can reduce prompts for eligible reversible actions. It does not
bypass controls for irreversible operations.

Once content from outside your request enters a conversation, every later change
needs your explicit approval, even with auto-approve on or under a
policy-scoped mission grant. This lasts beyond the turn that read the content,
because its text stays in the conversation. Untrusted sources are web search,
fetched URLs, MCP servers, browser and desktop inspection, and audio
transcription, plus a subagent report, a stored tool-output artifact, or a
mission step's artifact built from them, so a later mission step that acts on
a research step's findings asks too. When you have read what came in, select
**I have reviewed the earlier content** on the approval card's warning: from
your next message on, content from before that point no longer makes changes
ask. Editing or regenerating an earlier message withdraws that trust. Memory writes and deletions are included, so a web page cannot plant
or erase durable memories. Read-only actions still run without a prompt.

Reads that reach the network are tracked at the data level, so research does not
drown in prompts. Under auto-approve, `web_search`, `fetch_url`, and
`browser_navigate` keep running after untrusted content in two cases:

* Following a link that appeared verbatim in the content, because it discloses
  nothing the page did not already contain.
* A search that does not reuse a long token or eight-word passage from the
  content.

Any other URL asks first, including a changed link on a host the content named
or one of its subdomains, because a URL's host and path can carry data to
wherever the content pointed. Trusted read-only MCP tools follow the same rule
for their arguments.

The approval card names the untrusted sources, warns when the arguments reuse a
URL, email address, long token, or eight-word passage from that content, and
states the rule that required approval.

**Quarantine reader.** Turn on **Read web, MCP, and browser content through a
quarantine reader** under **Settings > Safety** to keep raw untrusted text away
from the model that can act. Each untrusted result goes to a separate model
call with no tools (the fast model when one is set), which must return a fixed
JSON shape: a summary, facts, up to five quotes, links, and whether the content
contained instructions. The acting model sees only that extract. Quotes are kept
only when they appear verbatim in the content, and links only when they are real
URLs the content contains; link text must also appear in the content. Facts and summary
sentences that read like instructions or name tools are dropped, even if the
reader passed them on. If the reader fails, the content is withheld and only its
links are passed on. The reader asks reasoning models to answer without a
thinking phase, and retries without that request on servers that reject it. Provenance still tracks the raw text, so approvals work as
before. In a test with a release-notes page containing a planted instruction to
write a file, `qwen3.5:4b` attempted the write in 3 of 4 runs without the reader
and 0 of 4 with it, and still summarized the notes correctly every time.

If you rely on browser or MCP automation and accept the risk, turn off **Ask
before changes that follow web, MCP, or browser content** under **Settings >
Safety**. Auto-approve then covers those changes too; destructive commands,
email, and irreversible browser or desktop actions still always ask.

Approval prompts describe the effect instead of showing only raw arguments.
File writes show a line diff against the file's current workspace content, or
mark the file as new. Edits show the replaced snippet, moves show both paths,
commands show the working folder and time limit, and emails show the sending
account, recipients, subject, and message. The raw arguments remain
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
| `npm run probe -- --model NAME` | Profile one or more models' tool, JSON, instruction, context, and planning reliability |
| `npm run replay -- --trace FILE --model NAME` | Replay recorded turn traces against other models without running tools |
| `npm run moss -- --model NAME --prompt TEXT` | Run one agent turn headless, without Electron; see [Headless runs](#headless-runs) |
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

## Headless runs

`npm run moss` runs one agent turn with the desktop app's kernel in plain
Node.js, with no Electron: the same permission policy, provenance gate,
no-progress supervisor, verification, adaptive scaffolding, and constrained
output. Use it in CI jobs, scripts, or another front end. It offers the
built-in workspace, git, command, web, and delegate tools. MCP servers, skills,
memory, working state, email, transcription, and the quarantine reader are not
available headless, so a run never writes the desktop app's memory.

```powershell
npm run moss -- --model llama3.1:8b --prompt "What does scripts/build.mjs do?"
npm run moss -- --model qwen2.5:7b --approve safe --verify "npm test" --prompt "Fix the failing test"
Get-Content task.md | npm run moss -- --model ministral-3:8b --json > run.jsonl
```

* **Endpoint.** It defaults to Ollama at `http://localhost:11434/v1`. Use
  `--base-url`, `--kind openai-compatible|anthropic|github-copilot`, and `--api-key-env VAR`
  for other providers (default variable `MOSS_API_KEY`). Keys come from the
  environment, never from the desktop app's secure storage, and are removed
  from it before any command runs, so the model cannot print them.
* **Approvals.** `--approve deny` (the default) refuses every call that needs
  approval and tells the model why. `safe` runs ordinary file changes and
  commands, but still refuses destructive calls and calls after untrusted
  content. Ordinary commands include network and publishing commands such as
  `git push` or `npm publish`, so use `safe` only in a disposable checkout or
  a CI job whose credentials you are willing to let the model use. `ask`
  prompts on the terminal. No mode approves those gated calls unseen.
* **Done means verified.** With `--verify CMD` (repeatable), the run cannot
  finish until the checks pass. A final answer that never ran them, or ran them
  and failed, is sent back to the model with the failure. After three failed
  attempts the run fails with exit code 1.
* **Scaffolding.** The model's measured profile from the desktop app, or from
  `--profile FILE` written by `npm run probe -- --output FILE`, decides the tool
  narrowing, step guidance, and constrained output (`--constrained
  auto|always|never`). Without a profile, the model gets every tool and no extra
  structure.
* **Output.** Plain mode streams the answer to stdout and tool activity to
  stderr. `--json` writes one JSON event per line, ending with a `run-summary`
  event; `--events-out FILE` saves the same events alongside plain output.
* **Exit codes.** `0` done (and verified, when checks are set), `1` failed or
  unverified, `2` bad arguments, `130` cancelled with Ctrl+C.
* **Data folder.** Runs share the desktop app's data folder, so profiles,
  lessons, and tool-output artifacts carry over. Override it with `--data-dir`
  or `MOSS_USER_DATA`.
* **Other flags.** `--workspace DIR` (default: current folder), `--prompt-file
  FILE` or stdin instead of `--prompt`, `--max-rounds N`, `--no-tools`, and
  `--instructions FILE` for project instructions.

Backend modules resolve their data folder through
`electron/backend/moss/runtime/user-data.ts`, so the kernel imports cleanly
outside Electron; only secure credential storage stays desktop-only.

## Project structure

```text
common/                  Shared IPC contracts, types, logging, and personalities
electron/
  backend/moss/          Agent runtime, tools, tasks, providers, and persistence
    cli/                 Headless agent runner (npm run moss)
    runtime/             Data-folder resolution that works with or without Electron
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
Model-harness tests cover capability probes, live scores, context-window fit,
constrained output, voting, tool-call repair, cross-provider routing and
escalation, provenance and the quarantine reader, practice runs in disposable
git worktrees, learned procedures, one-click setup, the mission critic and model
family independence, judged replay, and headless runs through `npm run moss`.
The bundle gate follows the renderer assets referenced by `dist/index.html` and
limits initial JavaScript to 600 KiB and CSS to 80 KiB. Settings, Library, Run
center, the command palette, artifact preview, PDF extraction, DOCX extraction,
the syntax highlighter, and its languages load only when their workflows need
them.

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
measured 625.2 KiB of initial JavaScript (the budget was higher then; it is now
600 KiB) and 62.9 KiB of CSS. The unsigned package
passed axe serious and critical checks on Welcome, Settings, Run center, mission
review, and the compact layout, plus supervised mission smokes. Production
dependencies reported no npm audit vulnerabilities. Remaining advisories affect
development tooling only and require the gated Vitest and electron-builder major
upgrades.

The September 23 UX follow-up passed 1,531 deterministic tests with four gated
live tests skipped, 18 mission IPC end-to-end tests, focused lint, and coverage
of 94.04% statements and 85.57% branches. The initial renderer bundle measured
656.1 KiB of JavaScript (before the syntax highlighter was split out) and 66.5 KiB of CSS. The packaged smoke added axe checks
for the command palette and verified the getting-started guide; supervised
mission smokes passed. Windows notifications and approval diffs still need the
interactive checks in the [GUI smoke checklist](docs/e42-gui-smoke-checklist.md).

The September 27 harness round (mission critic, judged replay, Run center
decisions, and headless runs) passed 1,796 deterministic tests with four gated
live tests skipped, the expanded focused lint, and coverage of 94.83% statements
and 84.36% branches. The initial renderer bundle measured 516.4 KiB of JavaScript
and 69.2 KiB of CSS. The unsigned package passed the packaged smoke and the
supervised mission smokes, and `eval:health` passed. Live runs with local
Ollama models checked the checklist critic against good and flawed reports, the
replay judge, and headless fix-and-verify runs in `safe` and `deny` modes.

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

### Moss keeps asking to approve browser or MCP steps

After web search, a fetched page, or MCP or browser output enters a turn, Moss
asks before every later change, even with auto-approve on, and the approval card
shows an untrusted-content warning with the rule that applied. Searches that do
not reuse that content, and links followed exactly as the content wrote them,
keep running.
MCP tools count as changes unless their server declares them read-only and you
trust its annotations: check **trust read-only** next to the server under
**Settings > Knowledge**. If you accept the remaining risk, turn off **Ask before
changes that follow web, MCP, or browser content** under **Settings > Safety**
and keep auto-approve on under **Settings > Tools**. Destructive commands, email,
and irreversible actions still ask.

If the approval card says **Why approval is needed: The tool's server declares
it destructive**, neither setting applies: the server itself flagged the tool,
and Moss always asks before those. Moss already ignores Playwright MCP's
blanket flags; for another server, check **ignore destructive flags** next to it
under **Settings > Knowledge** (see [Model Context Protocol](#model-context-protocol)).
The setting is per server, so it covers every site that server visits.
The card can still show the untrusted-content warning for information after
you turn the gate off.

### A small local model writes tool calls as text

Moss repairs calls written as text automatically. If the model still misuses
tools, profile it under **Settings > Models > Capability profile**; limited and
unreliable models then use constrained tool output automatically. You can also
set **Constrained tool output** to **Always** for the current model under
**Routing and adaptation**. Constrained output needs an OpenAI-compatible
endpoint whose server supports JSON-schema `response_format`, which current
Ollama versions do.

### A local model is slow or cuts off long prompts

Open **Settings > Models > Capability profile** and select **Check context
window**. If Ollama serves more context than fits in GPU memory, part of the
model runs on the CPU; if it serves too little, long prompts are cut off. Create
the suggested variant to fix either. If even a small context does not fit, the
check says so; choose a smaller model or quantization.

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
