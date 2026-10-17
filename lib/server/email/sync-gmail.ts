import { LIMITS } from "./config.js";
import { GmailClient, HistoryGoneError } from "./gmail.js";
import { ingestBatch, mapLimit, metaFromStored, type IngestItem, type IngestStats } from "./ingest.js";
import { GMAIL_SKIP_LABELS, gmailBodies, parseGmailMessage, type ParsedMessage } from "./parse.js";
import { repo, type AccountRow } from "./repo.js";
import type { MailboxAuth } from "./tokens.js";

// Gmail sync.
//   First run: remember the mailbox's current historyId, then scan the last
//   30 days (at most ~500 messages), page by page so a run that runs out of
//   time resumes where it stopped.
//   Afterwards: history.list from the stored historyId (messageAdded only).
//   If Gmail no longer has that history (404), rescan the last 7 days.
// Metadata is fetched first; the body only for messages that involve a lead.

export interface GmailScan {
  query: string;
  pageToken: string | null;
  startHistoryId: string;
  examined: number;
  max: number;
}

export interface GmailCursor {
  historyId?: string;
  scan?: GmailScan;
}

export interface SyncRun {
  /** False when the run stopped early (deadline) and should continue soon. */
  done: boolean;
  initialDone: boolean;
}

export const timeUp = (deadline: number, marginMs = 4000) => Date.now() >= deadline - marginMs;

const BASE_QUERY = "-in:drafts -in:chats";

function fullFetcher(gmail: GmailClient, own: string) {
  return async (meta: ParsedMessage): Promise<ParsedMessage | null> => {
    const m = await gmail.getMessage(meta.providerMessageId, "full");
    if (!m) return null;
    const parsed = parseGmailMessage(m, own);
    const bodies = gmailBodies(m.payload);
    return { ...parsed, bodyText: bodies.text, bodyHtml: bodies.html };
  };
}

/**
 * Matches and stores a list of Gmail message ids. Messages we already hold
 * are skipped (no API call) unless `rematch` is set, in which case their
 * stored addresses are matched again (a lead was added or changed).
 */
export async function processGmailIds(
  gmail: GmailClient,
  account: AccountRow,
  ids: string[],
  stats: IngestStats,
  opts: { rematch?: boolean } = {},
): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const own = account.email_address;
  const stored = new Map((await repo().storedMessages(account.id, unique)).map((s) => [s.provider_message_id, s]));
  const items: IngestItem[] = [];
  const toFetch: string[] = [];
  for (const id of unique) {
    const s = stored.get(id);
    if (!s || !s.internet_message_id) toFetch.push(id);
    else if (opts.rematch) items.push({ meta: metaFromStored(s), stored: s });
  }
  const metas = await mapLimit(toFetch, 6, (id) => gmail.getMessage(id, "metadata"));
  metas.forEach((m, i) => {
    if (m) items.push({ meta: parseGmailMessage(m, own), stored: stored.get(toFetch[i]) });
  });
  await ingestBatch({ account, fetchFull: fullFetcher(gmail, own), stats }, items);
}

async function runScan(gmail: GmailClient, account: AccountRow, scan: GmailScan, deadline: number, stats: IngestStats): Promise<boolean> {
  for (;;) {
    const remaining = scan.max - scan.examined;
    if (remaining <= 0) return true;
    if (timeUp(deadline, 6000)) return false;
    const page = await gmail.listMessages(scan.query, scan.pageToken || undefined, Math.min(100, remaining));
    const ids = (page.messages || []).map((m) => m.id);
    await processGmailIds(gmail, account, ids, stats);
    scan.examined += ids.length;
    scan.pageToken = page.nextPageToken || null;
    if (!page.nextPageToken || !ids.length) return true;
  }
}

function startScan(days: number, historyId: string): GmailScan {
  return { query: `newer_than:${days}d ${BASE_QUERY}`, pageToken: null, startHistoryId: historyId, examined: 0, max: LIMITS.initialMaxMessages };
}

/** Runs the scan in the cursor (if any) to the end; then the cursor holds a historyId. */
async function finishScan(gmail: GmailClient, account: AccountRow, cursor: GmailCursor, deadline: number, stats: IngestStats): Promise<boolean> {
  if (!cursor.scan) return true;
  const finished = await runScan(gmail, account, cursor.scan, deadline, stats);
  if (!finished) return false;
  cursor.historyId = cursor.scan.startHistoryId;
  delete cursor.scan;
  return true;
}

async function runHistory(gmail: GmailClient, account: AccountRow, cursor: GmailCursor, deadline: number, stats: IngestStats): Promise<boolean> {
  let pageToken: string | undefined;
  let budget = LIMITS.incrementalMaxMessages;
  for (;;) {
    if (timeUp(deadline, 6000)) return false;
    const page = await gmail.history(cursor.historyId!, pageToken);
    // Records come oldest first. Process them in groups and move the cursor
    // past each finished group, so a run cut short resumes without gaps.
    const records = page.history || [];
    let group: string[] = [];
    let groupLast: string | null = null;
    const flush = async () => {
      if (group.length) await processGmailIds(gmail, account, group, stats);
      budget -= group.length;
      if (groupLast) cursor.historyId = groupLast;
      group = [];
      groupLast = null;
    };
    for (const rec of records) {
      for (const added of rec.messagesAdded || []) {
        const labels = added.message.labelIds || [];
        if (labels.some((l) => GMAIL_SKIP_LABELS.includes(l))) continue;
        group.push(added.message.id);
      }
      groupLast = rec.id;
      if (group.length >= 100) {
        await flush();
        if (timeUp(deadline, 6000) || budget <= 0) return false;
      }
    }
    await flush();
    if (!page.nextPageToken) {
      if (page.historyId) cursor.historyId = page.historyId;
      return true;
    }
    if (budget <= 0) return false;
    pageToken = page.nextPageToken;
  }
}

export async function syncGmail(auth: MailboxAuth, cursor: GmailCursor, deadline: number, stats: IngestStats): Promise<SyncRun> {
  const gmail = new GmailClient(auth);
  const account = auth.account;
  let initialDone = account.initial_sync_done;
  if (!cursor.scan && !cursor.historyId) {
    const profile = await gmail.profile();
    cursor.scan = startScan(LIMITS.initialWindowDays, String(profile.historyId));
  }
  if (cursor.scan) {
    if (!(await finishScan(gmail, account, cursor, deadline, stats))) return { done: false, initialDone };
    initialDone = true;
  }
  try {
    return { done: await runHistory(gmail, account, cursor, deadline, stats), initialDone };
  } catch (err) {
    if (!(err instanceof HistoryGoneError)) throw err;
    // Too long since the last sync: Gmail dropped that history. Rescan a week.
    const profile = await gmail.profile();
    delete cursor.historyId;
    cursor.scan = startScan(LIMITS.rescanWindowDays, String(profile.historyId));
    return { done: await finishScan(gmail, account, cursor, deadline, stats), initialDone };
  }
}

/** A lead's emails from the last 90 days in one Gmail mailbox. */
export async function backfillGmail(auth: MailboxAuth, email: string, deadline: number, stats: IngestStats): Promise<boolean> {
  const gmail = new GmailClient(auth);
  const q = `{from:${email} to:${email} cc:${email} bcc:${email}} newer_than:${LIMITS.backfillWindowDays}d ${BASE_QUERY}`;
  let pageToken: string | undefined;
  let seen = 0;
  for (;;) {
    if (timeUp(deadline, 6000)) return false;
    const page = await gmail.listMessages(q, pageToken, Math.min(100, LIMITS.backfillMaxMessages - seen));
    const ids = (page.messages || []).map((m) => m.id);
    await processGmailIds(gmail, auth.account, ids, stats, { rematch: true });
    seen += ids.length;
    if (!page.nextPageToken || !ids.length || seen >= LIMITS.backfillMaxMessages) return true;
    pageToken = page.nextPageToken;
  }
}
