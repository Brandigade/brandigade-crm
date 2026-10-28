import { features } from "../env.js";
import { PermanentJobError, RetryJobLater, type Job, type JobContext, type JobOutcome } from "../jobs.js";
import { ProviderError, RateLimitError } from "../retry.js";
import { isValidAddress } from "./addresses.js";
import { LIMITS, providerConfigured, providerLabel } from "./config.js";
import { newStats, type IngestStats, internalAddressFilter } from "./ingest.js";
import { ReconnectRequiredError } from "./provider-http.js";
import { repo, type AccountRow } from "./repo.js";
import { backfillGmail, syncGmail, type GmailCursor, type SyncRun } from "./sync-gmail.js";
import { backfillGraph, syncGraph, type GraphCursor } from "./sync-graph.js";
import { MailboxAuth } from "./tokens.js";

// Mailbox sync bookkeeping: claim due mailboxes, sync each within the time
// budget, then record success (next sync in ~2 minutes) or failure
// (exponential backoff up to an hour; a provider rate limit waits exactly as
// long as the provider asked). Revoked access stops the mailbox until its
// owner reconnects it.

export interface SyncOutcome {
  accountId: string;
  ok: boolean;
  done?: boolean;
  reconnectRequired?: boolean;
  rateLimited?: boolean;
  error?: string;
  examined: number;
  stored: number;
  updated: number;
}

/** 1, 2, 4 ... minutes, at most an hour. */
export function syncBackoffMs(failures: number): number {
  return Math.min(LIMITS.maxBackoffMs, 60_000 * 2 ** Math.max(0, failures - 1));
}

/** What the mailbox owner sees under the mailbox (never tokens or bodies). */
export function humanSyncError(account: Pick<AccountRow, "provider">, err: unknown): string {
  const label = providerLabel(account.provider);
  if (err instanceof ProviderError) return `${err.message}`.slice(0, 300) || `${label} returned an error (HTTP ${err.status}).`;
  const name = (err as any)?.name;
  if (name === "ConfigError") return `${label} isn't fully set up on the server. Ask the CRM owner.`;
  if (name === "TimeoutError" || name === "AbortError" || (err instanceof TypeError && /fetch/i.test(err.message))) {
    return `Couldn't reach ${label}. The CRM will keep trying.`;
  }
  if (err instanceof Error && /app credentials/.test(err.message)) return err.message.slice(0, 300);
  return "Syncing failed. The CRM will try again shortly.";
}

const cloneCursor = (c: unknown): Record<string, any> => (c && typeof c === "object" ? JSON.parse(JSON.stringify(c)) : {});

export async function syncAccount(account: AccountRow, opts: { deadline: number }): Promise<SyncOutcome> {
  const stats: IngestStats = newStats();
  const cursor = cloneCursor(account.sync_cursor);
  const base = { accountId: account.id, examined: 0, stored: 0, updated: 0 };
  try {
    if (!providerConfigured(account.provider)) {
      throw Object.assign(new Error(`${providerLabel(account.provider)} is not configured`), { name: "ConfigError" });
    }
    const auth = new MailboxAuth(account);
    const run: SyncRun =
      account.provider === "google"
        ? await syncGmail(auth, cursor as GmailCursor, opts.deadline, stats)
        : await syncGraph(auth, cursor as GraphCursor, opts.deadline, stats);
    const now = Date.now();
    await repo().updateAccount(
      account.id,
      {
        sync_cursor: cursor,
        initial_sync_done: account.initial_sync_done || run.initialDone,
        last_synced_at: new Date(now).toISOString(),
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        // Unfinished (out of time): carry on at the next tick.
        next_sync_at: new Date(run.done ? now + LIMITS.syncIntervalMs : now).toISOString(),
        sync_lock_until: null,
      },
      { onlyIfStatus: "active" },
    );
    return { ...base, ...stats, ok: true, done: run.done };
  } catch (err) {
    const now = Date.now();
    if (err instanceof ReconnectRequiredError) {
      await repo().updateAccount(account.id, { sync_lock_until: null, sync_cursor: cursor });
      return { ...base, ...stats, ok: false, reconnectRequired: true, error: err.message };
    }
    if (err instanceof RateLimitError) {
      await repo().updateAccount(
        account.id,
        { sync_cursor: cursor, next_sync_at: new Date(now + Math.max(30_000, err.retryAfterMs)).toISOString(), sync_lock_until: null },
        { onlyIfStatus: "active" },
      );
      return { ...base, ...stats, ok: false, rateLimited: true, error: "rate limited" };
    }
    const failures = (account.consecutive_failures || 0) + 1;
    const message = humanSyncError(account, err);
    console.warn(`Email sync failed for mailbox ${account.id} (${account.provider}, failure ${failures}):`, err instanceof Error ? err.message : err);
    await repo().updateAccount(
      account.id,
      {
        sync_cursor: cursor,
        consecutive_failures: failures,
        last_error: message,
        last_error_at: new Date(now).toISOString(),
        next_sync_at: new Date(now + syncBackoffMs(failures)).toISOString(),
        sync_lock_until: null,
      },
      { onlyIfStatus: "active" },
    );
    return { ...base, ...stats, ok: false, error: message };
  }
}

/** Called by the scheduler tick (lib/server/cron.ts). */
export async function syncDueEmailAccounts(opts: { deadline: number }): Promise<unknown> {
  if (!features.tokenEncryption() || (!features.gmail() && !features.outlook())) return { skipped: "not_configured" };
  const summary = { claimed: 0, synced: 0, partial: 0, failed: 0, reconnectRequired: 0, rateLimited: 0, examined: 0, stored: 0 };
  while (Date.now() < opts.deadline - 8000 && summary.claimed < LIMITS.mailboxesPerTick) {
    const lease = Math.max(30, Math.ceil((opts.deadline - Date.now()) / 1000) + 30);
    const batch = await repo().claimAccounts(Math.min(3, LIMITS.mailboxesPerTick - summary.claimed), lease);
    if (!batch.length) break;
    summary.claimed += batch.length;
    for (const account of batch) {
      if (Date.now() >= opts.deadline - 5000) {
        await repo().updateAccount(account.id, { sync_lock_until: null }); // let the next tick have it
        continue;
      }
      const r = await syncAccount(account, { deadline: Math.min(opts.deadline, Date.now() + 25_000) });
      summary.examined += r.examined;
      summary.stored += r.stored;
      if (r.ok) summary[r.done ? "synced" : "partial"]++;
      else if (r.reconnectRequired) summary.reconnectRequired++;
      else if (r.rateLimited) summary.rateLimited++;
      else summary.failed++;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Job "email.backfill_contact": a lead got a (new) email address; pull in
// their emails from the last 90 days from every active mailbox in the CRM.
// ---------------------------------------------------------------------------
export async function backfillContact(job: Job, ctx: JobContext): Promise<JobOutcome> {
  const payload = (job.payload || {}) as { contact_id?: unknown; email?: unknown };
  const contactId = typeof payload.contact_id === "string" ? payload.contact_id : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!contactId || !email) throw new PermanentJobError("Job payload needs contact_id and email");
  const contact = await repo().getContact(contactId);
  if (!contact) return { status: "skipped", result: { reason: "lead deleted" } };
  if (contact.email_normalized !== email) return { status: "skipped", result: { reason: "email changed" } };
  if (!isValidAddress(email)) return { status: "skipped", result: { reason: "not a valid address" } };
  if ((await internalAddressFilter(contact.workspace_id))(email)) return { status: "skipped", result: { reason: "a teammate's own address" } };
  if (!features.tokenEncryption()) return { status: "skipped", result: { reason: "email not configured" } };

  const accounts = (await repo().listAccounts({ workspaceId: contact.workspace_id, statuses: ["active"] })).filter(
    (a) => a.sync_enabled && providerConfigured(a.provider),
  );
  const stats = newStats();
  let mailboxes = 0;
  for (const account of accounts) {
    const role = await repo().memberRole(account.workspace_id, account.user_id);
    if (role !== "owner" && role !== "admin" && role !== "editor") continue;
    if (Date.now() >= ctx.deadline - 10_000) throw new RetryJobLater(15_000, "Ran out of time; continuing shortly");
    const auth = new MailboxAuth(account);
    try {
      const finished =
        account.provider === "google"
          ? await backfillGmail(auth, email, ctx.deadline, stats)
          : await backfillGraph(auth, email, ctx.deadline, stats);
      if (!finished) throw new RetryJobLater(15_000, "Ran out of time; continuing shortly");
      mailboxes++;
    } catch (err) {
      if (err instanceof ReconnectRequiredError) continue; // that mailbox needs its owner; the others still count
      if (err instanceof RateLimitError) throw new RetryJobLater(Math.max(30_000, err.retryAfterMs), "Provider rate limit");
      throw err;
    }
  }
  return { status: "done", result: { mailboxes, examined: stats.examined, stored: stats.stored, updated: stats.updated } };
}
