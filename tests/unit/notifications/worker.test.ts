import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { PermanentJobError, RetryJobLater, runJobs } from "../../../lib/server/jobs.js";
import { createNotificationJobHandlers, notificationJobHandlers, scheduleNotifications, NO_SENDER_REASON } from "../../../lib/server/notifications/worker.js";
import { KINDS } from "../../../lib/server/notifications/rules.js";
import { SMTP_SENDER, WS, baseTask, crm, fakeSend, jobRow } from "./fixtures.js";

const env = { ...process.env };
beforeEach(() => {
  process.env.APP_URL = "https://crm.example";
  for (const k of ["RESEND_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SMTP_HOST"]) delete process.env[k];
});
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

const NOW = new Date("2026-10-17T04:46:00Z"); // 09:46 in Karachi; t1 is due 10:00 with a 15 min reminder
function setup(over: Parameters<typeof crm>[0] = {}, opts: { now?: Date; fail?: Error; sender?: typeof SMTP_SENDER | null } = {}) {
  const db = crm(over);
  __setAdminClientForTests(db.client);
  const mail = fakeSend({ fail: opts.fail });
  const handlers = createNotificationJobHandlers({
    sender: () => (opts.sender === undefined ? SMTP_SENDER : opts.sender),
    send: mail.send,
    now: () => opts.now ?? NOW,
  });
  return { db, mail, handlers, ctx: { deadline: Date.now() + 60_000 } };
}

const assignedJob = (over: Record<string, unknown> = {}) =>
  jobRow(KINDS.assigned, { task_id: "t1", assignee_id: "ed", assigned_by: "owner", assignment_version: 1, ...over }, { dedupe_key: "task_assigned:t1:1" });
const reminderJob = (over: Record<string, unknown> = {}) =>
  jobRow(
    KINDS.reminder,
    { task_id: "t1", due_date: "2026-10-17", due_time: "10:00", reminder: "15_min", remind_at: "2026-10-17T04:45:00.000Z", recipient_id: "ed", ...over },
    { dedupe_key: "task_reminder:t1:2026-10-17:10:00:15_min" },
  );

describe("exports", () => {
  it("handles every notification kind, including the one the database queues", () => {
    expect(Object.keys(notificationJobHandlers).sort()).toEqual(
      ["notify.daily_digest", "notify.task_assigned", "notify.task_overdue", "notify.task_reminder", "notify.test_email"].sort(),
    );
  });
});

describe("scheduleNotifications", () => {
  it("does nothing without a sender", async () => {
    const { db } = setup();
    expect(await scheduleNotifications({ now: NOW }, { sender: () => null })).toEqual({ queued: 0, skipped: NO_SENDER_REASON });
    expect(db.rpcCalls).toEqual([]);
  });
  it("queues due reminders once, however often it runs", async () => {
    const { db } = setup();
    const first: any = await scheduleNotifications({ now: NOW }, { sender: () => SMTP_SENDER });
    expect(first).toMatchObject({ workspaces: 1, planned: 1, queued: 1, failed: 0 });
    expect(db.jobs()).toHaveLength(1);
    expect(db.jobs()[0]).toMatchObject({
      kind: KINDS.reminder,
      dedupe_key: "task_reminder:t1:2026-10-17:10:00:15_min",
      workspace_id: WS,
      status: "pending",
      payload: { task_id: "t1", recipient_id: "ed", reminder: "15_min" },
    });
    const rpcs = db.rpcCalls.length;
    const again: any = await scheduleNotifications({ now: new Date(NOW.getTime() + 60_000) }, { sender: () => SMTP_SENDER });
    expect(again).toMatchObject({ planned: 1, queued: 0 });
    expect(db.rpcCalls.length).toBe(rpcs); // already queued: not even an insert attempt
    expect(db.jobs()).toHaveLength(1);
  });
  it("a changed due time re-arms the reminder", async () => {
    const { db } = setup();
    await scheduleNotifications({ now: NOW }, { sender: () => SMTP_SENDER });
    db.tables.tasks[0].due_time = "10:30:00";
    await scheduleNotifications({ now: new Date("2026-10-17T05:16:00Z") }, { sender: () => SMTP_SENDER });
    expect(db.jobs().map((j) => j.dedupe_key)).toEqual(["task_reminder:t1:2026-10-17:10:00:15_min", "task_reminder:t1:2026-10-17:10:30:15_min"]);
  });
  it("only looks at open tasks near today", async () => {
    const { db } = setup({ tasks: [baseTask({ status: "done" }), baseTask({ id: "t2", due_date: "2026-09-01" })] });
    await scheduleNotifications({ now: NOW }, { sender: () => SMTP_SENDER });
    expect(db.jobs()).toEqual([]);
  });
  it("queues overdue emails and digests, respecting preferences", async () => {
    const { db } = setup({
      user_preferences: [
        { user_id: "ed", notify_daily_digest: true, digest_hour: 12, notify_task_reminders: false },
        { user_id: "vi", notify_daily_digest: true, digest_hour: 12, timezone: "Europe/Berlin" },
      ],
    });
    await scheduleNotifications({ now: new Date("2026-10-17T07:05:00Z") }, { sender: () => SMTP_SENDER }); // 12:05 Karachi
    expect(db.jobs().map((j) => j.dedupe_key).sort()).toEqual(["digest:ed:2026-10-17", "task_overdue:t1:2026-10-17:10:00"]);
  });
  it("keeps going when one enqueue fails", async () => {
    const { db } = setup({ tasks: [baseTask(), baseTask({ id: "t2" })] });
    const rpc = db.client.rpc;
    let n = 0;
    db.client.rpc = async (name: string, args: any) => (name === "enqueue_job" && n++ === 0 ? { data: null, error: { message: "boom" } } : rpc(name, args));
    const out: any = await scheduleNotifications({ now: NOW }, { sender: () => SMTP_SENDER });
    expect(out).toMatchObject({ planned: 2, queued: 1, failed: 1 });
  });
});

describe("notify.task_assigned", () => {
  it("emails the assignee with the task, lead, deal and links, and records a receipt at once", async () => {
    const { db, mail, handlers, ctx } = setup({ job_queue: [assignedJob()] });
    const out: any = await handlers[KINDS.assigned](db.jobs()[0] as any, ctx);
    expect(out.status).toBe("done");
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m.to).toBe("editor@crm.test");
    expect(m.subject).toBe("Assigned to you: Send <samples> & pricing");
    expect(m.idempotencyKey).toBe("task_assigned:t1:1");
    expect(m.html).toContain("Olivia Owner assigned you a task");
    expect(m.html).toContain("Send &lt;samples&gt; &amp; pricing");
    expect(m.html).not.toContain("<samples>");
    expect(m.html).toContain('href="https://crm.example/?task=t1"');
    expect(m.html).toContain('href="https://crm.example/?contact=c1"'); // the deal's main contact
    expect(m.html).toContain("Maya Rivera");
    expect(m.html).toContain("Cedar &amp; Crumb");
    expect(m.html).toContain("Wholesale packaging");
    expect(m.html).toContain("Sat 17 Oct 2026, 10:00 AM (Karachi time)");
    expect(m.text).toContain("Open task: https://crm.example/?task=t1");
    expect(m.text).toContain("Change your notification settings: https://crm.example/#profile");
    // The receipt is in the job row before runJobs marks it done.
    expect(db.jobs()[0].result).toMatchObject({ provider: "smtp", recipient_id: "ed", to: "ed***@crm.test", subject: m.subject, task_id: "t1" });
    expect(out.result.sent_at).toBeTruthy();
  });
  it("a failed receipt write after a successful send doesn't turn into a retry (and a resend)", async () => {
    const { db, mail, handlers, ctx } = setup({ job_queue: [assignedJob()] });
    db.failTable.add("job_queue");
    const out: any = await handlers[KINDS.assigned](assignedJob(), ctx);
    expect(out.status).toBe("done");
    expect(mail.sent).toHaveLength(1);
  });
  it("a re-run after a crash doesn't send again", async () => {
    const { db, mail, handlers, ctx } = setup({ job_queue: [assignedJob()] });
    await handlers[KINDS.assigned](db.jobs()[0] as any, ctx);
    const again: any = await handlers[KINDS.assigned](db.jobs()[0] as any, ctx); // row now carries the receipt
    expect(again.status).toBe("done");
    expect(mail.sent).toHaveLength(1);
  });
  const skipped = async (over: Parameters<typeof crm>[0], job = assignedJob(), opts: Parameters<typeof setup>[1] = {}) => {
    const { mail, handlers, ctx } = setup(over, opts);
    const out: any = await handlers[KINDS.assigned](job, ctx);
    expect(mail.sent).toHaveLength(0);
    expect(out.status).toBe("skipped");
    return out.result.reason as string;
  };
  it("skips when it no longer applies", async () => {
    expect(await skipped({ tasks: [] })).toMatch(/deleted/);
    expect(await skipped({ tasks: [baseTask({ status: "done" })] })).toMatch(/done/);
    expect(await skipped({ tasks: [baseTask({ assigned_to: "vi", assignment_version: 2 })] })).toMatch(/reassigned/);
    expect(await skipped({ tasks: [baseTask({ assignment_version: 3 })] })).toMatch(/reassigned/); // reassigned away and back
    expect(await skipped({ user_preferences: [{ user_id: "ed", notify_task_assigned: false }] })).toMatch(/switched off/);
    expect(
      await skipped({
        workspace_members: [{ workspace_id: WS, user_id: "owner", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
      }),
    ).toMatch(/no longer on the team/);
    expect(await skipped({ profiles: [{ id: "ed", email: null, display_name: "Eddie" }] })).toMatch(/no email/);
    expect(await skipped({}, assignedJob({ assigned_by: "ed" }))).toMatch(/themselves/);
    expect(await skipped({}, assignedJob(), { sender: null })).toBe(NO_SENDER_REASON);
  });
  it("rejects a malformed job for good", async () => {
    const { handlers, ctx } = setup();
    await expect(handlers[KINDS.assigned](jobRow(KINDS.assigned, { task_id: "t1" }), ctx)).rejects.toBeInstanceOf(PermanentJobError);
  });
  it("without a known assigner it still reads naturally", async () => {
    const { mail, handlers, ctx } = setup({ tasks: [baseTask({ assigned_by: null })] });
    await handlers[KINDS.assigned](assignedJob({ assigned_by: null }), ctx);
    expect(mail.sent[0].html).toContain("You have a new task");
  });
});

describe("notify.task_reminder", () => {
  it("sends 'Due in 15 min' to the assignee", async () => {
    const { mail, handlers, ctx } = setup();
    const out: any = await handlers[KINDS.reminder](reminderJob(), ctx);
    expect(out.status).toBe("done");
    expect(mail.sent[0].subject).toBe("Due in 14 min: Send <samples> & pricing");
    expect(mail.sent[0].to).toBe("editor@crm.test");
    expect(mail.sent[0].html).toContain("Assigned to you by Olivia Owner");
    expect(mail.sent[0].html).toContain("Bring the matte finish.<br><br>Ask about &lt;Q4&gt; budget");
  });
  it("unassigned tasks go to the owner, who is told why", async () => {
    const { mail, handlers, ctx } = setup({ tasks: [baseTask({ assigned_to: null, assigned_by: null, assignment_version: 0 })] });
    await handlers[KINDS.reminder](reminderJob({ recipient_id: "owner" }), ctx);
    expect(mail.sent[0].to).toBe("owner@crm.test");
    expect(mail.sent[0].html).toContain("Unassigned, so it comes to you as the CRM owner");
  });
  it("shows times in the recipient's own zone, with the team time", async () => {
    const { mail, handlers, ctx } = setup({ user_preferences: [{ user_id: "ed", timezone: "Asia/Dubai" }] });
    await handlers[KINDS.reminder](reminderJob(), ctx);
    expect(mail.sent[0].html).toContain("Sat 17 Oct 2026, 9:00 AM (Dubai time) · 10:00 AM Karachi time");
  });
  const outcome = async (over: Parameters<typeof crm>[0], job = reminderJob(), now = NOW) => {
    const { mail, handlers, ctx } = setup(over, { now });
    const out: any = await handlers[KINDS.reminder](job, ctx);
    return { out, sent: mail.sent.length };
  };
  it("skips stale reminders", async () => {
    for (const [over, reason] of [
      [{ tasks: [] }, /deleted/],
      [{ tasks: [baseTask({ status: "done" })] }, /done/],
      [{ tasks: [baseTask({ due_time: "11:00:00" })] }, /changed/],
      [{ tasks: [baseTask({ due_date: "2026-10-18" })] }, /changed/],
      [{ tasks: [baseTask({ reminder: "1_hour" })] }, /changed/],
      [{ user_preferences: [{ user_id: "ed", notify_task_reminders: false }] }, /switched off/],
    ] as const) {
      const { out, sent } = await outcome(over as any);
      expect(sent).toBe(0);
      expect(out).toMatchObject({ status: "skipped", result: { reason: expect.stringMatching(reason) } });
    }
  });
  it("follows the task to whoever is responsible when it is sent", async () => {
    // Reassigned between queueing and sending: the reminder belongs to the
    // task's due time, so the new assignee gets it (the dedupe key has no
    // recipient, so skipping would lose it). Their preferences decide.
    let r = await outcome({ tasks: [baseTask({ assigned_to: "vi", assignment_version: 2 })] });
    expect(r.out.result.recipient_id).toBe("vi");
    r = await outcome({ tasks: [baseTask({ assigned_to: "vi", assignment_version: 2 })], user_preferences: [{ user_id: "vi", notify_task_reminders: false }] });
    expect(r.out.status).toBe("skipped");
  });
  it("drops reminders more than a day late", async () => {
    const { out, sent } = await outcome({}, reminderJob(), new Date("2026-10-18T04:45:00Z"));
    expect(sent).toBe(0);
    expect(out.result.reason).toMatch(/more than a day late/);
  });
  it("waits if the team's time zone moved the reminder later", async () => {
    const { handlers, ctx } = setup({ workspaces: [{ id: WS, name: "B", status: "active", settings: { timezone: "Europe/London" } }] });
    await expect(handlers[KINDS.reminder](reminderJob(), ctx)).rejects.toBeInstanceOf(RetryJobLater);
  });
  it("doesn't repeat a reminder the old system already emailed (cutover)", async () => {
    const { out, sent } = await outcome({
      tasks: [baseTask({ legacy_id: "b42" })],
      sent_task_emails: [{ key: `${WS}|b42|2026-10-17|10:00|15_min`, workspace_id: WS, task_id: "b42" }],
    });
    expect(sent).toBe(0);
    expect(out.result.reason).toMatch(/previous reminder system/);
    const older = await outcome({ tasks: [baseTask({ legacy_id: "b42" })], sent_task_emails: [{ key: `${WS}|b42|2026-10-17|10:00` }] });
    expect(older.sent).toBe(0);
    const other = await outcome({ tasks: [baseTask({ legacy_id: "b42" })], sent_task_emails: [{ key: `${WS}|b42|2026-10-16|10:00|15_min` }] });
    expect(other.sent).toBe(1);
  });
  it("date-only tasks say 'Due tomorrow' / 'Due today'", async () => {
    const t = baseTask({ due_time: null, reminder: "1_day" });
    const { mail, handlers, ctx } = setup({ tasks: [t] }, { now: new Date("2026-10-15T19:01:00Z") }); // 00:01 on the 16th, Karachi
    await handlers[KINDS.reminder](reminderJob({ due_time: "", reminder: "1_day" }), ctx);
    expect(mail.sent[0].subject).toBe("Due tomorrow: Send <samples> & pricing");
    expect(mail.sent[0].html).toContain("Sat 17 Oct 2026");
  });
});

describe("notify.task_overdue", () => {
  const overdueJob = () =>
    jobRow(KINDS.overdue, { task_id: "t1", due_date: "2026-10-17", due_time: "10:00", overdue_at: "2026-10-17T06:00:00.000Z", recipient_id: "ed" });
  it("sends one 'Overdue' email", async () => {
    const { mail, handlers, ctx } = setup({}, { now: new Date("2026-10-17T06:00:30Z") });
    const out: any = await handlers[KINDS.overdue](overdueJob(), ctx);
    expect(out.status).toBe("done");
    expect(mail.sent[0].subject).toBe("Overdue: Send <samples> & pricing");
    expect(mail.sent[0].text).toContain("This task was due Sat 17 Oct, 10:00 AM and is still open.");
  });
  it("skips when done, moved or switched off", async () => {
    for (const over of <Record<string, Record<string, unknown>[]>[]>[
      { tasks: [baseTask({ status: "done" })] },
      { tasks: [baseTask({ due_date: "2026-10-20" })] },
      { user_preferences: [{ user_id: "ed", notify_task_overdue: false }] },
    ]) {
      const { mail, handlers, ctx } = setup(over, { now: new Date("2026-10-17T06:00:30Z") });
      const out: any = await handlers[KINDS.overdue](overdueJob(), ctx);
      expect(out.status).toBe("skipped");
      expect(mail.sent).toHaveLength(0);
    }
  });
});

describe("notify.daily_digest", () => {
  const digestJob = (date = "2026-10-17") => jobRow(KINDS.digest, { user_id: "ed", local_date: date, timezone: "Asia/Karachi", digest_hour: 8 });
  const tasks = [
    baseTask({ id: "late", title: "Late one", due_date: "2026-10-15", due_time: null, deal_id: null, contact_id: "c1" }),
    baseTask({ id: "today", title: "Today's call", due_date: "2026-10-17", due_time: "15:00:00" }),
    baseTask({ id: "soon", title: "Next week", due_date: "2026-10-22", due_time: null, deal_id: null }),
    baseTask({ id: "far", title: "Far away", due_date: "2026-11-30", due_time: null }),
    baseTask({ id: "done", title: "Finished", due_date: "2026-10-17", status: "done" }),
    baseTask({ id: "theirs", title: "Someone else's", due_date: "2026-10-17", assigned_to: "vi" }),
  ];
  const on = [{ user_id: "ed", notify_daily_digest: true }];
  it("lists overdue, due today and the next 7 days for the person's own tasks", async () => {
    const { mail, handlers, ctx } = setup({ tasks, user_preferences: on }, { now: new Date("2026-10-17T03:00:00Z") });
    const out: any = await handlers[KINDS.digest](digestJob(), ctx);
    expect(out.status).toBe("done");
    expect(out.result.counts).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    const m = mail.sent[0];
    expect(m.subject).toBe("Your tasks for Sat 17 Oct: 1 overdue, 1 due today, 1 in the next 7 days");
    expect(m.text).toContain("Late one (Was due Thu 15 Oct · Maya Rivera)");
    expect(m.text).toContain("Today's call (Today, 3:00 PM · Maya Rivera · Wholesale packaging)");
    expect(m.text).toContain("Next week (Thu 22 Oct)");
    expect(m.text).not.toMatch(/Far away|Finished|Someone else/);
    expect(m.html).toContain('href="https://crm.example/?task=today"');
  });
  it("skips when there is nothing to say, when switched off, or on another day", async () => {
    let s = setup({ tasks: [], user_preferences: on }, { now: new Date("2026-10-17T03:00:00Z") });
    expect(((await s.handlers[KINDS.digest](digestJob(), s.ctx)) as any).result.reason).toMatch(/Nothing/);
    s = setup({ tasks }, { now: new Date("2026-10-17T03:00:00Z") });
    expect(((await s.handlers[KINDS.digest](digestJob(), s.ctx)) as any).result.reason).toMatch(/switched off/);
    s = setup({ tasks, user_preferences: on }, { now: new Date("2026-10-18T03:00:00Z") });
    expect(((await s.handlers[KINDS.digest](digestJob(), s.ctx)) as any).result.reason).toMatch(/another day/);
    expect(s.mail.sent).toHaveLength(0);
  });
});

describe("through the real job runner", () => {
  it("ends every job as done or skipped, with what was sent in the result", async () => {
    const { db, mail } = setup({
      job_queue: [
        { ...assignedJob(), id: 1, status: "pending", attempts: 0, run_after: "2026-01-01T00:00:00Z" },
        { ...reminderJob(), id: 2, status: "pending", attempts: 0, run_after: "2026-01-01T00:00:00Z", dedupe_key: "r" },
        { ...assignedJob({ task_id: "gone" }), id: 3, status: "pending", attempts: 0, run_after: "2026-01-01T00:00:00Z", dedupe_key: "g" },
      ],
    });
    const handlers = createNotificationJobHandlers({ sender: () => SMTP_SENDER, send: mail.send, now: () => NOW });
    const summary = await runJobs(handlers, { deadline: Date.now() + 30_000 });
    expect(summary).toMatchObject({ claimed: 3, done: 2, skipped: 1, retried: 0, dead: 0 });
    const byId = Object.fromEntries(db.jobs().map((j) => [j.id, j]));
    expect(byId[1]).toMatchObject({ status: "done", result: { subject: "Assigned to you: Send <samples> & pricing" } });
    expect(byId[3]).toMatchObject({ status: "skipped", result: { reason: "The task was deleted" } });
    expect(mail.sent).toHaveLength(2);
  });
  it("a refused login ends the job dead once instead of retrying forever", async () => {
    const { db } = setup({ job_queue: [{ ...assignedJob(), status: "pending", attempts: 0, run_after: "2026-01-01T00:00:00Z" }] });
    const handlers = createNotificationJobHandlers({
      sender: () => SMTP_SENDER,
      send: async () => {
        throw new PermanentJobError("The mail server rejected the login");
      },
      now: () => NOW,
    });
    expect(await runJobs(handlers, { deadline: Date.now() + 30_000 })).toMatchObject({ dead: 1 });
    expect(db.jobs()[0]).toMatchObject({ status: "dead", last_error: "The mail server rejected the login" });
  });
  it("without a sender, queued jobs are skipped (no retry storm)", async () => {
    const { db } = setup({ job_queue: [{ ...assignedJob(), status: "pending", attempts: 0, run_after: "2026-01-01T00:00:00Z" }] });
    const handlers = createNotificationJobHandlers({ sender: () => null, now: () => NOW });
    expect(await runJobs(handlers, { deadline: Date.now() + 30_000 })).toMatchObject({ skipped: 1, retried: 0 });
    expect(db.jobs()[0]).toMatchObject({ status: "skipped", result: { reason: NO_SENDER_REASON } });
  });
  it("a test-email row left behind by a dead request is closed without sending", async () => {
    const { mail, handlers, ctx } = setup();
    const out: any = await handlers[KINDS.test](jobRow(KINDS.test, { user_id: "ed" }), ctx);
    expect(out.status).toBe("skipped");
    expect(mail.sent).toHaveLength(0);
  });
});

describe("daily ceiling", () => {
  it("stops sending notification emails once the CRM reached its daily limit", async () => {
    process.env.NOTIFICATION_MAX_PER_DAY = "2";
    const recent = new Date().toISOString();
    const sent = (id: number) => ({ ...jobRow(KINDS.reminder, {}, { dedupe_key: `old:${id}` }), id: 900 + id, status: "done", finished_at: recent });
    const { db, mail, handlers, ctx } = setup({ job_queue: [assignedJob(), sent(1), sent(2)] });
    const out: any = await handlers[KINDS.assigned](db.jobs()[0] as any, ctx);
    expect(out).toMatchObject({ status: "skipped", result: { reason: expect.stringContaining("daily limit") } });
    expect(mail.sent).toHaveLength(0);

    process.env.NOTIFICATION_MAX_PER_DAY = "3";
    const again: any = await handlers[KINDS.assigned](db.jobs()[0] as any, ctx);
    expect(again.status).toBe("done");
    expect(mail.sent).toHaveLength(1);
  });
});
