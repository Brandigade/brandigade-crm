import { randomBytes } from "node:crypto";
import { hasControlChars, messageIdList, normalizeMessageId, type Addr } from "./addresses.js";
import { textToHtml } from "./sanitize.js";

// Builds the RFC 5322 / MIME message the CRM sends through Gmail:
// UTF-8 everywhere, RFC 2047 encoded words for non-ASCII headers, a
// text/plain part plus a simple escaped HTML alternative, and the threading
// headers (In-Reply-To / References) for replies. Header values with CR or LF
// are refused outright, so nothing a user types can add a header.

export class HeaderInjectionError extends Error {
  constructor(field: string) {
    super(`The ${field} can't contain line breaks.`);
    this.name = "HeaderInjectionError";
  }
}

/** Refuses CR, LF and every other control character in a header value. */
export function assertNoLineBreaks(field: string, value: string | null | undefined) {
  if (value != null && hasControlChars(value)) throw new HeaderInjectionError(field);
}

const CRLF = "\r\n";
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" encoded words, each at most 75 characters, never splitting a character. */
export function encodeWords(text: string): string[] {
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 45 && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words;
}

/** An unstructured header value (Subject): plain if short ASCII, else encoded words. */
export function encodeHeaderText(value: string): string {
  if (isAscii(value) && !/=\?/.test(value) && value.length <= 900) return value;
  return encodeWords(value).join(CRLF + " ");
}

function encodeDisplayName(name: string): string {
  if (isAscii(name) && !/=\?/.test(name) && name.length <= 200) return `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return encodeWords(name).join(CRLF + " ");
}

export function formatAddress(a: Addr): string {
  assertNoLineBreaks("address", a.email);
  assertNoLineBreaks("name", a.name);
  if (!/^[^\s<>"(),;:\\[\]@]+@[A-Za-z0-9.-]+$/.test(a.email)) throw new Error("Invalid address for a header");
  return a.name ? `${encodeDisplayName(a.name)} <${a.email}>` : a.email;
}

/** "Name: v1, v2" folded between items so lines stay around 78 characters. */
function foldList(name: string, items: string[], comma: boolean): string {
  const head = `${name}:`;
  const lines: string[] = [];
  let line = head;
  items.forEach((item, i) => {
    const token = item + (comma && i < items.length - 1 ? "," : "");
    const first = token.split(CRLF)[0];
    if (line !== head && line.length + 1 + first.length > 78) {
      lines.push(line);
      line = " " + token;
    } else line += " " + token;
    if (line.includes(CRLF)) {
      const segs = line.split(CRLF);
      lines.push(...segs.slice(0, -1));
      line = segs[segs.length - 1];
    }
  });
  lines.push(line);
  return lines.join(CRLF);
}

function wrapBase64(s: string): string {
  return (s.match(/.{1,76}/g) || [""]).join(CRLF);
}

export function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}:${p(d.getUTCSeconds())} +0000`;
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] || "brandigade-crm.local";
  return `<${Date.now().toString(36)}.${randomBytes(12).toString("hex")}@${domain}>`;
}

export interface MimeInput {
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  subject: string;
  text: string;
  /** Message-ID of the email being replied to. */
  inReplyTo?: string | null;
  /** The replied-to email's References header (its own id is appended). */
  references?: string | null;
  messageId?: string;
  date?: Date;
}

export interface BuiltMime {
  raw: string;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
}

export function buildMime(input: MimeInput): BuiltMime {
  assertNoLineBreaks("subject", input.subject);
  if (!input.to.length) throw new Error("At least one recipient is required");
  const messageId = input.messageId || newMessageId(input.from.email);
  const inReplyTo = normalizeMessageId(input.inReplyTo);
  const refs = inReplyTo ? [...messageIdList(input.references).filter((r) => r !== inReplyTo), inReplyTo].slice(-20) : [];
  const boundary = `=_crm_${randomBytes(12).toString("hex")}`;

  const headers: string[] = [foldList("From", [formatAddress(input.from)], true), foldList("To", input.to.map(formatAddress), true)];
  if (input.cc && input.cc.length) headers.push(foldList("Cc", input.cc.map(formatAddress), true));
  headers.push(`Subject: ${encodeHeaderText(input.subject)}`);
  headers.push(`Date: ${rfc5322Date(input.date || new Date())}`);
  headers.push(`Message-ID: ${messageId}`);
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(foldList("References", refs, false));
  }
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const text = input.text.replace(/\r\n|\r|\n/g, CRLF);
  const html = `<!DOCTYPE html>${CRLF}<html><head><meta charset="utf-8"></head><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">${textToHtml(
    input.text,
  )}</div></body></html>`;

  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(text, "utf8").toString("base64")),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(html, "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ];
  const raw = headers.join(CRLF) + CRLF + CRLF + body.join(CRLF);
  return { raw, messageId, inReplyTo, references: refs.length ? refs.join(" ") : null };
}

/** Gmail's messages.send wants the whole message as base64url. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}
