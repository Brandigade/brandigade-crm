import type { JobHandler } from "../jobs.js";
import { backfillContact, syncDueEmailAccounts as syncDue } from "./sync.js";

// Background work for email: mailbox sync and the per-lead backfill job.
// Called by lib/server/cron.ts on every scheduler tick.

export const emailJobHandlers: Record<string, JobHandler> = {
  "email.backfill_contact": backfillContact,
};

export async function syncDueEmailAccounts(opts: { deadline: number }): Promise<unknown> {
  return syncDue(opts);
}
