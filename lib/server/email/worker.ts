import type { JobHandler } from "../jobs.js";

// Background work for email: mailbox sync and the per-lead backfill job.
// Called by lib/server/cron.ts on every scheduler tick.

export const emailJobHandlers: Record<string, JobHandler> = {};

export async function syncDueEmailAccounts(_opts: { deadline: number }): Promise<unknown> {
  return { synced: 0 };
}
