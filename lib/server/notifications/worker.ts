// Background work for task notification emails. lib/server/cron.ts calls
// scheduleNotifications() on every scheduler tick (pg_cron, every minute) and
// then runs the queued jobs through notificationJobHandlers.
//
// Flow
//   * notify.task_assigned is queued by the database (trigger
//     tasks_notify_assignment), once per assignment.
//   * scheduleNotifications() queues notify.task_reminder, notify.task_overdue
//     and notify.daily_digest when they fall due (rules in ./rules.ts). It is
//     cheap (a handful of indexed reads per minute) and idempotent: every job
//     has a dedupe key, so running it twice, or two ticks overlapping, never
//     queues anything twice.
//   * Each handler re-reads the task, the person, their membership and their
//     preferences at send time and ends "skipped" (with the reason in
//     job_queue.result) when the email no longer applies: task deleted or
//     done, reassigned, due date changed, preference switched off, person
//     removed from the team, no email address, no sender configured.
//
// Delivery guarantee: at least once, at worst. The only window for a
// duplicate is between the provider accepting the email and the database
// recording it: right after a successful send the handler writes the send
// receipt into job_queue.result (a single UPDATE, before anything else), and
// a re-run job that already has a receipt returns "done" without sending.
// If the process dies inside that window, the job is retried after its lease
// and the email may go out twice. Two things soften even that: Resend gets an
// Idempotency-Key per notification (it drops the repeat), and SMTP emails
// carry a Message-ID derived from the dedupe key (Gmail and most clients
// show a repeated Message-ID once). Sends are bounded well inside the 120 s
// job lease (SMTP/HTTP timeouts in ./sender.ts), so a slow send can't be
// claimed by a second worker.
import { PermanentJobError, RetryJobLater, enqueueJob, type Job, type JobHandler, type JobOutcome } from "../jobs.js";
import { adminClient } from "../supabase.js";
import { getEnv } from "../env.js";
import {
  KINDS,
  MAX_LATE_MS,
  candidateDueDateRange,
  overdueAt,
  personTimeZone,
  planNotifications,
  reminderAt,
  taskRecipient,
  type Member,
  type TaskRow,
} from "./rules.js";
import { TASK_COLUMNS, loadTaskDetails, loadTaskLabels, loadWorkspaceContext, memberName, must, prefsOf, type TaskDetails, type WorkspaceContext } from "./data.js";
import {
  dailyDigestEmail,
  taskAssignedEmail,
  taskOverdueEmail,
  taskReminderEmail,
  type DigestItem,
  type DigestSections,
  type EmailContent,
  type TaskEmailContext,
} from "./content.js";
import { senderConfig, sendEmail, type OutgoingEmail, type SendResult, type SenderConfig } from "./sender.js";
import { addDays, formatClock, formatShortDate, localParts, naiveLocalToUtc, normalizeDate, normalizeTime } from "./time.js";

export const NO_SENDER_REASON = "No email sender is set up on the server";

export interface NotificationDeps {
  /** The configured sender (default: from the environment). */
  sender?: () => SenderConfig | null;
  /** Sends one email (default: ./sender.ts sendEmail). */
  send?: (msg: OutgoingEmail, cfg: SenderConfig) => Promise<SendResult>;
  now?: () => Date;
}

type Skip = { status: "skipped"; result: Record<string, unknown> };

// Nobody gets flooded: after this many "task assigned" emails in an hour,
// further ones are skipped (the tasks still show in the CRM and the digest).
export const MAX_ASSIGNMENT_EMAILS_PER_HOUR = 20;
async function assignmentEmailsLastHour(assigneeId: string): Promise<number> {
  const { count, error } = await adminClient()
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .eq("kind", "notify.task_assigned")
    .eq("status", "done")
    .eq("payload->>assignee_id", assigneeId)
    .gte("finished_at", new Date(Date.now() - 3_600_000).toISOString());
  if (error) return 0; // counting is a safeguard, not a reason to drop the email
  return count || 0;
}
const skip = (reason: string, extra: Record<string, unknown> = {}): Skip => ({ status: "skipped", result: { reason, ...extra } });

// A ceiling for the whole CRM: however many tasks are assigned or due, the
// server never sends more than this many notification emails in 24 hours, so
// the sender's daily quota (Gmail allows about 500) can't be used up.
// NOTIFICATION_MAX_PER_DAY overrides it.
export const MAX_NOTIFICATION_EMAILS_PER_DAY = 400;
export function notificationDailyCeiling(): number {
  const n = Number(getEnv("NOTIFICATION_MAX_PER_DAY"));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_NOTIFICATION_EMAILS_PER_DAY;
}
async function notificationEmailsLastDay(): Promise<number> {
  const { count, error } = await adminClient()
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .like("kind", "notify.%")
    .eq("status", "done")
    .gte("finished_at", new Date(Date.now() - 86_400_000).toISOString());
  if (error) return 0; // counting is a safeguard, not a reason to drop the email
  return count || 0;
}

const text = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));

/** "eddie@crm.test" -> "ed***@crm.test" (what job results keep). */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

/** A send receipt from an earlier run of this job, if any. */
function priorReceipt(job: Job): Record<string, unknown> | null {
  const r = (job as Job & { result?: unknown }).result;
  return r && typeof r === "object" && (r as Record<string, unknown>).sent_at ? (r as Record<string, unknown>) : null;
}

async function deliver(
  job: Job,
  deps: Required<NotificationDeps>,
  cfg: SenderConfig,
  to: Member,
  content: EmailContent,
  meta: Record<string, unknown>,
): Promise<JobOutcome> {
  if ((await notificationEmailsLastDay()) >= notificationDailyCeiling()) {
    return skip("The CRM reached its daily limit of notification emails; the task is still in the CRM", { recipient_id: to.user_id, ...meta });
  }
  const sent = await deps.send(
    { to: to.email!, toName: to.display_name, subject: content.subject, html: content.html, text: content.text, idempotencyKey: job.dedupe_key || `job:${job.id}` },
    cfg,
  );
  const result = {
    sent_at: deps.now().toISOString(),
    provider: sent.provider,
    message_id: sent.messageId,
    recipient_id: to.user_id,
    to: maskEmail(to.email!),
    subject: content.subject,
    ...meta,
  };
  // Record the receipt straight away (see "Delivery guarantee" above). A
  // failure here must not throw: the email is out, a retry would send it again.
  try {
    const { error } = await adminClient().from("job_queue").update({ result }).eq("id", job.id);
    if (error) console.warn(`notifications: couldn't record the receipt for job #${job.id}:`, error.message);
  } catch (err) {
    console.warn(`notifications: couldn't record the receipt for job #${job.id}:`, err instanceof Error ? err.message : err);
  }
  return { status: "done", result };
}

async function personLabel(ctx: WorkspaceContext, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const m = ctx.members.find((x) => x.user_id === userId);
  if (m) return memberName(m);
  const { data } = await adminClient().from("profiles").select("id,email,display_name").eq("id", userId).maybeSingle();
  return data ? memberName(data as { email: string | null; display_name: string | null }) : null;
}

function emailContext(details: TaskDetails, ctx: WorkspaceContext, to: Member, asOwner: boolean, assignedByName: string | null, now: Date): TaskEmailContext {
  return {
    task: details.task,
    lead: details.lead,
    deal: details.deal,
    workspaceTz: ctx.timeZone,
    recipientTz: personTimeZone(prefsOf(ctx, to.user_id), ctx.timeZone),
    recipientName: memberName(to),
    asOwner,
    assignedByName,
    now,
  };
}

const dueChanged = (t: TaskRow, p: Record<string, unknown>) =>
  normalizeDate(t.due_date) !== (p.due_date ?? null) || normalizeTime(t.due_time) !== (p.due_time || "");

/** Was this reminder already emailed by the old send-due-task-emails function (cutover)? */
async function sentByOldSystem(t: TaskRow): Promise<boolean> {
  if (!t.legacy_id) return false;
  const base = [t.workspace_id, t.legacy_id, normalizeDate(t.due_date) || "", normalizeTime(t.due_time)].join("|");
  const { data, error } = await adminClient().from("sent_task_emails").select("key").in("key", [`${base}|${t.reminder}`, base]).limit(1);
  if (error) return false; // table gone after cutover: nothing to check
  return !!(data && data.length);
}

export function createNotificationJobHandlers(overrides: NotificationDeps = {}): Record<string, JobHandler> {
  const deps: Required<NotificationDeps> = {
    sender: overrides.sender ?? senderConfig,
    send: overrides.send ?? ((msg, cfg) => sendEmail(msg, {}, cfg)),
    now: overrides.now ?? (() => new Date()),
  };

  /** Common start: an earlier run already sent it? Is a sender configured? */
  const begin = (job: Job): { done: JobOutcome } | { skip: Skip } | { cfg: SenderConfig } => {
    const receipt = priorReceipt(job);
    if (receipt) return { done: { status: "done", result: receipt } };
    const cfg = deps.sender();
    return cfg ? { cfg } : { skip: skip(NO_SENDER_REASON) };
  };

  const taskAssigned: JobHandler = async (job) => {
    const p = (job.payload || {}) as Record<string, unknown>;
    const taskId = text(p.task_id, 64);
    const assigneeId = text(p.assignee_id, 64);
    const version = Number(p.assignment_version);
    if (!taskId || !assigneeId || !Number.isInteger(version)) throw new PermanentJobError("The job has no task, assignee or assignment version");
    const start = begin(job);
    if ("done" in start) return start.done;
    if ("skip" in start) return start.skip;

    const details = await loadTaskDetails(adminClient(), taskId);
    if (!details) return skip("The task was deleted", { task_id: taskId });
    const t = details.task;
    if (t.status === "done") return skip("The task is already done", { task_id: taskId });
    if (t.assigned_to !== assigneeId || Number(t.assignment_version ?? 0) !== version) {
      return skip("The task was reassigned since", { task_id: taskId, assignment_version: t.assignment_version ?? null });
    }
    const assignedBy = text(p.assigned_by, 64) || t.assigned_by || null;
    if (assignedBy && assignedBy === assigneeId) return skip("People aren't emailed about tasks they assign to themselves", { task_id: taskId });
    const ctx = await loadWorkspaceContext(adminClient(), t.workspace_id);
    const to = ctx?.members.find((m) => m.user_id === assigneeId);
    if (!ctx || !to) return skip("The assignee is no longer on the team", { task_id: taskId, recipient_id: assigneeId });
    if (!prefsOf(ctx, assigneeId).notify_task_assigned) return skip("The assignee switched off task assigned emails", { task_id: taskId, recipient_id: assigneeId });
    if (!to.email) return skip("The assignee has no email address", { task_id: taskId, recipient_id: assigneeId });
    if (await assignmentEmailsLastHour(assigneeId) >= MAX_ASSIGNMENT_EMAILS_PER_HOUR) {
      return skip("Too many task assigned emails to this person in the last hour; the task is in their task list and digest", { task_id: taskId, recipient_id: assigneeId });
    }

    const content = taskAssignedEmail(emailContext(details, ctx, to, false, await personLabel(ctx, assignedBy), deps.now()));
    return deliver(job, deps, start.cfg, to, content, { task_id: taskId, assignment_version: version });
  };

  const taskReminder: JobHandler = async (job) => {
    const p = (job.payload || {}) as Record<string, unknown>;
    const taskId = text(p.task_id, 64);
    if (!taskId) throw new PermanentJobError("The job has no task");
    const start = begin(job);
    if ("done" in start) return start.done;
    if ("skip" in start) return start.skip;

    const details = await loadTaskDetails(adminClient(), taskId);
    if (!details) return skip("The task was deleted", { task_id: taskId });
    const t = details.task;
    if (t.status === "done") return skip("The task is already done", { task_id: taskId });
    if (dueChanged(t, p) || (t.reminder || "none") !== p.reminder) return skip("The due date or reminder changed since this was queued", { task_id: taskId });
    const ctx = await loadWorkspaceContext(adminClient(), t.workspace_id);
    if (!ctx) return skip("The workspace is gone", { task_id: taskId });
    const now = deps.now();
    const at = reminderAt(t, ctx.timeZone);
    if (!at) return skip("The task has no reminder any more", { task_id: taskId });
    if (at.getTime() > now.getTime() + 60_000) throw new RetryJobLater(at.getTime() - now.getTime(), "The reminder isn't due yet (the team's time zone changed)");
    if (now.getTime() - at.getTime() >= MAX_LATE_MS) return skip("The reminder is more than a day late", { task_id: taskId });
    const recipient = taskRecipient(t, ctx.members);
    if (!recipient) return skip("Nobody to send it to (no assignee and no owner)", { task_id: taskId });
    const to = recipient.member;
    if (!prefsOf(ctx, to.user_id).notify_task_reminders) return skip("The recipient switched off reminder emails", { task_id: taskId, recipient_id: to.user_id });
    if (!to.email) return skip("The recipient has no email address", { task_id: taskId, recipient_id: to.user_id });
    if (await sentByOldSystem(t)) return skip("Already emailed by the previous reminder system", { task_id: taskId });

    const content = taskReminderEmail(emailContext(details, ctx, to, recipient.asOwner, await personLabel(ctx, t.assigned_by), now));
    return deliver(job, deps, start.cfg, to, content, { task_id: taskId, due_date: p.due_date, due_time: p.due_time, reminder: p.reminder });
  };

  const taskOverdue: JobHandler = async (job) => {
    const p = (job.payload || {}) as Record<string, unknown>;
    const taskId = text(p.task_id, 64);
    if (!taskId) throw new PermanentJobError("The job has no task");
    const start = begin(job);
    if ("done" in start) return start.done;
    if ("skip" in start) return start.skip;

    const details = await loadTaskDetails(adminClient(), taskId);
    if (!details) return skip("The task was deleted", { task_id: taskId });
    const t = details.task;
    if (t.status === "done") return skip("The task is already done", { task_id: taskId });
    if (dueChanged(t, p)) return skip("The due date changed since this was queued", { task_id: taskId });
    const ctx = await loadWorkspaceContext(adminClient(), t.workspace_id);
    if (!ctx) return skip("The workspace is gone", { task_id: taskId });
    const recipient = taskRecipient(t, ctx.members);
    if (!recipient) return skip("Nobody to send it to (no assignee and no owner)", { task_id: taskId });
    const to = recipient.member;
    const prefs = prefsOf(ctx, to.user_id);
    if (!prefs.notify_task_overdue) return skip("The recipient switched off overdue emails", { task_id: taskId, recipient_id: to.user_id });
    if (!to.email) return skip("The recipient has no email address", { task_id: taskId, recipient_id: to.user_id });
    const now = deps.now();
    const at = overdueAt(t, ctx.timeZone, personTimeZone(prefs, ctx.timeZone), prefs.digest_hour)!;
    if (at.getTime() > now.getTime() + 60_000) throw new RetryJobLater(at.getTime() - now.getTime(), "Not overdue yet for the current recipient");
    if (now.getTime() - at.getTime() >= MAX_LATE_MS) return skip("The overdue email is more than a day late", { task_id: taskId });

    const content = taskOverdueEmail(emailContext(details, ctx, to, recipient.asOwner, await personLabel(ctx, t.assigned_by), now));
    return deliver(job, deps, start.cfg, to, content, { task_id: taskId, due_date: p.due_date, due_time: p.due_time });
  };

  const dailyDigest: JobHandler = async (job) => {
    const p = (job.payload || {}) as Record<string, unknown>;
    const userId = text(p.user_id, 64);
    const localDate = normalizeDate(p.local_date);
    if (!userId || !localDate || !job.workspace_id) throw new PermanentJobError("The job has no person, date or workspace");
    const start = begin(job);
    if ("done" in start) return start.done;
    if ("skip" in start) return start.skip;

    const db = adminClient();
    const ctx = await loadWorkspaceContext(db, job.workspace_id);
    const to = ctx?.members.find((m) => m.user_id === userId);
    if (!ctx || !to) return skip("The person is no longer on the team", { recipient_id: userId });
    const prefs = prefsOf(ctx, userId);
    if (!prefs.notify_daily_digest) return skip("The person switched off the daily digest", { recipient_id: userId });
    if (!to.email) return skip("The person has no email address", { recipient_id: userId });
    const tz = personTimeZone(prefs, ctx.timeZone);
    const now = deps.now();
    const today = localParts(now, tz).date;
    if (today !== localDate) return skip("This digest was for another day", { recipient_id: userId, local_date: localDate });

    const horizon = addDays(today, 7);
    const rows = (must(
      await db
        .from("tasks")
        .select(TASK_COLUMNS)
        .eq("workspace_id", ctx.id)
        .eq("assigned_to", userId)
        .neq("status", "done")
        .not("due_date", "is", null)
        .lte("due_date", addDays(horizon, 1))
        .order("due_date", { ascending: true })
        .limit(500),
      "load digest tasks",
    ) || []) as TaskRow[];

    const buckets: Record<"overdue" | "today" | "upcoming", { task: TaskRow; sortKey: number; due: string }[]> = { overdue: [], today: [], upcoming: [] };
    for (const t of rows) {
      const date = normalizeDate(t.due_date);
      if (!date) continue;
      const time = normalizeTime(t.due_time);
      let day: string;
      let overdue: boolean;
      let due: string;
      let sortKey: number;
      if (time) {
        const at = naiveLocalToUtc(date, time, ctx.timeZone);
        const local = localParts(at, tz);
        day = local.date;
        overdue = at.getTime() < now.getTime();
        due = `${formatShortDate(day)}, ${formatClock(local.time)}`;
        sortKey = at.getTime();
      } else {
        day = date;
        overdue = date < today;
        due = formatShortDate(date);
        sortKey = naiveLocalToUtc(date, "23:59", tz).getTime();
      }
      if (overdue) buckets.overdue.push({ task: t, sortKey, due: `Was due ${due}` });
      else if (day === today) buckets.today.push({ task: t, sortKey, due: time ? `Today, ${due.split(", ")[1]}` : "Today" });
      else if (day <= horizon) buckets.upcoming.push({ task: t, sortKey, due });
    }
    if (!buckets.overdue.length && !buckets.today.length && !buckets.upcoming.length) {
      return skip("Nothing overdue, due today or in the next 7 days", { recipient_id: userId, local_date: localDate });
    }
    const LIMIT = 15;
    const shown = (k: keyof typeof buckets) => buckets[k].sort((a, b) => a.sortKey - b.sortKey).slice(0, LIMIT);
    const pick = { overdue: shown("overdue"), today: shown("today"), upcoming: shown("upcoming") };
    const labels = await loadTaskLabels(db, [...pick.overdue, ...pick.today, ...pick.upcoming].map((x) => x.task));
    const item = (x: { task: TaskRow; due: string }): DigestItem => ({ task: x.task, due: x.due, leadName: labels.lead.get(x.task.id) || null, dealTitle: labels.deal.get(x.task.id) || null });
    const sections: DigestSections = {
      overdue: pick.overdue.map(item),
      today: pick.today.map(item),
      upcoming: pick.upcoming.map(item),
      more: {
        overdue: Math.max(0, buckets.overdue.length - LIMIT),
        today: Math.max(0, buckets.today.length - LIMIT),
        upcoming: Math.max(0, buckets.upcoming.length - LIMIT),
      },
    };
    const content = dailyDigestEmail({ recipientName: memberName(to), localDate, timeZone: tz, sections });
    return deliver(job, deps, start.cfg, to, content, {
      local_date: localDate,
      counts: { overdue: buckets.overdue.length, today: buckets.today.length, upcoming: buckets.upcoming.length },
    });
  };

  // Test emails are sent inside the request (routes.ts). The queued row is the
  // per-minute rate limit and the delivery log; it only reaches a worker if
  // that request died before recording the outcome, and then it is closed
  // without sending (a late test email would only confuse).
  const testEmail: JobHandler = async (job) => {
    const receipt = priorReceipt(job);
    if (receipt) return { status: "done", result: receipt };
    return skip("The request that asked for this test email didn't finish");
  };

  return {
    [KINDS.assigned]: taskAssigned,
    [KINDS.reminder]: taskReminder,
    [KINDS.overdue]: taskOverdue,
    [KINDS.digest]: dailyDigest,
    [KINDS.test]: testEmail,
  };
}

export const notificationJobHandlers: Record<string, JobHandler> = createNotificationJobHandlers();

const chunks = <T>(arr: T[], size: number) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

async function scheduleWorkspace(ws: { id: string; name?: string; settings?: unknown }, now: Date) {
  const db = adminClient();
  const ctx = await loadWorkspaceContext(db, ws.id, ws);
  if (!ctx) return { planned: 0, queued: 0, failed: 0 };
  const range = candidateDueDateRange(now);
  const tasks = (must(
    await db
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("workspace_id", ws.id)
      .neq("status", "done")
      .gte("due_date", range.from)
      .lte("due_date", range.to)
      .limit(5000),
    "load due tasks",
  ) || []) as TaskRow[];
  const plan = planNotifications({ now, workspaceTz: ctx.timeZone, tasks, members: ctx.members, prefsByUser: ctx.prefsByUser });
  if (!plan.length) return { planned: 0, queued: 0, failed: 0 };

  // One read tells which of these are already queued, so a busy minute costs
  // a select instead of an insert attempt per notification.
  const existing = new Set<string>();
  for (const keys of chunks(plan.map((j) => j.dedupeKey), 100)) {
    const rows = (must(await db.from("job_queue").select("dedupe_key").in("dedupe_key", keys), "check queued jobs") || []) as { dedupe_key: string }[];
    rows.forEach((r) => existing.add(r.dedupe_key));
  }
  let queued = 0;
  let failed = 0;
  for (const job of plan) {
    if (existing.has(job.dedupeKey)) continue;
    try {
      const id = await enqueueJob(job.kind, job.payload, { dedupeKey: job.dedupeKey, workspaceId: ws.id });
      if (id !== null) queued++;
    } catch (err) {
      failed++;
      console.error(`notifications: couldn't queue ${job.kind}:`, err instanceof Error ? err.message : err);
    }
  }
  return { planned: plan.length, queued, failed };
}

/**
 * Queues the reminder, overdue and digest emails that are due at `now`.
 * Without a configured sender it does nothing (the moment one is set up,
 * reminders that went off in the last 24 h are still sent, as before).
 */
export async function scheduleNotifications(opts: { now: Date }, overrides: Pick<NotificationDeps, "sender"> = {}): Promise<unknown> {
  const cfg = (overrides.sender ?? senderConfig)();
  if (!cfg) return { queued: 0, skipped: NO_SENDER_REASON };
  const db = adminClient();
  const workspaces = (must(await db.from("workspaces").select("id,name,settings").eq("status", "active"), "load workspaces") || []) as {
    id: string;
    name: string;
    settings: unknown;
  }[];
  const total = { workspaces: workspaces.length, planned: 0, queued: 0, failed: 0 };
  for (const ws of workspaces) {
    const r = await scheduleWorkspace(ws, opts.now);
    total.planned += r.planned;
    total.queued += r.queued;
    total.failed += r.failed;
  }
  return total;
}
