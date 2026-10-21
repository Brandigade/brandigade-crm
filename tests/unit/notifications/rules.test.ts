import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  KINDS,
  candidateDueDateRange,
  dedupeKeys,
  digestWindow,
  isDueNow,
  overdueAt,
  personTimeZone,
  planNotifications,
  prefsFrom,
  reminderAt,
  taskRecipient,
  workspaceTimeZone,
  type Member,
  type Prefs,
  type TaskRow,
} from "../../../lib/server/notifications/rules.js";

const TZ = "Asia/Karachi"; // UTC+5, no DST
const owner: Member = { user_id: "owner", role: "owner", email: "o@x.co", display_name: "Olivia", created_at: "2026-01-01" };
const editor: Member = { user_id: "ed", role: "editor", email: "e@x.co", display_name: "Eddie", created_at: "2026-01-02" };
const viewer: Member = { user_id: "vi", role: "viewer", email: "v@x.co", display_name: "Vera", created_at: "2026-01-03" };
const members = [editor, owner, viewer];

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  workspace_id: "ws1",
  title: "Call Maya",
  status: "todo",
  due_date: "2026-10-17",
  due_time: "10:00:00",
  reminder: "at_due",
  assigned_to: "ed",
  ...over,
});
const at = (iso: string) => new Date(iso);
const plan = (tasks: TaskRow[], now: string, prefs: Record<string, Partial<Prefs>> = {}) =>
  planNotifications({
    now: at(now),
    workspaceTz: TZ,
    tasks,
    members,
    prefsByUser: new Map(Object.entries(prefs).map(([k, v]) => [k, prefsFrom(v)])),
  });

describe("reminder offsets", () => {
  it("matches the app's reminder menu", () => {
    // due 10:00 Karachi = 05:00 UTC
    expect(reminderAt(task({ reminder: "at_due" }), TZ)!.toISOString()).toBe("2026-10-17T05:00:00.000Z");
    expect(reminderAt(task({ reminder: "15_min" }), TZ)!.toISOString()).toBe("2026-10-17T04:45:00.000Z");
    expect(reminderAt(task({ reminder: "1_hour" }), TZ)!.toISOString()).toBe("2026-10-17T04:00:00.000Z");
    expect(reminderAt(task({ reminder: "1_day" }), TZ)!.toISOString()).toBe("2026-10-16T05:00:00.000Z");
    expect(reminderAt(task({ reminder: "none" }), TZ)).toBeNull();
    expect(reminderAt(task({ reminder: "weird" }), TZ)).toBeNull();
    expect(reminderAt(task({ due_date: null }), TZ)).toBeNull();
  });
  it("date-only tasks remind from 00:00 of the due date (team time)", () => {
    expect(reminderAt(task({ due_time: null }), TZ)!.toISOString()).toBe("2026-10-16T19:00:00.000Z");
    expect(reminderAt(task({ due_time: null, reminder: "1_day" }), TZ)!.toISOString()).toBe("2026-10-15T19:00:00.000Z");
  });
  it("only fires once the moment passed and while less than a day late", () => {
    const r = at("2026-10-17T05:00:00Z");
    expect(isDueNow(r, at("2026-10-17T04:59:59Z"))).toBe(false);
    expect(isDueNow(r, at("2026-10-17T05:00:00Z"))).toBe(true);
    expect(isDueNow(r, at("2026-10-18T04:59:59Z"))).toBe(true);
    expect(isDueNow(r, at("2026-10-18T05:00:00Z"))).toBe(false);
    expect(isDueNow(null, at("2026-10-18T05:00:00Z"))).toBe(false);
  });
  it("follows the team's daylight-saving time", () => {
    // 09:00 in New York on the day clocks change is 13:00 UTC (EDT), not 14:00.
    expect(reminderAt(task({ due_date: "2026-03-08", due_time: "09:00", reminder: "15_min" }), "America/New_York")!.toISOString()).toBe(
      "2026-03-08T12:45:00.000Z",
    );
  });
});

describe("overdue timing", () => {
  it("timed tasks: one hour after the due time", () => {
    expect(overdueAt(task(), TZ, TZ, 8)!.toISOString()).toBe("2026-10-17T06:00:00.000Z");
  });
  it("date-only tasks: next day at the recipient's digest hour in their own zone", () => {
    expect(overdueAt(task({ due_time: null }), TZ, TZ, 8)!.toISOString()).toBe("2026-10-18T03:00:00.000Z"); // 08:00 Karachi
    expect(overdueAt(task({ due_time: null }), TZ, "Europe/London", 9)!.toISOString()).toBe("2026-10-18T08:00:00.000Z"); // 09:00 BST
    expect(overdueAt(task({ due_time: null }), TZ, "Europe/London", 0)!.toISOString()).toBe("2026-10-17T23:00:00.000Z");
    // Day after the DST change in Europe: 26 Oct 2026 08:00 is GMT again.
    expect(overdueAt(task({ due_date: "2026-10-25", due_time: null }), TZ, "Europe/London", 8)!.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });
  it("is planned within 24 h of that moment only, once per due date + time", () => {
    const due = task({ reminder: "none" });
    expect(plan([due], "2026-10-17T05:59:00Z").filter((j) => j.kind === KINDS.overdue)).toHaveLength(0);
    const jobs = plan([due], "2026-10-17T06:00:00Z").filter((j) => j.kind === KINDS.overdue);
    expect(jobs).toEqual([
      {
        kind: KINDS.overdue,
        dedupeKey: "task_overdue:t1:2026-10-17:10:00",
        payload: { task_id: "t1", due_date: "2026-10-17", due_time: "10:00", overdue_at: "2026-10-17T06:00:00.000Z", recipient_id: "ed" },
      },
    ]);
    expect(plan([due], "2026-10-18T06:00:00Z").filter((j) => j.kind === KINDS.overdue)).toHaveLength(0);
    expect(plan([{ ...due, status: "done" }], "2026-10-17T07:00:00Z")).toHaveLength(0);
  });
  it("uses the recipient's digest hour for date-only tasks", () => {
    const due = task({ due_time: null, reminder: "none" });
    expect(plan([due], "2026-10-18T03:30:00Z", { ed: { digest_hour: 9 } })).toHaveLength(0); // 08:30 Karachi < 09:00
    expect(plan([due], "2026-10-18T04:00:00Z", { ed: { digest_hour: 9 } }).map((j) => j.dedupeKey)).toEqual(["task_overdue:t1:2026-10-17:"]);
  });
});

describe("planning", () => {
  it("queues the reminder with the old dedupe shape: task + due date + due time + reminder", () => {
    const jobs = plan([task({ reminder: "15_min" })], "2026-10-17T04:46:00Z");
    expect(jobs).toEqual([
      {
        kind: KINDS.reminder,
        dedupeKey: "task_reminder:t1:2026-10-17:10:00:15_min",
        payload: { task_id: "t1", due_date: "2026-10-17", due_time: "10:00", reminder: "15_min", remind_at: "2026-10-17T04:45:00.000Z", recipient_id: "ed" },
      },
    ]);
  });
  it("dedupe keys are stable and change when the due date, time or reminder changes", () => {
    const k = dedupeKeys.reminder(task());
    expect(k).toBe(dedupeKeys.reminder(task({ due_time: "10:00" }))); // "10:00:00" from Postgres = "10:00" from the browser
    expect(k).not.toBe(dedupeKeys.reminder(task({ due_time: "10:30" })));
    expect(k).not.toBe(dedupeKeys.reminder(task({ due_date: "2026-10-18" })));
    expect(k).not.toBe(dedupeKeys.reminder(task({ reminder: "1_hour" })));
    expect(dedupeKeys.reminder(task({ due_time: null }))).toBe("task_reminder:t1:2026-10-17::at_due");
    expect(dedupeKeys.overdue(task())).toBe("task_overdue:t1:2026-10-17:10:00");
    expect(dedupeKeys.digest("ed", "2026-10-17")).toBe("digest:ed:2026-10-17");
    expect(dedupeKeys.assigned("t1", 3)).toBe("task_assigned:t1:3");
    expect(dedupeKeys.test("ed", at("2026-10-17T05:00:59.900Z"))).toBe(dedupeKeys.test("ed", at("2026-10-17T05:00:00Z")));
    expect(dedupeKeys.test("ed", at("2026-10-17T05:01:00Z"))).toBe("test_email:ed:2026-10-17T05:01");
  });
  it("unassigned tasks (and tasks of people who left) go to the owner", () => {
    expect(taskRecipient({ assigned_to: null }, members)).toEqual({ member: owner, asOwner: true });
    expect(taskRecipient({ assigned_to: "gone" }, members)).toEqual({ member: owner, asOwner: true });
    expect(taskRecipient({ assigned_to: "vi" }, members)).toEqual({ member: viewer, asOwner: false });
    expect(taskRecipient({ assigned_to: null }, [editor])).toBeNull();
    const jobs = plan([task({ assigned_to: null })], "2026-10-17T05:00:30Z");
    expect(jobs.map((j) => j.payload.recipient_id)).toEqual(["owner"]);
  });
  it("respects each person's preferences", () => {
    const t = task({ reminder: "at_due" });
    expect(plan([t], "2026-10-17T06:00:00Z").map((j) => j.kind).sort()).toEqual([KINDS.overdue, KINDS.reminder]);
    expect(plan([t], "2026-10-17T06:00:00Z", { ed: { notify_task_reminders: false } }).map((j) => j.kind)).toEqual([KINDS.overdue]);
    expect(plan([t], "2026-10-17T06:00:00Z", { ed: { notify_task_overdue: false } }).map((j) => j.kind)).toEqual([KINDS.reminder]);
    // The owner's preferences decide for unassigned tasks.
    expect(plan([task({ assigned_to: null })], "2026-10-17T06:00:00Z", { owner: { notify_task_reminders: false, notify_task_overdue: false } })).toEqual([]);
  });
  it("skips done tasks, tasks without a due date and reminders set to none", () => {
    expect(plan([task({ status: "done" })], "2026-10-17T05:00:30Z")).toEqual([]);
    expect(plan([task({ due_date: null })], "2026-10-17T05:00:30Z")).toEqual([]);
    expect(plan([task({ reminder: "none" })], "2026-10-17T05:00:30Z")).toEqual([]);
  });
  it("candidate due dates cover every zone", () => {
    expect(candidateDueDateRange(at("2026-10-17T12:00:00Z"))).toEqual({ from: "2026-10-14", to: "2026-10-19" });
  });
});

describe("daily digest timing", () => {
  it("is due during each person's digest hour in their own zone", () => {
    const prefs = { ed: { notify_daily_digest: true }, vi: { notify_daily_digest: true, digest_hour: 7, timezone: "Europe/Berlin" } };
    // 03:00 UTC = 08:00 Karachi (Eddie, team zone) = 05:00 Berlin (Vera)
    let jobs = plan([], "2026-10-17T03:00:00Z", prefs);
    expect(jobs).toEqual([
      { kind: KINDS.digest, dedupeKey: "digest:ed:2026-10-17", payload: { user_id: "ed", local_date: "2026-10-17", timezone: TZ, digest_hour: 8 } },
    ]);
    expect(plan([], "2026-10-17T03:59:59Z", prefs).map((j) => j.dedupeKey)).toEqual(["digest:ed:2026-10-17"]);
    expect(plan([], "2026-10-17T04:00:00Z", prefs)).toEqual([]);
    // 05:00 UTC = 07:00 Berlin (CEST)
    jobs = plan([], "2026-10-17T05:10:00Z", prefs);
    expect(jobs.map((j) => j.dedupeKey)).toEqual(["digest:vi:2026-10-17"]);
    // After the clocks change (CET) 07:00 Berlin is 06:00 UTC.
    expect(plan([], "2026-10-26T06:10:00Z", prefs).map((j) => j.dedupeKey)).toEqual(["digest:vi:2026-10-26"]);
  });
  it("is off by default", () => {
    expect(DEFAULT_PREFS.notify_daily_digest).toBe(false);
    expect(plan([], "2026-10-17T03:00:00Z")).toEqual([]);
  });
  it("uses the local date for the key", () => {
    const w = digestWindow(at("2026-10-17T19:30:00Z"), TZ, 0); // 00:30 on the 18th in Karachi
    expect(w.localDate).toBe("2026-10-18");
    expect(w.start.toISOString()).toBe("2026-10-17T19:00:00.000Z");
  });
  it("a digest hour inside a DST gap moves forward instead of being lost", () => {
    // Berlin 29 Mar 2026: 02:00 doesn't exist, the digest goes at 03:00 CEST (01:00 UTC).
    const w = digestWindow(at("2026-03-29T01:20:00Z"), "Europe/Berlin", 2);
    expect(w.start.toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("preferences and zones", () => {
  it("fills in defaults and validates", () => {
    expect(prefsFrom(null)).toEqual(DEFAULT_PREFS);
    expect(prefsFrom({ digest_hour: 30 as any, timezone: "Nope/Nope" })).toMatchObject({ digest_hour: 8, timezone: null });
    expect(prefsFrom({ notify_task_assigned: false, digest_hour: 0, timezone: "Asia/Dubai" })).toMatchObject({
      notify_task_assigned: false,
      digest_hour: 0,
      timezone: "Asia/Dubai",
    });
  });
  it("person zone: own preference, else the team's, else UTC", () => {
    expect(personTimeZone(prefsFrom({ timezone: "Asia/Dubai" }), TZ)).toBe("Asia/Dubai");
    expect(personTimeZone(prefsFrom(null), TZ)).toBe(TZ);
    expect(workspaceTimeZone({ timezone: "Bad/Zone" })).toBe("UTC");
    expect(workspaceTimeZone({}, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(workspaceTimeZone(null)).toBe("UTC");
  });
});
