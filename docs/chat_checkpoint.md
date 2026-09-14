<!-- markdownlint-disable-file -->
# Moss — Chat Checkpoint (2026-06-29)

> [!NOTE]
> Historical snapshot from 2026-06-29, not current branch or release status.
> The commit state, next steps, and unresolved issues below describe that session
> only. See the [README](../README.md) for current contributor guidance and the
> [harness feedback loop](harness-feedback-loop.md) for evaluation acceptance.

Continuation summary for picking up in a fresh chat. Captures decisions, files
changed, current status, next steps, and open issues.

## Current status

- Full verify is green: `tsc` (both configs) + `vitest run` + `npm run build` all exit 0.
- HEAD is `2506345` (`feat(tools): add send_email tool via Resend`), in sync with `origin/master`.
- Uncommitted, working-tree changes (125 insertions / 8 deletions, 7 files) implement
  rich-formatted copy and email HTML. These pass the full suite but are **not committed**.

## Decisions made

- `send_email` uses the Resend HTTPS API over TLS — no SMTP library, no new deps.
  Server-side delivery/retries; refuses without API key or from address; 50-recipient cap.
- Email send stays out of `AUTO_ALLOW`: every send routes through the approval card.
- Copy must paste well-formatted: render assistant markdown to self-contained HTML and
  put both text and HTML on the clipboard.
- Clipboard prefers the Electron bridge, then async Clipboard API, then a
  textarea/`execCommand` fallback — never a silent no-op.

## Files changed (uncommitted)

- `electron/backend/moss/tools/email-tool.ts` — optional `html` body; validate from-address.
- `electron/backend/moss/tools/email-tool.test.ts` — html-body coverage.
- `electron/preload.cjs` — expose `clipboard.write(text, html)`.
- `electron/preload.test.ts` — clipboard mock.
- `src/components/ChatPanel.tsx` — `CopyButton` passes html; tri-layer `copyToClipboard`.
- `src/lib/markdown.ts` — `markdownToHtml` + escaping/inline helpers.
- `src/vite-env.d.ts` — `clipboard` on the `moss` bridge type.

## Next steps

1. Commit the rich-copy/email-html WIP (`feat: rich-formatted copy + email html`).
2. Push to `origin/master`.
3. Optional: run `electron-builder 25→26` upgrade per `docs/electron-builder-26-upgrade.md` (gated, elevated shell).

## Unresolved issues

- `tsconfig.json` `baseUrl` deprecation warning (harmless until TS 7.0; set `"ignoreDeprecations": "6.0"` to silence).
- `speaches` STT container exited 1 (`docker run ... speaches:latest-cpu`) — dictation backend not up.
