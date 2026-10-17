import { LIMITS, urls } from "./config.js";
import { DeltaResetError, GraphClient } from "./graph.js";
import { ingestBatch, type IngestItem, type IngestStats } from "./ingest.js";
import { graphBodies, parseGraphMessage, type GraphMessage, type ParsedMessage } from "./parse.js";
import { repo, type AccountRow } from "./repo.js";
import { timeUp, type SyncRun } from "./sync-gmail.js";
import type { MailboxAuth } from "./tokens.js";

// Outlook / Microsoft 365 sync with Graph delta queries on Inbox and Sent
// Items. The first delta of a folder is limited to the last 30 days; the
// deltaLink (or, mid-way, the nextLink) is kept per folder in sync_cursor.
// An expired delta (410 / syncStateNotFound) restarts that folder with a
// 7-day window. Bodies are fetched only for messages that involve a lead.

export const GRAPH_FOLDERS = ["inbox", "sentitems"] as const;
export type GraphFolder = (typeof GRAPH_FOLDERS)[number];

export interface GraphCursor {
  folders?: Partial<Record<GraphFolder, { link: string; complete: boolean }>>;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

function fullFetcher(graph: GraphClient, own: string, folder?: GraphFolder, skipFolderIds: string[] = []) {
  return async (meta: ParsedMessage): Promise<ParsedMessage | null> => {
    const m = await graph.getMessage(meta.providerMessageId);
    if (!m) return null;
    const parsed = parseGraphMessage(m, own, folder, skipFolderIds);
    const bodies = graphBodies(m);
    return { ...parsed, bodyText: bodies.text, bodyHtml: bodies.html };
  };
}

/** Matches and stores one page of Graph messages. */
export async function processGraphMessages(
  graph: GraphClient,
  account: AccountRow,
  messages: GraphMessage[],
  stats: IngestStats,
  opts: { folder?: GraphFolder; rematch?: boolean; skipFolderIds?: string[]; since?: Date } = {},
): Promise<void> {
  const own = account.email_address;
  const metas = messages
    .filter((m) => m && typeof m.id === "string")
    .map((m) => parseGraphMessage(m, own, opts.folder, opts.skipFolderIds))
    .filter((p) => !p.skip && (!opts.since || Date.parse(p.sentAt) >= opts.since.getTime()));
  if (!metas.length) return;
  const stored = new Map((await repo().storedMessages(account.id, metas.map((m) => m.providerMessageId))).map((s) => [s.provider_message_id, s]));
  const items: IngestItem[] = [];
  for (const meta of metas) {
    const s = stored.get(meta.providerMessageId);
    if (!s || !s.internet_message_id || opts.rematch) items.push({ meta, stored: s });
  }
  await ingestBatch({ account, fetchFull: fullFetcher(graph, own, opts.folder, opts.skipFolderIds), stats }, items);
}

async function syncFolder(graph: GraphClient, account: AccountRow, cursor: GraphCursor, folder: GraphFolder, deadline: number, stats: IngestStats): Promise<boolean> {
  cursor.folders = cursor.folders || {};
  const base = urls.graphApi() + "/";
  let state = cursor.folders[folder];
  // A link that doesn't point at the Graph API we use is never followed.
  if (state && !state.link.startsWith(base)) state = undefined;
  let url = state?.link || graph.deltaStartUrl(folder, daysAgo(account.initial_sync_done ? LIMITS.rescanWindowDays : LIMITS.initialWindowDays));
  let resets = 0;
  let examined = 0;
  for (;;) {
    if (timeUp(deadline, 6000) || examined >= LIMITS.graphMessagesPerRun) {
      cursor.folders[folder] = { link: url, complete: false };
      return false;
    }
    let page;
    try {
      page = await graph.delta(url);
    } catch (err) {
      if (!(err instanceof DeltaResetError) || resets++ > 0) throw err;
      url = graph.deltaStartUrl(folder, daysAgo(LIMITS.rescanWindowDays));
      continue;
    }
    const value = page.value || [];
    examined += value.length;
    await processGraphMessages(graph, account, value, stats, { folder });
    const next = page["@odata.nextLink"];
    const delta = page["@odata.deltaLink"];
    if (next && next.startsWith(base)) {
      url = next;
      cursor.folders[folder] = { link: url, complete: false };
      continue;
    }
    if (delta && delta.startsWith(base)) {
      cursor.folders[folder] = { link: delta, complete: true };
      return true;
    }
    throw new Error("Outlook returned a delta page without a next or delta link");
  }
}

export async function syncGraph(auth: MailboxAuth, cursor: GraphCursor, deadline: number, stats: IngestStats): Promise<SyncRun> {
  const graph = new GraphClient(auth);
  let done = true;
  for (const folder of GRAPH_FOLDERS) {
    if (!(await syncFolder(graph, auth.account, cursor, folder, deadline, stats))) done = false;
    if (timeUp(deadline, 6000)) {
      done = false;
      break;
    }
  }
  const folders = cursor.folders || {};
  const initialDone = auth.account.initial_sync_done || GRAPH_FOLDERS.every((f) => folders[f]?.complete);
  return { done: done && GRAPH_FOLDERS.every((f) => folders[f]?.complete), initialDone };
}

/** A lead's emails from the last 90 days in one Outlook mailbox ($search on participants). */
export async function backfillGraph(auth: MailboxAuth, email: string, deadline: number, stats: IngestStats): Promise<boolean> {
  const graph = new GraphClient(auth);
  const since = daysAgo(LIMITS.backfillWindowDays);
  const skipFolderIds = (await Promise.all(["junkemail", "deleteditems", "drafts"].map((f) => graph.folderId(f)))).filter((x): x is string => !!x);
  const base = urls.graphApi() + "/";
  let url: string | undefined = graph.searchUrl(email, since);
  let seen = 0;
  while (url) {
    if (timeUp(deadline, 6000)) return false;
    const page = await graph.page(url);
    const value = page.value || [];
    seen += value.length;
    await processGraphMessages(graph, auth.account, value, stats, { rematch: true, skipFolderIds, since });
    const next = page["@odata.nextLink"];
    url = next && next.startsWith(base) && seen < LIMITS.backfillMaxMessages && value.length ? next : undefined;
  }
  return true;
}
