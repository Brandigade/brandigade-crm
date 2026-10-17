import type { JobHandler } from "../jobs.js";

// Background work for task notification emails.
// Called by lib/server/cron.ts on every scheduler tick.

export const notificationJobHandlers: Record<string, JobHandler> = {};

export async function scheduleNotifications(_opts: { now: Date }): Promise<unknown> {
  return { queued: 0 };
}
