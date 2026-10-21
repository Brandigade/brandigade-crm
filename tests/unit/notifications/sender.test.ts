import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermanentJobError, RetryJobLater } from "../../../lib/server/jobs.js";
import {
  classifyResendError,
  classifySmtpError,
  parseFrom,
  publicSenderInfo,
  redactSecrets,
  sendEmail,
  senderConfig,
} from "../../../lib/server/notifications/sender.js";
import { features } from "../../../lib/server/env.js";

const env = { ...process.env };
const SENDER_VARS = [
  "RESEND_API_KEY",
  "RESEND_API_BASE",
  "NOTIFICATION_FROM_EMAIL",
  "DUE_TASK_FROM_EMAIL",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "APP_NAME",
];
beforeEach(() => {
  for (const k of SENDER_VARS) delete process.env[k];
});
afterEach(() => {
  process.env = { ...env };
});

const msg = { to: "eddie@crm.test", subject: "Due now: Call\r\nBcc: evil@x.co", html: "<p>hi</p>", text: "hi", idempotencyKey: "task_reminder:t1:2026-10-17:10:00:at_due" };

describe("sender selection", () => {
  it("none configured -> null (and the feature flag agrees)", () => {
    expect(senderConfig()).toBeNull();
    expect(features.notifications()).toBe(false);
    expect(publicSenderInfo(null)).toEqual({ configured: false, kind: null, label: null, from: null });
  });
  it("Resend wins, then Gmail, then generic SMTP", () => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "57325";
    expect(senderConfig()!.kind).toBe("smtp");
    process.env.GMAIL_USER = "brandigade.crm@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(senderConfig()!.kind).toBe("gmail");
    process.env.RESEND_API_KEY = "re_test_123456789012";
    expect(senderConfig()!.kind).toBe("resend");
    expect(features.notifications()).toBe(true);
  });
  it("Gmail: smtp.gmail.com:465 over TLS, sending as the account, app password without spaces", () => {
    process.env.GMAIL_USER = "brandigade.crm@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.NOTIFICATION_FROM_EMAIL = "Brandigade CRM <crm@brandigade.com>";
    const cfg = senderConfig()!;
    expect(cfg.smtp).toEqual({ host: "smtp.gmail.com", port: 465, secure: true, user: "brandigade.crm@gmail.com", pass: "abcdefghijklmnop" });
    expect(cfg.from).toEqual({ name: "Brandigade CRM", address: "brandigade.crm@gmail.com" });
  });
  it("Gmail needs both the user and the app password", () => {
    process.env.GMAIL_USER = "brandigade.crm@gmail.com";
    expect(senderConfig()).toBeNull();
  });
  it("generic SMTP: port, TLS and from address", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    expect(senderConfig()!.smtp).toMatchObject({ host: "smtp.example.com", port: 587, secure: false });
    expect(senderConfig()!.from.address).toBe("no-reply@smtp.example.com");
    process.env.SMTP_PORT = "465";
    expect(senderConfig()!.smtp).toMatchObject({ port: 465, secure: true });
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_PORT = "2525";
    process.env.SMTP_USER = "mailer@example.com";
    process.env.SMTP_PASS = "pw";
    expect(senderConfig()!.smtp).toMatchObject({ port: 2525, secure: false, user: "mailer@example.com", pass: "pw" });
    expect(senderConfig()!.from.address).toBe("mailer@example.com");
    process.env.NOTIFICATION_FROM_EMAIL = "crm@example.com";
    expect(senderConfig()!.from).toEqual({ name: "Brandigade CRM", address: "crm@example.com" });
  });
  it("the old DUE_TASK_FROM_EMAIL still works for Resend", () => {
    process.env.RESEND_API_KEY = "re_test_123456789012";
    process.env.DUE_TASK_FROM_EMAIL = "Team <team@brandigade.com>";
    expect(senderConfig()!.from).toEqual({ name: "Team", address: "team@brandigade.com" });
  });
  it("public info never contains secrets", () => {
    process.env.RESEND_API_KEY = "re_supersecret_value_1234";
    const info = JSON.stringify(publicSenderInfo(senderConfig()));
    expect(info).not.toContain("supersecret");
    process.env.RESEND_API_KEY = "";
    process.env.GMAIL_USER = "brandigade.crm@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    const g = JSON.stringify(publicSenderInfo(senderConfig()));
    expect(g).not.toMatch(/abcd|mnop/);
    expect(g).toContain("brandigade.crm@gmail.com");
  });
  it("parses From values", () => {
    expect(parseFrom("Brandigade CRM <crm@brandigade.com>", "X")).toEqual({ name: "Brandigade CRM", address: "crm@brandigade.com" });
    expect(parseFrom('"Ops" <ops@x.co>', "X")).toEqual({ name: "Ops", address: "ops@x.co" });
    expect(parseFrom("<ops@x.co>", "X")).toEqual({ name: "X", address: "ops@x.co" });
    expect(parseFrom("not an address", "X")).toBeNull();
  });
});

describe("Resend", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_123456789012";
    process.env.NOTIFICATION_FROM_EMAIL = "Brandigade CRM <crm@brandigade.com>";
    process.env.RESEND_API_BASE = "https://resend.test";
  });
  it("posts the email with an idempotency key and auto-reply suppression", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await sendEmail(msg, { fetchImpl });
    expect(out).toEqual({ provider: "resend", messageId: "msg_1" });
    expect(calls[0].url).toBe("https://resend.test/emails");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_test_123456789012");
    expect(h["Idempotency-Key"]).toMatch(/^task_reminder:t1:2026-10-17:10:00:at_due:[0-9a-f]{16}$/);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ from: "Brandigade CRM <crm@brandigade.com>", to: ["eddie@crm.test"], html: "<p>hi</p>", text: "hi" });
    expect(body.subject).toBe("Due now: Call Bcc: evil@x.co"); // no header injection
    expect(body.headers["Auto-Submitted"]).toBe("auto-generated");
    // Same notification + same content -> same key.
    await sendEmail(msg, { fetchImpl });
    expect((calls[1].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(h["Idempotency-Key"]);
  });
  it("retries 5xx a couple of times, then leaves it to the job queue", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ name: "application_error", message: "boom" }), { status: 500 });
    }) as unknown as typeof fetch;
    const err = await sendEmail(msg, { fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(n).toBe(3);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(err).not.toBeInstanceOf(RetryJobLater);
  });
  it("network failures are retried later", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await sendEmail(msg, { fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err.message).toMatch(/Couldn't reach Resend/);
    expect(err).not.toBeInstanceOf(PermanentJobError);
  });
  it("long rate limits reschedule the job", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
    const err = await sendEmail(msg, { fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryJobLater);
    expect(err.delayMs).toBeGreaterThanOrEqual(120_000);
  });
  it("classifies refusals", () => {
    expect(classifyResendError(422, { name: "validation_error", message: "Invalid `to` field" })).toBeInstanceOf(PermanentJobError);
    expect(classifyResendError(403, { name: "validation_error", message: "The brandigade.com domain is not verified" })).toBeInstanceOf(PermanentJobError);
    expect(classifyResendError(401, { name: "missing_api_key", message: "Missing API key" }).message).toMatch(/RESEND_API_KEY/);
    expect(classifyResendError(429, { name: "daily_quota_exceeded", message: "quota" })).toBeInstanceOf(RetryJobLater);
    expect(classifyResendError(409, { name: "concurrent_idempotent_requests", message: "in progress" })).toBeInstanceOf(RetryJobLater);
    const e5 = classifyResendError(503, null);
    expect(e5).not.toBeInstanceOf(PermanentJobError);
    expect(e5).not.toBeInstanceOf(RetryJobLater);
  });
  it("never sends to an invalid address or without a sender", async () => {
    await expect(sendEmail({ ...msg, to: "not an address" })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(sendEmail(msg, {}, null)).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe("SMTP", () => {
  beforeEach(() => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "57325";
    process.env.NOTIFICATION_FROM_EMAIL = "Brandigade CRM <crm@crm.test>";
  });
  it("sends with a Message-ID derived from the notification and bounded timeouts", async () => {
    const sent: any[] = [];
    let options: any;
    const createTransport = (o: any) => {
      options = o;
      return { sendMail: async (m: any) => (sent.push(m), { messageId: m.messageId }) };
    };
    const out = await sendEmail({ ...msg, toName: "Eddie Editor" }, { createTransport });
    expect(options).toMatchObject({ host: "127.0.0.1", port: 57325, secure: false, requireTLS: false });
    expect(options.connectionTimeout).toBeLessThanOrEqual(15_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(30_000);
    expect(sent[0]).toMatchObject({ from: { name: "Brandigade CRM", address: "crm@crm.test" }, to: { name: "Eddie Editor", address: "eddie@crm.test" } });
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
    expect(sent[0].messageId).toMatch(/^<[0-9a-f]{32}@crm\.test>$/);
    expect(out.messageId).toBe(sent[0].messageId);
    await sendEmail(msg, { createTransport });
    expect(sent[1].messageId).toBe(sent[0].messageId); // a retry looks like the same email to mail clients
  });
  it("never sends a password over an unencrypted connection to a remote server", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASS = "pw";
    let options: any;
    await sendEmail(msg, { createTransport: (o: any) => ((options = o), { sendMail: async () => ({ messageId: "x" }) }) });
    expect(options.requireTLS).toBe(true);
  });
  it("classifies failures", () => {
    const auth = classifySmtpError(Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }));
    expect(auth).toBeInstanceOf(PermanentJobError);
    expect(auth.message).toMatch(/GMAIL_APP_PASSWORD/);
    expect(classifySmtpError(Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: "EENVELOPE", responseCode: 550, response: "550 5.1.1 No such user" }))).toBeInstanceOf(PermanentJobError);
    expect(classifySmtpError(Object.assign(new Error("Invalid recipient"), { code: "EENVELOPE" }))).toBeInstanceOf(PermanentJobError);
    expect(classifySmtpError(Object.assign(new Error("Daily user sending quota exceeded"), { code: "EMESSAGE", responseCode: 550, response: "550 5.4.5 Daily user sending limit exceeded" }))).toBeInstanceOf(RetryJobLater);
    for (const e of [
      Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }),
      Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "EDNS" }),
      Object.assign(new Error("Try again later"), { code: "EENVELOPE", responseCode: 421 }),
      Object.assign(new Error("Mailbox busy"), { code: "EENVELOPE", responseCode: 450 }),
      Object.assign(new Error("Temporary auth failure"), { code: "EAUTH", responseCode: 454 }),
    ]) {
      const c = classifySmtpError(e);
      expect(c).not.toBeInstanceOf(PermanentJobError);
      expect(c).not.toBeInstanceOf(RetryJobLater);
    }
  });
  it("transport errors reach the job queue classified", async () => {
    const createTransport = () => ({
      sendMail: async () => {
        throw Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
      },
    });
    await expect(sendEmail(msg, { createTransport })).rejects.toBeInstanceOf(PermanentJobError);
  });
  it("keeps secrets out of error messages", () => {
    process.env.SMTP_PASS = "hunter2-secret";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(redactSecrets("auth hunter2-secret failed abcdefghijklmnop / abcd efgh ijkl mnop")).toBe("auth *** failed *** / ***");
    expect(redactSecrets("key re_abcdefghijklmnop rejected")).toBe("key re_*** rejected");
  });
});
