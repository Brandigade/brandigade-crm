import { domainToASCII } from "node:url";

// Email addresses: parsing provider headers into [{ email, name }] and
// validating what people type into the composer.

export interface Addr {
  email: string;
  name: string | null;
}

const MAX_ADDRESS = 254;
// A pragmatic subset of RFC 5321: dot-atom local part, LDH domain labels.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalises and validates one address someone typed. Returns the lowercased
 * ASCII address (internationalised domains converted to punycode), or null.
 */
export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > MAX_ADDRESS || /[\s\r\n\0"<>(),;:\\[\]]/.test(s)) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  const domain = domainToASCII(s.slice(at + 1).toLowerCase());
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || /^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return `${local.toLowerCase()}@${domain}`;
}

export const isValidAddress = (s: unknown) => normalizeAddress(s) !== null;

/** True when the text has a C0 control character (tab allowed), DEL, NEL or a Unicode line/paragraph separator. */
export function hasControlChars(s: string, allowTab = true): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && !(allowTab && c === 9)) || c === 127 || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** A display name is safe for a header when it has no control characters. */
export function safeDisplayName(name: unknown, max = 200): string | null {
  if (typeof name !== "string" || hasControlChars(name)) return null;
  const n = name.replace(/\s+/g, " ").trim();
  return n ? n.slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words (=?UTF-8?B?...?= / =?ISO-8859-1?Q?...?=)
// ---------------------------------------------------------------------------
function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

export function decodeMimeWords(input: string): string {
  if (!input || !input.includes("=?")) return input;
  // Whitespace between two adjacent encoded words is dropped (RFC 2047 §6.2).
  const joined = input.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const cs = charset.split("*")[0]; // RFC 2231 language suffix
      if (enc.toUpperCase() === "B") return decodeBytes(Buffer.from(text, "base64"), cs);
      const bytes: number[] = [];
      const q = text.replace(/_/g, " ");
      for (let i = 0; i < q.length; i++) {
        if (q[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(q.charCodeAt(i) & 0xff);
      }
      return decodeBytes(Buffer.from(bytes), cs);
    } catch {
      return whole;
    }
  });
}

// ---------------------------------------------------------------------------
// Address lists: `"Doe, Jane" <jane@x.com>, bob@y.com, Team: a@z.com, b@z.com;`
// ---------------------------------------------------------------------------
function cleanName(raw: string): string | null {
  let n = raw.trim();
  if (n.startsWith('"') && n.endsWith('"') && n.length >= 2) n = n.slice(1, -1).replace(/\\(.)/g, "$1");
  n = decodeMimeWords(n).replace(/\s+/g, " ").trim();
  return n || null;
}

function looseAddress(s: string): string | null {
  const v = s.trim().replace(/^mailto:/i, "").toLowerCase();
  if (!v || v.length > 320 || !/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(v)) return null;
  return v;
}

/** Parses an address header. Addresses are lowercased; invalid entries are dropped. */
export function parseAddressList(header: string | null | undefined): Addr[] {
  if (!header) return [];
  const out: Addr[] = [];
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuote) {
      cur += ch;
      if (ch === "\\" && i + 1 < header.length) cur += header[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (comment) {
      if (ch === "(") comment++;
      else if (ch === ")") comment--;
      continue;
    }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === "(") { comment = 1; continue; }
    if (ch === "<") angle++;
    if (ch === ">") angle = Math.max(0, angle - 1);
    if (!angle && (ch === "," || ch === ";")) { parts.push(cur); cur = ""; continue; }
    if (!angle && ch === ":") { cur = ""; continue; } // group name
    cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const part = p.trim();
    if (!part) continue;
    const m = /^(.*)<([^<>]*)>\s*$/.exec(part);
    const email = looseAddress(m ? m[2] : part);
    if (!email) continue;
    const name = m ? cleanName(m[1]) : null;
    if (!out.some((a) => a.email === email)) out.push({ email, name: name && name.toLowerCase() !== email ? name.slice(0, 200) : null });
  }
  return out;
}

/** "<id@host>" form; anything that isn't a single sane message id becomes null. */
export function normalizeMessageId(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  const m = /<[^<>\s]{1,900}>/.exec(t);
  if (m) return m[0];
  if (/^[^<>\s]{1,900}$/.test(t) && t.includes("@")) return `<${t}>`;
  return null;
}

/** Every message id in a References / In-Reply-To header, in order. */
export function messageIdList(v: string | null | undefined): string[] {
  if (!v) return [];
  return (v.match(/<[^<>\s]{1,900}>/g) || []).slice(-50);
}
