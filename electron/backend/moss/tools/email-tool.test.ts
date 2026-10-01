// electron/backend/moss/tools/email-tool.test.ts
//
// Unit tests for the send_email tool. The Resend network call is stubbed, so
// these exercise the tool's own logic: config guards, recipient parsing and
// validation, required-field checks, the POST shape, and error handling.

import { afterEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => {
    smtp.createTransport(options);
    return { sendMail: smtp.sendMail, close: smtp.close };
  },
}));

import { normalizeSmtpPassword, sendEmailTool } from "./email-tool";
import type { ToolContext } from "./types";

const EMAIL = { apiKey: "re_test", from: "Moss <noreply@moss.local>" };

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { workspaceRoot: "/work", signal: new AbortController().signal, email: EMAIL, ...overrides };
}

const args = { to: "a@b.com", subject: "Hi", body: "Hello" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  smtp.sendMail.mockReset();
  smtp.close.mockReset();
  smtp.createTransport.mockReset();
});

describe("send_email", () => {
  it("refuses without an API key", async () => {
    const res = await sendEmailTool.execute(args, ctx({ email: undefined }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No email API key");
  });

  it("refuses without a from address", async () => {
    const res = await sendEmailTool.execute(args, ctx({ email: { apiKey: "re_test", from: "" } }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No from address");
  });

  it("refuses a malformed from address", async () => {
    const res = await sendEmailTool.execute(args, ctx({ email: { apiKey: "re_test", from: "not-an-email" } }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Invalid from address");
  });

  it("validates recipients, subject, and body", async () => {
    expect((await sendEmailTool.execute({ to: "", subject: "s", body: "b" }, ctx())).content).toBe("to is required");
    expect((await sendEmailTool.execute({ to: "nope", subject: "s", body: "b" }, ctx())).content).toContain("invalid recipient");
    expect((await sendEmailTool.execute({ to: "a@b.com", subject: " ", body: "b" }, ctx())).content).toBe("subject is required");
    expect((await sendEmailTool.execute({ to: "a@b.com", subject: "s", body: " " }, ctx())).content).toBe("body is required");
  });

  it("posts to Resend and reports the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendEmailTool.execute({ to: "a@b.com, c@d.com", subject: "Hi", body: "Hello" }, ctx());
    expect(res).toEqual({ ok: true, content: "Email sent to a@b.com, c@d.com (id abc)" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ from: EMAIL.from, to: ["a@b.com", "c@d.com"], subject: "Hi", text: "Hello" });
  });

  it("includes an html body when provided", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmailTool.execute({ to: "a@b.com", subject: "Hi", body: "Hello", html: "<b>Hi</b>" }, ctx());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toBe("<b>Hi</b>");
  });

  it("surfaces a Resend error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad key" }), { status: 401 })));
    const res = await sendEmailTool.execute(args, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Resend error 401: bad key");
  });
});

describe("send_email over SMTP", () => {
  const GMAIL = { host: "smtp.gmail.com", port: 465, user: "me@gmail.com", pass: "abcd efgh ijkl mnop" };
  const smtpCtx = (from = "", account = GMAIL) => ctx({ email: { provider: "smtp", apiKey: "", from, smtp: account } });

  it("refuses without a complete SMTP account", async () => {
    const res = await sendEmailTool.execute(args, smtpCtx("", { ...GMAIL, pass: "" }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No SMTP account configured");
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it("sends over implicit TLS from the account address by default", async () => {
    smtp.sendMail.mockResolvedValue({ messageId: "<m1@gmail.com>" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendEmailTool.execute({ ...args, to: "a@b.com, c@d.com", html: "<b>Hi</b>" }, smtpCtx());

    expect(res).toEqual({ ok: true, content: "Email sent to a@b.com, c@d.com (id <m1@gmail.com>)" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: "me@gmail.com", pass: "abcdefghijklmnop" },
    }));
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: "me@gmail.com",
      to: ["a@b.com", "c@d.com"],
      subject: "Hi",
      text: "Hello",
      html: "<b>Hi</b>",
    });
    expect(smtp.close).toHaveBeenCalled();
  });

  it("requires STARTTLS on other ports and keeps a configured from name", async () => {
    smtp.sendMail.mockResolvedValue({});
    const res = await sendEmailTool.execute(args, smtpCtx("Moss <me@gmail.com>", { ...GMAIL, port: 587 }));

    expect(res).toEqual({ ok: true, content: "Email sent to a@b.com" });
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false, requireTLS: true }));
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Moss <me@gmail.com>" }));
  });

  it("turns a bare display name into a sender at the account address", async () => {
    smtp.sendMail.mockResolvedValue({});
    const res = await sendEmailTool.execute(args, smtpCtx("Moss Assistant"));
    expect(res.ok).toBe(true);
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: "Moss Assistant <me@gmail.com>" }));
  });

  it("keeps spaces in passwords that are not Google app passwords", () => {
    expect(normalizeSmtpPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(normalizeSmtpPassword(" ABCD EFGH IJKL MNOP ")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeSmtpPassword("my pass phrase 2")).toBe("my pass phrase 2");
  });

  it("explains a rejected Gmail login", async () => {
    smtp.sendMail.mockRejectedValue(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }));
    const res = await sendEmailTool.execute(args, smtpCtx());

    expect(res.ok).toBe(false);
    expect(res.content).toContain("app password");
    expect(smtp.close).toHaveBeenCalled();
  });

  it("reports other SMTP failures", async () => {
    smtp.sendMail.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await sendEmailTool.execute(args, smtpCtx());

    expect(res).toEqual({ ok: false, content: "Send failed: connect ECONNREFUSED" });
  });

  it("stops waiting when the turn is aborted", async () => {
    smtp.sendMail.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = sendEmailTool.execute(args, { ...smtpCtx(), signal: controller.signal });
    controller.abort();

    expect(await pending).toEqual({ ok: false, content: expect.stringContaining("Check the Sent folder before sending it again") });
    expect(smtp.close).toHaveBeenCalled();
  });
});
