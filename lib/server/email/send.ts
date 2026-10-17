import { EDITORS, requireAuth, type AuthContext } from "../auth.js";
import { badRequest, HttpError, json, notConfigured, notFound, readJson } from "../http.js";
import { ProviderError, RateLimitError } from "../retry.js";
import { normalizeAddress, normalizeMessageId, safeDisplayName, type Addr } from "./addresses.js";
import { LIMITS, providerConfigured, providerLabel } from "./config.js";
import { GmailClient } from "./gmail.js";
import { GraphClient } from "./graph.js";
import { ingestBatch, newStats } from "./ingest.js";
import { assertNoLineBreaks, buildMime, HeaderInjectionError, toBase64Url } from "./mime.js";
import { parseGmailMessage, type ParsedMessage } from "./parse.js";
import { ReconnectRequiredError } from "./provider-http.js";
import { repo, type AccountRow, type SendRow } from "./repo.js";
import { makeSnippet, textToHtml } from "./sanitize.js";
import { MailboxAuth } from "./tokens.js";

// POST /api/email/send — compose or reply from the person's own mailbox.
//
// Idempotent: the browser sends one clientRequestId per draft, and
// email_sends is unique on (user, clientRequestId). A repeated request gets
// the first result back and never sends again. A send is only marked
// "failed" (and may then be retried with the same id) when the provider
// certainly did not accept it; when the outcome is unknown (timeout, 5xx
// after the request went out) it stays "pending" and is never resent.
// The sent email is stored right away so it shows on the lead's timeline.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNCONFIRMED_AFTER_MS = 2 * 60 * 1000;

export interface SendInput {
  clientRequestId: string;
  accountId: string | null;
  to: Addr[];
  cc: Addr[];
  subject: string;
  bodyText: string;
  contactId: string | null;
  replyToMessageId: string | null;
}

function optionalUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !UUID.test(v)) throw badRequest(`${field} is not valid.`, "invalid_request");
  return v.toLowerCase();
}

function recipients(v: unknown, field: "To" | "Cc"): Addr[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? v.split(/[,;]/) : Array.isArray(v) ? v : null;
  if (!list) throw badRequest(`${field} must be a list of addresses.`, "invalid_recipient");
  const out: Addr[] = [];
  for (const item of list) {
    const raw = typeof item === "string" ? item : item && typeof item === "object" ? (item as any).email : null;
    if (typeof raw === "string" && !raw.trim()) continue;
    if (typeof raw === "string") assertNoLineBreaks(field, raw);
    const email = normalizeAddress(raw);
    if (!email) throw badRequest(`"${String(raw ?? "").slice(0, 80)}" isn't a valid email address.`, "invalid_recipient");
    const rawName = item && typeof item === "object" ? (item as any).name : null;
    if (typeof rawName === "string") assertNoLineBreaks(field, rawName);
    if (!out.some((a) => a.email === email)) out.push({ email, name: safeDisplayName(rawName) });
  }
  return out;
}

export function validateSendInput(body: Record<string, unknown>): SendInput {
  try {
    if (typeof body.clientRequestId !== "string" || !UUID.test(body.clientRequestId)) {
      throw badRequest("clientRequestId must be a UUID.", "invalid_request");
    }
    const to = recipients(body.to, "To");
    const cc = recipients(body.cc, "Cc").filter((a) => !to.some((t) => t.email === a.email));
    if (!to.length) throw badRequest("Add at least one recipient.", "invalid_recipient");
    if (to.length + cc.length > LIMITS.maxRecipients) throw badRequest(`At most ${LIMITS.maxRecipients} recipients per email.`, "too_many_recipients");
    if (body.subject !== undefined && typeof body.subject !== "string") throw badRequest("Subject must be text.", "invalid_subject");
    const subject = (body.subject as string | undefined) ?? "";
    assertNoLineBreaks("subject", subject);
    if (subject.length > LIMITS.subjectMax) throw badRequest("The subject is too long.", "invalid_subject");
    if (body.bodyText !== undefined && typeof body.bodyText !== "string") throw badRequest("The message must be text.", "invalid_body");
    const bodyText = ((body.bodyText as string | undefined) ?? "").split("\u0000").join("");
    if (bodyText.length > LIMITS.sendBodyMax) throw badRequest("The message is too long.", "invalid_body");
    if (!subject.trim() && !bodyText.trim()) throw badRequest("Write a subject or a message.", "empty_email");
    return {
      clientRequestId: body.clientRequestId.toLowerCase(),
      accountId: optionalUuid(body.accountId, "accountId"),
      to,
      cc,
      subject: subject.trim(),
      bodyText,
      contactId: optionalUuid(body.contactId, "contactId"),
      replyToMessageId: optionalUuid(body.replyToMessageId, "replyToMessageId"),
    };
  } catch (err) {
    if (err instanceof HeaderInjectionError) throw badRequest(err.message, "invalid_header");
    throw err;
  }
}

function replay(row: SendRow): Response {
  if (row.status === "sent") {
    return json({ status: "sent", sendId: row.id, emailMessageId: row.email_message_id, providerMessageId: row.provider_message_id, sentAt: row.sent_at, replayed: true });
  }
  if (row.status === "pending") {
    const unconfirmed = (row.error || "").startsWith("unconfirmed") || Date.now() - Date.parse(row.created_at) > UNCONFIRMED_AFTER_MS;
    if (unconfirmed) {
      throw new HttpError(409, "We couldn't confirm whether this email was sent. Check your Sent folder before sending it again.", "send_unconfirmed");
    }
    throw new HttpError(409, "This email is already being sent.", "send_in_progress");
  }
  throw new HttpError(409, row.error || "This email wasn't sent.", "send_failed");
}

async function pickAccount(auth: AuthContext, accountId: string | null): Promise<AccountRow> {
  const r = repo();
  let account: AccountRow | null;
  if (accountId) {
    account = await r.getAccount(accountId);
    if (!account || account.user_id !== auth.userId || account.workspace_id !== auth.workspaceId) throw notFound("That mailbox isn't yours or no longer exists.");
  } else {
    const mine = await r.listAccounts({ workspaceId: auth.workspaceId, userId: auth.userId, statuses: ["active"] });
    account = mine[0] || null;
    if (!account) throw new HttpError(409, "Connect your mailbox on the Profile page first.", "no_mailbox");
  }
  if (account.status === "reconnect_required") throw new HttpError(409, "Reconnect this mailbox on your Profile page before sending.", "reconnect_required");
  if (account.status !== "active") throw new HttpError(409, "That mailbox is disconnected. Connect it again on your Profile page.", "mailbox_unavailable");
  if (!providerConfigured(account.provider)) throw notConfigured(providerLabel(account.provider));
  return account;
}

interface ReplyContext {
  messageId: string;
  internetMessageId: string | null;
  references: string | null;
  ownProviderId: string | null;
  ownThreadId: string | null;
}

async function replyContext(auth: AuthContext, account: AccountRow, messageId: string): Promise<ReplyContext> {
  const r = repo();
  const msg = await r.getMessage(messageId);
  // The same rule as row level security: team emails, or your own private ones.
  if (!msg || msg.workspace_id !== auth.workspaceId || (msg.visibility !== "team" && msg.owner_user_id !== auth.userId)) {
    throw notFound("The email you're replying to isn't available.");
  }
  const own = msg.account_id === account.id ? msg : msg.internet_message_id ? await r.findAccountMessage(account.id, msg.internet_message_id) : null;
  return {
    messageId: msg.id,
    internetMessageId: normalizeMessageId(msg.internet_message_id),
    references: msg.references_header,
    ownProviderId: own?.provider_message_id ?? null,
    ownThreadId: own?.provider_thread_id ?? null,
  };
}

interface SentResult {
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  sentAt: string;
}

/** `dispatched` flips to true right before the request that actually sends. */
interface Dispatch {
  dispatched: boolean;
}

async function sendViaGmail(account: AccountRow, input: SendInput, from: Addr, reply: ReplyContext | null, d: Dispatch): Promise<SentResult> {
  const built = buildMime({ from, to: input.to, cc: input.cc, subject: input.subject, text: input.bodyText, inReplyTo: reply?.internetMessageId, references: reply?.references });
  const mailbox = new MailboxAuth(account);
  await mailbox.accessToken(); // refresh before dispatch, so an auth failure is clearly "not sent"
  const gmail = new GmailClient(mailbox);
  d.dispatched = true;
  const sent = await gmail.send(toBase64Url(built.raw), reply?.ownThreadId);
  const sentAt = new Date().toISOString();
  // Gmail may replace the Message-ID; read back the one it used (best effort).
  let internetMessageId = built.messageId;
  try {
    const m = await gmail.getMessage(sent.id, "metadata");
    const p = m && parseGmailMessage(m, account.email_address);
    if (p && p.internetMessageId) internetMessageId = p.internetMessageId;
  } catch {
    /* keep ours */
  }
  return { providerMessageId: sent.id, threadId: sent.threadId || reply?.ownThreadId || null, internetMessageId, inReplyTo: built.inReplyTo, references: built.references, sentAt };
}

const graphRecipients = (list: Addr[]) => list.map((a) => ({ emailAddress: a.name ? { address: a.email, name: a.name } : { address: a.email } }));

async function sendViaGraph(account: AccountRow, input: SendInput, reply: ReplyContext | null, d: Dispatch): Promise<SentResult> {
  const graph = new GraphClient(new MailboxAuth(account));
  const toRecipients = graphRecipients(input.to);
  const ccRecipients = graphRecipients(input.cc);
  let draftId: string | null = null;
  try {
    let draft;
    if (reply?.ownProviderId) {
      // Reply on the person's own copy so Outlook threads it properly.
      draft = await graph.createReply(reply.ownProviderId, { toRecipients, ccRecipients });
      draftId = draft.id;
      const quoted = draft.body?.content || "";
      const ours = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">${textToHtml(input.bodyText)}</div><br>`;
      const content = /<body[^>]*>/i.test(quoted) ? quoted.replace(/<body[^>]*>/i, (m) => m + ours) : ours + quoted;
      draft = await graph.updateDraft(draft.id, { subject: input.subject, toRecipients, ccRecipients, body: { contentType: "HTML", content } });
    } else {
      draft = await graph.createDraft({ subject: input.subject, body: { contentType: "Text", content: input.bodyText }, toRecipients, ccRecipients });
      draftId = draft.id;
    }
    d.dispatched = true;
    await graph.sendDraft(draft.id);
    const sentAt = new Date().toISOString();
    let internetMessageId = normalizeMessageId(draft.internetMessageId);
    let threadId = draft.conversationId || null;
    try {
      const m = await graph.getMessage(draft.id);
      if (m?.internetMessageId) internetMessageId = normalizeMessageId(m.internetMessageId);
      if (m?.conversationId) threadId = m.conversationId;
    } catch {
      /* the sync fills it in later */
    }
    return { providerMessageId: draft.id, threadId, internetMessageId, inReplyTo: reply?.internetMessageId || null, references: null, sentAt };
  } catch (err) {
    // Certainly not sent: don't leave a stray draft behind.
    if (draftId && (!d.dispatched || (err instanceof ProviderError && err.status >= 400 && err.status < 500))) {
      await graph.deleteDraft(draftId).catch(() => {});
    }
    throw err;
  }
}

function classify(err: unknown, account: AccountRow, d: Dispatch): { notSent: boolean; status: number; code: string; message: string } {
  const label = providerLabel(account.provider);
  if (err instanceof ReconnectRequiredError) {
    return { notSent: true, status: 409, code: "reconnect_required", message: "Your mailbox needs to be reconnected on the Profile page before you can send." };
  }
  if (err instanceof RateLimitError) {
    return { notSent: true, status: 429, code: "provider_rate_limited", message: `${label} is limiting how fast you can send. Try again in a few minutes.` };
  }
  if (err instanceof ProviderError && err.status >= 400 && err.status < 500 && err.status !== 408) {
    return { notSent: true, status: 422, code: "provider_rejected", message: `${label} didn't accept the email. ${err.message.replace(/^[^:]*:\s*/, "")}`.slice(0, 400) };
  }
  if ((err as any)?.name === "ConfigError") return { notSent: true, status: 503, code: "not_configured", message: `${label} isn't set up on the server yet.` };
  if (!d.dispatched) return { notSent: true, status: 502, code: "send_failed", message: `The email couldn't be sent through ${label}. Try again.` };
  return {
    notSent: false,
    status: 502,
    code: "send_unconfirmed",
    message: `${label} didn't confirm the email was sent. Check your Sent folder before sending it again.`,
  };
}

async function storeSent(account: AccountRow, input: SendInput, from: Addr, result: SentResult, contactId: string | null): Promise<string | null> {
  const parsed: ParsedMessage = {
    providerMessageId: result.providerMessageId,
    threadId: result.threadId,
    internetMessageId: result.internetMessageId,
    inReplyTo: result.inReplyTo,
    references: result.references,
    direction: "outbound",
    from,
    to: input.to,
    cc: input.cc,
    bcc: [],
    subject: input.subject,
    snippet: makeSnippet(input.bodyText),
    sentAt: result.sentAt,
    hasAttachments: false,
    skip: false,
    bodyText: input.bodyText,
    bodyHtml: null,
  };
  const stored = await repo().storedMessages(account.id, [result.providerMessageId]);
  await ingestBatch(
    { account, fetchFull: async () => parsed, stats: newStats(), extraContactIds: contactId ? [contactId] : [] },
    [{ meta: parsed, stored: stored[0] }],
  );
  const after = await repo().storedMessages(account.id, [result.providerMessageId]);
  return after[0]?.id ?? null;
}

export async function sendEmail(req: Request): Promise<Response> {
  const auth = await requireAuth(req, { roles: EDITORS });
  const input = validateSendInput(await readJson<Record<string, unknown>>(req, 400_000));
  const r = repo();

  const existing = await r.getSend(auth.userId, input.clientRequestId);
  if (existing && existing.status !== "failed") return replay(existing);

  const since = new Date(Date.now() - LIMITS.sendWindowMs).toISOString();
  if ((await r.countSendsSince(auth.userId, since)) >= LIMITS.sendsPerWindow) {
    throw new HttpError(429, "You've sent a lot of emails in the last few minutes. Please wait a little before sending more.", "rate_limited");
  }

  const account = await pickAccount(auth, input.accountId);
  const reply = input.replyToMessageId ? await replyContext(auth, account, input.replyToMessageId) : null;
  let contactId: string | null = null;
  if (input.contactId) {
    const c = await r.getContact(input.contactId);
    if (c && c.workspace_id === auth.workspaceId) contactId = c.id;
  }

  const fields = {
    account_id: account.id,
    to_addresses: input.to,
    cc_addresses: input.cc,
    subject: input.subject,
    body_text: input.bodyText,
    contact_id: contactId,
    in_reply_to_message_id: reply?.messageId ?? null,
  };
  let send: SendRow | null;
  if (existing) {
    // The earlier attempt certainly wasn't sent: try again with what's in the draft now.
    send = await r.updateSend(existing.id, { ...fields, status: "pending", error: null }, { onlyIfStatus: "failed" });
  } else {
    send = await r.insertSend({ ...fields, workspace_id: auth.workspaceId, user_id: auth.userId, client_request_id: input.clientRequestId, status: "pending" });
  }
  if (!send) {
    const again = await r.getSend(auth.userId, input.clientRequestId);
    if (!again) throw new HttpError(409, "This email is already being sent.", "send_in_progress");
    return replay(again);
  }

  const fromName = safeDisplayName(await r.userDisplayName(auth.userId).catch(() => null)) || account.display_name || null;
  const from: Addr = { email: account.email_address, name: fromName };
  const d: Dispatch = { dispatched: false };
  let result: SentResult;
  try {
    result = account.provider === "google" ? await sendViaGmail(account, input, from, reply, d) : await sendViaGraph(account, input, reply, d);
  } catch (err) {
    const c = classify(err, account, d);
    console.warn(`Email send ${send.id} via ${account.provider} ${c.notSent ? "failed" : "unconfirmed"}:`, err instanceof Error ? err.message : err);
    await r
      .updateSend(send.id, c.notSent ? { status: "failed", error: c.message } : { error: `unconfirmed: ${c.message}` })
      .catch((e) => console.error("Couldn't record the send outcome", e));
    throw new HttpError(c.status, c.message, c.code);
  }

  await r.updateSend(send.id, { status: "sent", provider_message_id: result.providerMessageId, sent_at: result.sentAt, error: null });
  let emailMessageId: string | null = null;
  try {
    emailMessageId = await storeSent(account, input, from, result, contactId);
    if (emailMessageId) await r.updateSend(send.id, { email_message_id: emailMessageId });
  } catch (err) {
    // Sent is sent: the next mailbox sync stores it if this didn't.
    console.warn(`Sent email ${send.id} couldn't be stored for the timeline yet:`, err instanceof Error ? err.message : err);
  }
  return json({ status: "sent", sendId: send.id, emailMessageId, providerMessageId: result.providerMessageId, sentAt: result.sentAt });
}
