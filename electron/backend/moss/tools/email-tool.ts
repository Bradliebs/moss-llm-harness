// electron/backend/moss/tools/email-tool.ts
//
// Model-callable tool: send an email through the configured account. Two
// routes are supported: the Resend HTTPS API, or an SMTP account such as Gmail
// with an app password (sent over TLS by nodemailer). Credentials come from
// settings (ctx.email); without them the tool refuses. Like the other network
// tools it is approval-gated (not in AUTO_ALLOW), so the model-chosen
// recipient/subject are shown before any send.

import { createTransport } from "nodemailer";

import type { EmailConfig, SmtpConfig } from "../../../../common/types";
import type { Tool, ToolResult } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 20_000;
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Message {
  from: string;
  to: string[];
  subject: string;
  body: string;
  html?: string;
}

function asRecipients(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  return [];
}

function addressOf(from: string): string {
  return from.replace(/^.*<([^>]+)>.*$/, "$1").trim();
}

/** Resolve the sender for the configured route, or explain what is missing. */
function senderFor(email: EmailConfig | undefined): { from: string } | { error: string } {
  if (email?.provider === "smtp") {
    const smtp = email.smtp;
    if (!smtp?.host.trim() || !smtp.user.trim() || !smtp.pass.trim()) {
      return { error: "No SMTP account configured (set server, username, and app password in Settings)." };
    }
    const from = email.from.trim() || smtp.user.trim();
    if (!EMAIL_RE.test(addressOf(from))) {
      return { error: "Invalid from address (use your account address, e.g. Name <you@gmail.com>)." };
    }
    return { from };
  }
  if (!email?.apiKey) return { error: "No email API key configured (set one in Settings)." };
  if (!email.from) return { error: "No from address configured (set one in Settings)." };
  if (!EMAIL_RE.test(addressOf(email.from))) {
    return { error: "Invalid from address (use a verified sender, e.g. Name <you@domain.com>)." };
  }
  return { from: email.from };
}

async function sendViaResend(apiKey: string, message: Message, signal: AbortSignal): Promise<ToolResult> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      ...(message.html ? { html: message.html } : {}),
    }),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw) as { message?: string; error?: string };
      detail = j.message || j.error || detail;
    } catch {
      /* keep raw text */
    }
    return { ok: false, content: `Resend error ${res.status}: ${detail}` };
  }
  let id = "";
  try {
    id = (JSON.parse(raw) as { id?: string }).id ?? "";
  } catch {
    /* no id in body */
  }
  return { ok: true, content: `Email sent to ${message.to.join(", ")}${id ? ` (id ${id})` : ""}` };
}

async function sendViaSmtp(smtp: SmtpConfig, message: Message, signal: AbortSignal): Promise<ToolResult> {
  const port = Number.isInteger(smtp.port) && smtp.port > 0 ? smtp.port : 465;
  const transport = createTransport({
    host: smtp.host.trim(),
    port,
    // Implicit TLS on 465; any other port must upgrade with STARTTLS.
    secure: port === 465,
    requireTLS: port !== 465,
    // Google shows app passwords in spaced groups; the spaces are not part of it.
    auth: { user: smtp.user.trim(), pass: smtp.pass.replace(/\s+/g, "") },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    const info = await Promise.race([
      transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        ...(message.html ? { html: message.html } : {}),
      }),
      aborted,
    ]);
    const id = typeof info?.messageId === "string" ? info.messageId : "";
    return { ok: true, content: `Email sent to ${message.to.join(", ")}${id ? ` (id ${id})` : ""}` };
  } catch (e) {
    const err = e as Error & { code?: string; responseCode?: number };
    if (err.code === "EAUTH" || err.responseCode === 535) {
      return {
        ok: false,
        content: `SMTP login failed for ${smtp.user.trim()}. Gmail needs an app password (Google Account > Security > App passwords), not your normal password.`,
      };
    }
    throw e;
  } finally {
    transport.close();
  }
}

export const sendEmailTool: Tool = {
  name: "send_email",
  description:
    "Send an email through the configured account (Resend or an SMTP account such as Gmail). Provide one or more recipient " +
    "addresses, a subject, and a plain-text body. Requires email to be set up in Settings.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address. Multiple addresses may be comma-separated.",
      },
      subject: { type: "string" },
      body: { type: "string", description: "Plain-text body." },
      html: { type: "string", description: "Optional HTML body; sent alongside the plain-text body." },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args, ctx) {
    const sender = senderFor(ctx.email);
    if ("error" in sender) return { ok: false, content: sender.error };
    const email = ctx.email!;

    const to = asRecipients(args.to);
    const subject = typeof args.subject === "string" ? args.subject.trim() : "";
    const body = typeof args.body === "string" ? args.body : "";
    const html = typeof args.html === "string" && args.html.trim() ? args.html : undefined;
    if (to.length === 0) return { ok: false, content: "to is required" };
    if (to.length > MAX_RECIPIENTS) return { ok: false, content: `too many recipients (max ${MAX_RECIPIENTS})` };
    const bad = to.filter((a) => !EMAIL_RE.test(a));
    if (bad.length > 0) return { ok: false, content: `invalid recipient address: ${bad.join(", ")}` };
    if (!subject) return { ok: false, content: "subject is required" };
    if (!body.trim()) return { ok: false, content: "body is required" };
    const message: Message = { from: sender.from, to, subject, body, ...(html ? { html } : {}) };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      return email.provider === "smtp"
        ? await sendViaSmtp(email.smtp!, message, controller.signal)
        : await sendViaResend(email.apiKey, message, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, content: "Send timed out or aborted" };
      return { ok: false, content: `Send failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
