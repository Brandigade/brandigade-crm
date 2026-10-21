import { ON_EDGE, getEnv } from "./env.js";
import { bearerToken, errorSummary, unauthorized } from "./http.js";
import { safeEqual } from "./crypto.js";
import { adminClient } from "./supabase.js";
import { runJobs, type JobHandler } from "./jobs.js";
import { emailJobHandlers, syncDueEmailAccounts } from "./email/worker.js";
import { notificationJobHandlers, scheduleNotifications } from "./notifications/worker.js";
import { voiceJobHandlers } from "./voice/worker.js";

// One scheduler "tick". Supabase pg_cron calls POST /api/cron/tick every
// minute (migration 20261017100300_scheduler.sql) and GET /api/cron/daily once
// a day for housekeeping (20261020100000_scheduler_daily.sql). Each step is isolated so one failing
// integration never stops the others, and every step is safe to run twice at
// the same time (leases and dedupe keys in the database).

/** Checks the shared secret pg_cron sends. */
export function requireCronSecret(req: Request) {
  const expected = getEnv("CRON_SECRET");
  const got = bearerToken(req);
  if (!expected || !got || !safeEqual(got, expected)) throw unauthorized("Bad cron secret");
}

export const allJobHandlers = (): Record<string, JobHandler> => ({
  ...notificationJobHandlers,
  ...emailJobHandlers,
  ...voiceJobHandlers,
});

async function step<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`cron step ${name} failed:`, errorSummary(err));
    return { ok: false, error };
  }
}

export async function runTick(opts: { budgetMs?: number; now?: Date } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 50_000;
  const deadline = started + budget;
  const now = opts.now ?? new Date();
  const result: Record<string, unknown> = {};
  // Cheap: work out which reminders / digests are due and queue them.
  result.scheduleNotifications = await step("scheduleNotifications", () => scheduleNotifications({ now }));
  // Notification emails first, with their own share of the time, so a large
  // import (one backfill job per lead) can never delay reminders.
  result.notificationJobs = await step("notificationJobs", () => runJobs(notificationJobHandlers, { deadline: started + Math.floor(budget * 0.3) }));
  // Call recordings next, also with their own share, so they are copied into
  // the CRM minutes after a call even while a big import is being backfilled.
  result.voiceJobs = await step("voiceJobs", () => runJobs(voiceJobHandlers, { deadline: started + Math.floor(budget * 0.4), maxJobs: ON_EDGE ? 5 : 25 }));
  // Then mailbox backfills, a bounded number per tick.
  result.jobs = await step("jobs", () => runJobs(emailJobHandlers, { deadline: started + Math.floor(budget * 0.6), maxJobs: ON_EDGE ? 3 : 25 }));
  // Pull new mail from connected mailboxes.
  result.emailSync = await step("emailSync", () => syncDueEmailAccounts({ deadline }));
  result.reaped = await step("reap", async () => {
    const { data, error } = await adminClient().rpc("reap_dead_jobs");
    if (error) throw error;
    return data;
  });
  result.ms = Date.now() - started;
  return result;
}

/** Daily housekeeping (pg_cron job "crm-daily"): prune old queue rows, expired OAuth states and long-expired invites. */
export async function runDaily() {
  const db = adminClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const pruned = await step("pruneJobs", async () => {
    const { error, count } = await db
      .from("job_queue")
      .delete({ count: "exact" })
      .in("status", ["done", "skipped", "dead"])
      .lt("updated_at", cutoff);
    if (error) throw error;
    return count;
  });
  const states = await step("pruneOauthStates", async () => {
    const { error, count } = await db.from("oauth_states").delete({ count: "exact" }).lt("expires_at", new Date().toISOString());
    if (error) throw error;
    return count;
  });
  const invites = await step("pruneInvites", async () => {
    const { error, count } = await db.from("workspace_invites").delete({ count: "exact" }).is("accepted_at", null).lt("expires_at", cutoff);
    if (error) throw error;
    return count;
  });
  return { pruned, states, invites };
}
