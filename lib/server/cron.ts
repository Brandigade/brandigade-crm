import { getEnv } from "./env.js";
import { bearerToken, unauthorized } from "./http.js";
import { safeEqual } from "./crypto.js";
import { adminClient } from "./supabase.js";
import { runJobs, type JobHandler } from "./jobs.js";
import { emailJobHandlers, syncDueEmailAccounts } from "./email/worker.js";
import { notificationJobHandlers, scheduleNotifications } from "./notifications/worker.js";
import { voiceJobHandlers } from "./voice/worker.js";

// One scheduler "tick". Supabase pg_cron calls POST /api/cron/tick every
// minute (migration 20261017100300_scheduler.sql); Vercel's daily cron calls
// GET /api/cron/daily as a backstop. Each step is isolated so one failing
// integration never stops the others, and every step is safe to run twice at
// the same time (leases and dedupe keys in the database).

/** Checks the shared secret sent by pg_cron / Vercel Cron. */
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
    console.error(`cron step ${name} failed:`, err);
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
  // Send queued notifications, backfills, recording copies (leave time for sync).
  result.jobs = await step("jobs", () => runJobs(allJobHandlers(), { deadline: started + Math.floor(budget * 0.5) }));
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

/** Daily housekeeping (Vercel cron): prune old queue rows and expired OAuth states. */
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
  const tick = await step("tick", () => runTick({ budgetMs: 200_000 }));
  return { pruned, states, tick };
}
