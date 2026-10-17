// When each task notification is due, who gets it, and its dedupe key.
// Pure functions (no database, no clock): the scheduler and the job handlers
// both use them, and the unit tests pin them down.
//
//   notify.task_reminder  the task's own reminder (at due time / 15 min /
//                         1 hour / 1 day before; "none" = no email), as long
//                         as it went off less than 24 h ago. Same rule as the
//                         old send-due-task-emails function and the in-app
//                         reminder.
//   notify.task_overdue   once per due date + time while the task is open:
//                         1 hour after the due time, or for date-only tasks
//                         the next morning at the person's digest hour in
//                         their time zone; only within 24 h of that moment.
//   notify.daily_digest   once per person per local day, during their digest
//                         hour (in their time zone).
//
// Recipient for reminder/overdue: the assignee; unassigned (or assigned to
// someone who left the team) -> the CRM owner, as before.
import { DAY, HOUR, addDays, localParts, naiveLocalToUtc, normalizeDate, normalizeTime, validTimeZone } from "./time.js";

export const REMINDER_OFFSETS_MS: Record<string, number> = {
  at_due: 0,
  "15_min": 15 * 60 * 1000,
  "1_hour": HOUR,
  "1_day": DAY,
};

/** Notifications that are more than this late are dropped, not sent. */
export const MAX_LATE_MS = DAY;
/** Timed tasks count as overdue this long after their due time. */
export const OVERDUE_AFTER_MS = HOUR;

export const KINDS = {
  assigned: "notify.task_assigned",
  reminder: "notify.task_reminder",
  overdue: "notify.task_overdue",
  digest: "notify.daily_digest",
  test: "notify.test_email",
} as const;

export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  reminder: string | null;
  priority?: string | null;
  assigned_to: string | null;
  assigned_by?: string | null;
  assignment_version?: number | null;
  deal_id?: string | null;
  contact_id?: string | null;
  notes?: string | null;
  workstream?: string | null;
  legacy_id?: string | null;
}

export interface Member {
  user_id: string;
  role: "owner" | "editor" | "viewer" | string;
  email: string | null;
  display_name: string | null;
  created_at?: string | null;
}

export interface Prefs {
  notify_task_assigned: boolean;
  notify_task_reminders: boolean;
  notify_task_overdue: boolean;
  notify_daily_digest: boolean;
  digest_hour: number;
  timezone: string | null;
}

/** No user_preferences row = these (the column defaults). */
export const DEFAULT_PREFS: Prefs = {
  notify_task_assigned: true,
  notify_task_reminders: true,
  notify_task_overdue: true,
  notify_daily_digest: false,
  digest_hour: 8,
  timezone: null,
};

export function prefsFrom(row: Partial<Prefs> | null | undefined): Prefs {
  const r = row || {};
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const hour = Number(r.digest_hour);
  return {
    notify_task_assigned: bool(r.notify_task_assigned, DEFAULT_PREFS.notify_task_assigned),
    notify_task_reminders: bool(r.notify_task_reminders, DEFAULT_PREFS.notify_task_reminders),
    notify_task_overdue: bool(r.notify_task_overdue, DEFAULT_PREFS.notify_task_overdue),
    notify_daily_digest: bool(r.notify_daily_digest, DEFAULT_PREFS.notify_daily_digest),
    digest_hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_PREFS.digest_hour,
    timezone: validTimeZone(r.timezone),
  };
}

/** The team's zone for naive due dates: settings.timezone, else the fallback, else UTC. */
export function workspaceTimeZone(settings: unknown, fallback?: string | null): string {
  const tz = settings && typeof settings === "object" ? (settings as Record<string, unknown>).timezone : null;
  return validTimeZone(tz) || validTimeZone(fallback) || "UTC";
}

/** A person's own zone: their preference, else the team's, else UTC. */
export function personTimeZone(prefs: Prefs, workspaceTz: string): string {
  return validTimeZone(prefs.timezone) || validTimeZone(workspaceTz) || "UTC";
}

export function ownerOf(members: Member[]): Member | null {
  const owners = members.filter((m) => m.role === "owner");
  owners.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return owners[0] || null;
}

/**
 * Who a reminder / overdue email for this task goes to: the assignee if they
 * are on the team, otherwise the owner (unassigned tasks, or an assignee who
 * was removed), exactly like the old function.
 */
export function taskRecipient(task: Pick<TaskRow, "assigned_to">, members: Member[]): { member: Member; asOwner: boolean } | null {
  if (task.assigned_to) {
    const m = members.find((x) => x.user_id === task.assigned_to);
    if (m) return { member: m, asOwner: false };
  }
  const owner = ownerOf(members);
  return owner ? { member: owner, asOwner: true } : null;
}

/** When the task is due, as an instant (date-only tasks: 00:00 that day, team time). */
export function dueInstant(task: Pick<TaskRow, "due_date" | "due_time">, workspaceTz: string): Date | null {
  const date = normalizeDate(task.due_date);
  if (!date) return null;
  return naiveLocalToUtc(date, normalizeTime(task.due_time), workspaceTz);
}

/** When the task's reminder goes off, or null (no due date, or "none"). */
export function reminderAt(task: Pick<TaskRow, "due_date" | "due_time" | "reminder">, workspaceTz: string): Date | null {
  const offset = REMINDER_OFFSETS_MS[task.reminder || "none"];
  if (offset === undefined) return null;
  const due = dueInstant(task, workspaceTz);
  return due ? new Date(due.getTime() - offset) : null;
}

/**
 * When the "overdue" email is due: 1 h after the due time, or for date-only
 * tasks the day after the due date at the recipient's digest hour in the
 * recipient's time zone.
 */
export function overdueAt(
  task: Pick<TaskRow, "due_date" | "due_time">,
  workspaceTz: string,
  recipientTz: string,
  digestHour: number,
): Date | null {
  const date = normalizeDate(task.due_date);
  if (!date) return null;
  const time = normalizeTime(task.due_time);
  if (time) return new Date(naiveLocalToUtc(date, time, workspaceTz).getTime() + OVERDUE_AFTER_MS);
  const hour = Number.isInteger(digestHour) && digestHour >= 0 && digestHour <= 23 ? digestHour : DEFAULT_PREFS.digest_hour;
  return naiveLocalToUtc(addDays(date, 1), `${String(hour).padStart(2, "0")}:00`, recipientTz);
}

/** Has the moment passed, and by less than a day? */
export function isDueNow(at: Date | null, now: Date): boolean {
  if (!at) return false;
  const late = now.getTime() - at.getTime();
  return late >= 0 && late < MAX_LATE_MS;
}

/** The digest hour window for a person today: [start, end) and their local date. */
export function digestWindow(now: Date, timeZone: string, digestHour: number): { localDate: string; start: Date; end: Date } {
  const localDate = localParts(now, timeZone).date;
  const start = naiveLocalToUtc(localDate, `${String(digestHour).padStart(2, "0")}:00`, timeZone);
  return { localDate, start, end: new Date(start.getTime() + HOUR) };
}

export const dedupeKeys = {
  assigned: (taskId: string, version: number) => `task_assigned:${taskId}:${version}`,
  reminder: (t: Pick<TaskRow, "id" | "due_date" | "due_time" | "reminder">) =>
    `task_reminder:${t.id}:${normalizeDate(t.due_date) || ""}:${normalizeTime(t.due_time)}:${t.reminder || "none"}`,
  overdue: (t: Pick<TaskRow, "id" | "due_date" | "due_time">) =>
    `task_overdue:${t.id}:${normalizeDate(t.due_date) || ""}:${normalizeTime(t.due_time)}`,
  digest: (userId: string, localDate: string) => `digest:${userId}:${localDate}`,
  /** One test email per person per calendar minute (UTC). */
  test: (userId: string, now: Date) => `test_email:${userId}:${now.toISOString().slice(0, 16)}`,
};

export interface PlannedJob {
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface PlanInput {
  now: Date;
  workspaceTz: string;
  tasks: TaskRow[];
  members: Member[];
  prefsByUser: Map<string, Prefs>;
}

const prefsOf = (input: PlanInput, userId: string) => input.prefsByUser.get(userId) || DEFAULT_PREFS;

/** Every reminder, overdue and digest email that should be queued at `now`. */
export function planNotifications(input: PlanInput): PlannedJob[] {
  const { now, workspaceTz } = input;
  const jobs: PlannedJob[] = [];
  for (const task of input.tasks) {
    if (task.status === "done" || !normalizeDate(task.due_date)) continue;
    const to = taskRecipient(task, input.members);
    if (!to) continue;
    const prefs = prefsOf(input, to.member.user_id);
    const dueDate = normalizeDate(task.due_date);
    const dueTime = normalizeTime(task.due_time);

    const remindAt = reminderAt(task, workspaceTz);
    if (prefs.notify_task_reminders && isDueNow(remindAt, now)) {
      jobs.push({
        kind: KINDS.reminder,
        dedupeKey: dedupeKeys.reminder(task),
        payload: {
          task_id: task.id,
          due_date: dueDate,
          due_time: dueTime,
          reminder: task.reminder,
          remind_at: remindAt!.toISOString(),
          recipient_id: to.member.user_id,
        },
      });
    }

    const lateAt = overdueAt(task, workspaceTz, personTimeZone(prefs, workspaceTz), prefs.digest_hour);
    if (prefs.notify_task_overdue && isDueNow(lateAt, now)) {
      jobs.push({
        kind: KINDS.overdue,
        dedupeKey: dedupeKeys.overdue(task),
        payload: { task_id: task.id, due_date: dueDate, due_time: dueTime, overdue_at: lateAt!.toISOString(), recipient_id: to.member.user_id },
      });
    }
  }

  for (const m of input.members) {
    const prefs = prefsOf(input, m.user_id);
    if (!prefs.notify_daily_digest) continue;
    const tz = personTimeZone(prefs, workspaceTz);
    const w = digestWindow(now, tz, prefs.digest_hour);
    if (now >= w.start && now < w.end) {
      jobs.push({
        kind: KINDS.digest,
        dedupeKey: dedupeKeys.digest(m.user_id, w.localDate),
        payload: { user_id: m.user_id, local_date: w.localDate, timezone: tz, digest_hour: prefs.digest_hour },
      });
    }
  }
  return jobs;
}

/** Due-date range (team dates) that can produce a reminder or overdue email around `now`. */
export function candidateDueDateRange(now: Date): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  return { from: addDays(today, -3), to: addDays(today, 2) };
}
