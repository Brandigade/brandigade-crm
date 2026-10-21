// The one place notification emails leave the server.
//
// Sender, first one configured wins:
//   1. Resend         RESEND_API_KEY (+ NOTIFICATION_FROM_EMAIL, a verified sender)
//   2. Gmail SMTP     GMAIL_USER + GMAIL_APP_PASSWORD (smtp.gmail.com:465), the
//                     CRM's own Gmail account, as before
//   3. Any SMTP       SMTP_HOST (+ SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE);
//                     locally this is Mailpit on 127.0.0.1:57325
// None configured -> senderConfig() is null and every notification job ends
// "skipped" (never retried), so nothing piles up while email is switched off.
//
// Errors are sorted so the job queue does the right thing:
//   PermanentJobError  the provider refused for good: bad address, login or API
//                      key rejected, unverified sender -> the job goes "dead"
//                      once (no retry storm) and shows on the Team page.
//   RetryJobLater      rate limits and sending quotas.
//   Error              anything else (network, timeouts, 4xx SMTP, 5xx HTTP)
//                      -> retried with backoff by runJobs.
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import type { SMTPTransportOptions } from "nodemailer";
import { appName, getEnv } from "../env.js";
import { PermanentJobError, RetryJobLater } from "../jobs.js";
import { RateLimitError, fetchWithRetry } from "../retry.js";

export type SenderKind = "resend" | "gmail" | "smtp";

export interface FromAddress {
  name: string;
  address: string;
}

export interface SenderConfig {
  kind: SenderKind;
  from: FromAddress;
  /** Human description for the owner's status panel (no secrets). */
  label: string;
  resend?: { apiKey: string; baseUrl: string };
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
}

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Stable id of this notification (the job's dedupe key): used for Resend's
   *  Idempotency-Key and the SMTP Message-ID, so a retried send after a crash
   *  is recognised as the same email where the provider/mail client can. */
  idempotencyKey?: string;
}

export interface SendResult {
  provider: SenderKind;
  messageId: string | null;
}

export interface SendDeps {
  fetchImpl?: typeof fetch;
  /** Overridable for tests: builds the SMTP transport. */
  createTransport?: (options: SMTPTransportOptions) => { sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }> };
  sleep?: (ms: number) => Promise<void>;
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+$/;

/** "Brandigade CRM <crm@brandigade.com>" or "crm@brandigade.com" -> parts. */
export function parseFrom(value: string | undefined, fallbackName: string): FromAddress | null {
  if (!value) return null;
  const v = value.trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(v);
  if (m && ADDRESS_RE.test(m[2])) return { name: m[1].trim() || fallbackName, address: m[2] };
  if (ADDRESS_RE.test(v)) return { name: fallbackName, address: v };
  return null;
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v);
const isLocalHost = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(host);

/** The configured sender, or null when email isn't set up. Never throws. */
export function senderConfig(): SenderConfig | null {
  const name = appName();
  const fromEnv = parseFrom(getEnv("NOTIFICATION_FROM_EMAIL") || getEnv("DUE_TASK_FROM_EMAIL"), name);

  const resendKey = getEnv("RESEND_API_KEY");
  if (resendKey) {
    const from = fromEnv || { name, address: "crm@brandigade.com" };
    return {
      kind: "resend",
      from,
      label: "Resend",
      resend: { apiKey: resendKey, baseUrl: (getEnv("RESEND_API_BASE") || "https://api.resend.com").replace(/\/+$/, "") },
    };
  }

  const gmailUser = getEnv("GMAIL_USER");
  const gmailPass = (getEnv("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  if (gmailUser && gmailPass) {
    // Gmail rewrites any other From address, so send as the account itself.
    const from = { name: fromEnv?.name || name, address: gmailUser };
    return {
      kind: "gmail",
      from,
      label: `Gmail account ${gmailUser}`,
      smtp: { host: getEnv("GMAIL_SMTP_HOST") || "smtp.gmail.com", port: Number(getEnv("GMAIL_SMTP_PORT") || 465), secure: true, user: gmailUser, pass: gmailPass },
    };
  }

  const host = getEnv("SMTP_HOST");
  if (host) {
    const secureEnv = getEnv("SMTP_SECURE");
    const portEnv = Number(getEnv("SMTP_PORT"));
    const secure = secureEnv ? truthy(secureEnv) : portEnv === 465;
    const port = Number.isInteger(portEnv) && portEnv > 0 ? portEnv : secure ? 465 : 587;
    const user = getEnv("SMTP_USER");
    const from = fromEnv || (user && ADDRESS_RE.test(user) ? { name, address: user } : { name, address: `no-reply@${isLocalHost(host) ? "localhost" : host}` });
    return {
      kind: "smtp",
      from,
      label: `SMTP server ${host}:${port}${secure ? " (TLS)" : ""}`,
      smtp: { host, port, secure, user, pass: getEnv("SMTP_PASS") },
    };
  }
  return null;
}

/** What the owner's status panel may see about the sender (never secrets). */
export function publicSenderInfo(cfg: SenderConfig | null) {
  if (!cfg) return { configured: false as const, kind: null, label: null, from: null };
  return { configured: true as const, kind: cfg.kind, label: cfg.label, from: `${cfg.from.name} <${cfg.from.address}>` };
}

/** Removes configured secret values from text that may reach logs or the UI. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of ["RESEND_API_KEY", "GMAIL_APP_PASSWORD", "SMTP_PASS"]) {
    const v = getEnv(name);
    if (v && v.length >= 4) out = out.split(v).join("***");
    const compact = v?.replace(/\s+/g, "");
    if (compact && compact.length >= 4) out = out.split(compact).join("***");
  }
  return out.replace(/re_[A-Za-z0-9_]{10,}/g, "re_***").slice(0, 500);
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function messageIdFor(key: string, fromAddress: string): string {
  const domain = fromAddress.split("@")[1] || "localhost";
  return `<${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}@${domain}>`;
}

const AUTO_HEADERS = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------
async function sendViaResend(cfg: SenderConfig, msg: OutgoingEmail, deps: SendDeps): Promise<SendResult> {
  const { apiKey, baseUrl } = cfg.resend!;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (msg.idempotencyKey) {
    // Same notification + same content = same key, so Resend sends it once even
    // if we retry after a crash. (The content hash keeps a changed retry from
    // being refused as "same key, different payload".)
    const digest = crypto.createHash("sha256").update(msg.subject + "\n" + msg.text).digest("hex").slice(0, 16);
    headers["Idempotency-Key"] = `${msg.idempotencyKey}:${digest}`.slice(0, 256);
  }
  const body = {
    from: `${cfg.from.name.replace(/[<>"]/g, "")} <${cfg.from.address}>`,
    to: [msg.to],
    subject: oneLine(msg.subject),
    html: msg.html,
    text: msg.text,
    headers: AUTO_HEADERS,
  };
  let res: Response;
  try {
    res = await fetchWithRetry(`${baseUrl}/emails`, { method: "POST", headers, body: JSON.stringify(body) }, {
      retries: 2,
      timeoutMs: 15_000,
      maxDelayMs: 5_000,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
  } catch (err) {
    if (err instanceof RateLimitError) throw new RetryJobLater(Math.max(err.retryAfterMs, 30_000), "Resend rate limit");
    throw new Error(`Couldn't reach Resend: ${redactSecrets(err instanceof Error ? err.message : String(err))}`, { cause: err });
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return { provider: "resend", messageId: (data && typeof data.id === "string" && data.id) || null };
  throw classifyResendError(res.status, data);
}

export function classifyResendError(status: number, data: any): Error {
  const name = data && typeof data.name === "string" ? data.name : "";
  const detail = redactSecrets(oneLine(String((data && (data.message || data.error)) || `HTTP ${status}`)));
  if (status === 429) {
    return name === "daily_quota_exceeded"
      ? new RetryJobLater(60 * 60_000, `Resend daily quota reached: ${detail}`)
      : new RetryJobLater(60_000, `Resend rate limit: ${detail}`);
  }
  if (status === 409 && /concurrent/i.test(name + detail)) return new RetryJobLater(15_000, `Resend is still processing this email: ${detail}`);
  if (status === 401 || status === 403) return new PermanentJobError(`Resend refused the request (check RESEND_API_KEY and the sending domain): ${detail}`);
  if (status >= 400 && status < 500) return new PermanentJobError(`Resend rejected the email: ${detail}`);
  return new Error(`Resend failed (HTTP ${status}): ${detail}`);
}

// ---------------------------------------------------------------------------
// SMTP (Gmail or any server)
// ---------------------------------------------------------------------------
type Transport = ReturnType<NonNullable<SendDeps["createTransport"]>>;
const transports = new Map<string, Transport>();

function smtpOptions(cfg: SenderConfig): SMTPTransportOptions {
  const s = cfg.smtp!;
  const auth = s.user && s.pass ? { user: s.user, pass: s.pass } : undefined;
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth,
    // Never send a password over an unencrypted connection (Mailpit on localhost is fine).
    requireTLS: !s.secure && !!auth && !isLocalHost(s.host),
    // Keep a send well inside the job lease (120 s).
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
  };
}

function transportFor(cfg: SenderConfig, deps: SendDeps): Transport {
  const options = smtpOptions(cfg);
  if (deps.createTransport) return deps.createTransport(options);
  const key = JSON.stringify([options.host, options.port, options.secure, cfg.smtp!.user, cfg.smtp!.pass]);
  let t = transports.get(key);
  if (!t) {
    t = nodemailer.createTransport(options) as unknown as Transport;
    transports.set(key, t);
  }
  return t;
}

async function sendViaSmtp(cfg: SenderConfig, msg: OutgoingEmail, deps: SendDeps): Promise<SendResult> {
  const transport = transportFor(cfg, deps);
  const mail: Record<string, unknown> = {
    from: { name: cfg.from.name, address: cfg.from.address },
    to: msg.toName ? { name: oneLine(msg.toName), address: msg.to } : msg.to,
    subject: oneLine(msg.subject),
    html: msg.html,
    text: msg.text,
    headers: AUTO_HEADERS,
  };
  if (msg.idempotencyKey) mail.messageId = messageIdFor(msg.idempotencyKey, cfg.from.address);
  try {
    const info = await transport.sendMail(mail);
    return { provider: cfg.kind, messageId: (info && info.messageId) || null };
  } catch (err) {
    throw classifySmtpError(err);
  }
}

/** Sorts an SMTP failure into permanent / later / retry. */
export function classifySmtpError(err: unknown): Error {
  const e = (err || {}) as { code?: string; responseCode?: number; message?: string; response?: string };
  const code = e.code || "";
  const rc = typeof e.responseCode === "number" ? e.responseCode : 0;
  const detail = redactSecrets(oneLine(String(e.response || e.message || err)));
  if (rc === 454 || rc === 421) return new Error(`The mail server is busy, will retry: ${detail}`);
  if (code === "EAUTH" || code === "ENOAUTH" || rc === 530 || rc === 534 || rc === 535) {
    return new PermanentJobError(`The mail server rejected the login (check GMAIL_USER / GMAIL_APP_PASSWORD or SMTP_USER / SMTP_PASS): ${detail}`);
  }
  if (/\b[45]\.4\.5\b|quota|sending limit|rate limit/i.test(detail) && rc >= 400) {
    return new RetryJobLater(30 * 60_000, `The mail server's sending limit was reached: ${detail}`);
  }
  if (rc >= 500) return new PermanentJobError(`The mail server refused the email: ${detail}`);
  if (code === "EENVELOPE" && !rc) return new PermanentJobError(`The email address isn't valid: ${detail}`);
  if (code === "ECONFIG" || code === "EREQUIRETLS") return new PermanentJobError(`The mail server settings don't work: ${detail}`);
  return new Error(`Sending failed, will retry: ${detail}`);
}

/** Sends one email through the configured sender. Throws the classified errors above. */
export async function sendEmail(msg: OutgoingEmail, deps: SendDeps = {}, cfg: SenderConfig | null = senderConfig()): Promise<SendResult> {
  if (!cfg) throw new PermanentJobError("No email sender is set up on the server");
  if (!ADDRESS_RE.test(msg.to)) throw new PermanentJobError("The recipient has no valid email address");
  return cfg.kind === "resend" ? sendViaResend(cfg, msg, deps) : sendViaSmtp(cfg, msg, deps);
}

/** For tests: forget cached SMTP transports. */
export function __resetTransportsForTests() {
  transports.clear();
}
