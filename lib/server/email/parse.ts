import { decodeMimeWords, normalizeMessageId, parseAddressList, type Addr } from "./addresses.js";
import { decodeEntities } from "./sanitize.js";

// Provider messages (Gmail API, Microsoft Graph) -> one common shape.

export interface ParsedMessage {
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  direction: "inbound" | "outbound";
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  snippet: string;
  sentAt: string;
  hasAttachments: boolean;
  /** Spam, trash, drafts and chats are never stored. */
  skip: boolean;
  /** Filled in only for messages that involve a lead (second fetch). */
  bodyText?: string | null;
  /** Raw provider HTML; sanitized before it is stored. */
  bodyHtml?: string | null;
}

/** Every address on a message except the mailbox's own. */
export function participants(m: Pick<ParsedMessage, "from" | "to" | "cc" | "bcc">, ownAddresses: string[]): string[] {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const all = [m.from, ...m.to, ...m.cc, ...m.bcc].filter((a): a is Addr => !!a).map((a) => a.email.toLowerCase());
  return [...new Set(all)].filter((e) => !own.has(e));
}

function safeIso(v: unknown, fallback: string): string {
  const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : fallback;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export const GMAIL_SKIP_LABELS = ["SPAM", "TRASH", "DRAFT", "CHAT"];

function header(headers: { name: string; value: string }[] | undefined, name: string): string | null {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

export function parseGmailMessage(m: GmailMessage, ownAddress: string): ParsedMessage {
  const headers = m.payload?.headers || [];
  const labels = m.labelIds || [];
  const from = parseAddressList(header(headers, "From"))[0] || null;
  const own = ownAddress.toLowerCase();
  const outbound = labels.includes("SENT") || (!!from && from.email === own && !labels.includes("INBOX"));
  const fallbackDate = safeIso(header(headers, "Date"), new Date().toISOString());
  return {
    providerMessageId: m.id,
    threadId: m.threadId || null,
    internetMessageId: normalizeMessageId(header(headers, "Message-ID")),
    inReplyTo: normalizeMessageId(header(headers, "In-Reply-To")),
    references: (header(headers, "References") || "").trim().slice(0, 8000) || null,
    direction: outbound ? "outbound" : "inbound",
    from,
    to: parseAddressList(header(headers, "To")),
    cc: parseAddressList(header(headers, "Cc")),
    bcc: parseAddressList(header(headers, "Bcc")),
    subject: decodeMimeWords(header(headers, "Subject") || "").replace(/[\r\n]+/g, " ").trim(),
    snippet: decodeEntities(m.snippet || "").replace(/\s+/g, " ").trim(),
    sentAt: m.internalDate ? safeIso(Number(m.internalDate), fallbackDate) : fallbackDate,
    hasAttachments: hasGmailAttachments(m.payload),
    skip: labels.some((l) => GMAIL_SKIP_LABELS.includes(l)),
  };
}

function hasGmailAttachments(p: GmailPart | undefined): boolean {
  if (!p) return false;
  const disposition = (header(p.headers, "Content-Disposition") || "").toLowerCase();
  if (p.filename && !disposition.startsWith("inline")) return true;
  return (p.parts || []).some(hasGmailAttachments);
}

function charsetOf(p: GmailPart): string {
  const ct = header(p.headers, "Content-Type") || "";
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m ? m[1] : "utf-8";
}

export function decodePartData(data: string, charset = "utf-8"): string {
  const bytes = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** The first text/plain and text/html bodies that aren't attachments. */
export function gmailBodies(payload: GmailPart | undefined): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  const walk = (p: GmailPart | undefined) => {
    if (!p || (text !== null && html !== null)) return;
    const disposition = (header(p.headers, "Content-Disposition") || "").toLowerCase();
    const isAttachment = !!p.filename || disposition.startsWith("attachment");
    const type = (p.mimeType || "").toLowerCase();
    if (!isAttachment && p.body?.data) {
      if (type === "text/plain" && text === null) text = decodePartData(p.body.data, charsetOf(p));
      else if (type === "text/html" && html === null) html = decodePartData(p.body.data, charsetOf(p));
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { text, html };
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------
interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  "@removed"?: unknown;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
  isDraft?: boolean;
  parentFolderId?: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name: string; value: string }[];
}

function graphAddr(r: GraphRecipient | undefined): Addr | null {
  const e = r?.emailAddress;
  if (!e?.address) return null;
  const parsed = parseAddressList(`<${e.address}>`)[0];
  if (!parsed) return null;
  const name = (e.name || "").replace(/\s+/g, " ").trim();
  return { email: parsed.email, name: name && name.toLowerCase() !== parsed.email ? name.slice(0, 200) : null };
}

function graphList(list: GraphRecipient[] | undefined): Addr[] {
  const out: Addr[] = [];
  for (const r of list || []) {
    const a = graphAddr(r);
    if (a && !out.some((x) => x.email === a.email)) out.push(a);
  }
  return out;
}

/**
 * @param folder "sentitems" / "inbox" when the message came from that folder's delta,
 *               otherwise the direction is worked out from the sender.
 */
export function parseGraphMessage(m: GraphMessage, ownAddress: string, folder?: "inbox" | "sentitems", skipFolderIds: string[] = []): ParsedMessage {
  const from = graphAddr(m.from) || graphAddr(m.sender);
  const own = ownAddress.toLowerCase();
  const outbound = folder ? folder === "sentitems" : !!from && from.email === own;
  const headers = m.internetMessageHeaders || [];
  const now = new Date().toISOString();
  return {
    providerMessageId: m.id,
    threadId: m.conversationId || null,
    internetMessageId: normalizeMessageId(m.internetMessageId),
    inReplyTo: normalizeMessageId(header(headers, "In-Reply-To")),
    references: (header(headers, "References") || "").trim().slice(0, 8000) || null,
    direction: outbound ? "outbound" : "inbound",
    from,
    to: graphList(m.toRecipients),
    cc: graphList(m.ccRecipients),
    bcc: graphList(m.bccRecipients),
    subject: (m.subject || "").replace(/[\r\n]+/g, " ").trim(),
    snippet: (m.bodyPreview || "").replace(/\s+/g, " ").trim(),
    sentAt: safeIso(m.sentDateTime || m.receivedDateTime, now),
    hasAttachments: !!m.hasAttachments,
    skip: !!m["@removed"] || !!m.isDraft || (!!m.parentFolderId && skipFolderIds.includes(m.parentFolderId)),
  };
}

export function graphBodies(m: GraphMessage): { text: string | null; html: string | null } {
  const content = m.body?.content ?? null;
  if (content == null) return { text: null, html: null };
  return (m.body?.contentType || "").toLowerCase() === "html" ? { text: null, html: content } : { text: content, html: null };
}
