import { LIMITS } from "./config.js";
import { participants, type ParsedMessage } from "./parse.js";
import { repo, type AccountRow, type MessageRow, type StoredMessage } from "./repo.js";
import { bound, htmlToText, makeSnippet, sanitizeEmailHtml } from "./sanitize.js";

// Turning provider messages into email_messages rows. Only messages that
// involve a lead are stored (matched on contacts.email_normalized, never on
// the mailbox's own address); the body is fetched only for those. Storing is
// idempotent: one row per (account, provider message id), and a rerun only
// adds newly matched leads to an existing row.

export interface IngestStats {
  examined: number;
  stored: number;
  updated: number;
}

export const newStats = (): IngestStats => ({ examined: 0, stored: 0, updated: 0 });

export interface IngestItem {
  meta: ParsedMessage;
  /** Our existing copy of this message, if any. */
  stored?: StoredMessage;
}

export interface IngestContext {
  account: AccountRow;
  /** Second fetch with the body, for messages that involve a lead. */
  fetchFull: (meta: ParsedMessage) => Promise<ParsedMessage | null>;
  stats: IngestStats;
  /** Leads to add even if the address match misses them (a send from a lead's record). */
  extraContactIds?: string[];
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** For each message, the ids of the leads it involves (sorted, unique). */
export async function matchLeads(workspaceId: string, ownAddress: string, msgs: Pick<ParsedMessage, "from" | "to" | "cc" | "bcc">[]): Promise<string[][]> {
  const perMsg = msgs.map((m) => participants(m, [ownAddress]));
  const all = [...new Set(perMsg.flat())];
  if (!all.length) return msgs.map(() => []);
  const contacts = await repo().contactsByEmails(workspaceId, all);
  const byEmail = new Map<string, string[]>();
  for (const c of contacts) {
    const key = (c.email_normalized || "").toLowerCase();
    if (!key) continue;
    byEmail.set(key, [...(byEmail.get(key) || []), c.id]);
  }
  return perMsg.map((emails) => [...new Set(emails.flatMap((e) => byEmail.get(e) || []))].sort());
}

export function metaFromStored(s: StoredMessage): ParsedMessage {
  return {
    providerMessageId: s.provider_message_id,
    threadId: null,
    internetMessageId: s.internet_message_id,
    inReplyTo: null,
    references: null,
    direction: "inbound",
    from: s.from_address ? { email: s.from_address, name: null } : null,
    to: s.to_addresses || [],
    cc: s.cc_addresses || [],
    bcc: s.bcc_addresses || [],
    subject: "",
    snippet: "",
    sentAt: new Date().toISOString(),
    hasAttachments: false,
    skip: false,
  };
}

export function buildRow(account: AccountRow, p: ParsedMessage, contactIds: string[]): MessageRow {
  const html = sanitizeEmailHtml(p.bodyHtml ?? null);
  const text = bound(p.bodyText ?? (p.bodyHtml ? htmlToText(p.bodyHtml) : null), LIMITS.bodyTextMax);
  return {
    workspace_id: account.workspace_id,
    account_id: account.id,
    owner_user_id: account.user_id,
    provider: account.provider,
    provider_message_id: p.providerMessageId,
    provider_thread_id: p.threadId,
    internet_message_id: p.internetMessageId,
    in_reply_to: p.inReplyTo,
    references_header: p.references,
    direction: p.direction,
    from_address: p.from?.email ?? null,
    from_name: bound(p.from?.name ?? null, 200),
    to_addresses: p.to.slice(0, 200),
    cc_addresses: p.cc.slice(0, 200),
    bcc_addresses: p.bcc.slice(0, 200),
    subject: bound(p.subject, LIMITS.subjectMax),
    snippet: makeSnippet(p.snippet || text),
    body_text: text,
    body_html: html,
    has_attachments: p.hasAttachments,
    sent_at: p.sentAt,
    visibility: account.sharing,
    matched_contact_ids: contactIds,
  };
}

/** Matches and stores one batch of messages. */
export async function ingestBatch(ctx: IngestContext, items: IngestItem[]): Promise<void> {
  const live = items.filter((i) => !i.meta.skip);
  ctx.stats.examined += live.length;
  if (!live.length) return;
  const matches = await matchLeads(ctx.account.workspace_id, ctx.account.email_address, live.map((i) => i.meta));
  const extra = ctx.extraContactIds || [];

  const fresh: { meta: ParsedMessage; ids: string[] }[] = [];
  for (let n = 0; n < live.length; n++) {
    const { meta, stored } = live[n];
    const ids = [...new Set([...matches[n], ...extra])].sort();
    if (stored) {
      const union = [...new Set([...(stored.matched_contact_ids || []), ...ids])].sort();
      const patch: Partial<MessageRow> = {};
      if (union.length !== (stored.matched_contact_ids || []).length) patch.matched_contact_ids = union;
      if (!stored.internet_message_id && meta.internetMessageId) patch.internet_message_id = meta.internetMessageId;
      if (Object.keys(patch).length) {
        await repo().updateMessage(stored.id, patch);
        stored.matched_contact_ids = union;
        if (patch.internet_message_id) stored.internet_message_id = patch.internet_message_id;
        ctx.stats.updated++;
      }
    } else if (ids.length) {
      fresh.push({ meta, ids });
    }
  }
  if (!fresh.length) return;

  const full = await mapLimit(fresh, 4, async (f) => ({ f, full: await ctx.fetchFull(f.meta) }));
  const rows = full
    .filter((x) => x.full && !x.full.skip)
    .map((x) => buildRow(ctx.account, { ...x.f.meta, ...x.full!, direction: x.f.meta.direction }, x.f.ids));
  if (rows.length) {
    await repo().insertMessages(rows);
    ctx.stats.stored += rows.length;
  }
}
