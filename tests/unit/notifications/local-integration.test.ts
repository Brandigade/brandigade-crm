// End to end against the LOCAL Supabase stack and Mailpit (see
// docs/ARCHITECTURE.md §8): a task assigned by the owner to the editor is
// queued by the database trigger, the real handler sends it over SMTP to
// Mailpit, and running the job again (as after a crash) sends nothing more.
// The reminder path is checked the same way. Everything this test creates is
// prefixed "NOTIFTEST" and removed afterwards; it never runs the scheduler or
// claims jobs, so other people's queued jobs in the shared database are left
// alone. Skipped automatically when the local stack or Mailpit isn't running
// (CI).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS helper shared with the scripts
import { parseEnv } from "../../../scripts/env.mjs";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { enqueueJob } from "../../../lib/server/jobs.js";
import { notificationJobHandlers } from "../../../lib/server/notifications/worker.js";
import { loadWorkspaceContext } from "../../../lib/server/notifications/data.js";
import { KINDS, planNotifications, type TaskRow } from "../../../lib/server/notifications/rules.js";
import { localParts } from "../../../lib/server/notifications/time.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = path.join(root, ".env.local");
const local: Record<string, string> = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
const SB_URL = local.SUPABASE_URL || "";
const MAILPIT = (process.env.MAILPIT_URL || "http://127.0.0.1:57324").replace(/\/+$/, "");
const users = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/local-users.json"), "utf8"));

async function stackIsUp(): Promise<boolean> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SB_URL) || !local.SUPABASE_SERVICE_ROLE_KEY || !local.SUPABASE_ANON_KEY) return false;
  try {
    const [sb, mp] = await Promise.all([
      fetch(`${SB_URL}/auth/v1/health`, { headers: { apikey: local.SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(2000) }),
      fetch(`${MAILPIT}/api/v1/info`, { signal: AbortSignal.timeout(2000) }),
    ]);
    return sb.ok && mp.ok;
  } catch {
    return false;
  }
}
const available = await stackIsUp();

const TAG = `NOTIFTEST ${Date.now().toString(36)}`;
const savedEnv = { ...process.env };
let admin: SupabaseClient;
let ownerDb: SupabaseClient;
let workspaceId = "";
let ownerId = "";
let editorId = "";
let editorPrefs: Record<string, unknown> | null = null;
const taskIds: string[] = [];

async function mailpitSearch(query: string): Promise<{ ID: string; Subject: string; MessageID: string }[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=50`);
  const body = (await res.json()) as { messages?: { ID: string; Subject: string; MessageID: string }[] };
  return body.messages || [];
}
async function waitForMail(query: string, count: number) {
  for (let i = 0; i < 40; i++) {
    const found = await mailpitSearch(query);
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return mailpitSearch(query);
}
const ctx = () => ({ deadline: Date.now() + 60_000 });

describe.skipIf(!available)("against the local Supabase stack and Mailpit", () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      SUPABASE_URL: SB_URL,
      SUPABASE_ANON_KEY: local.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SUPABASE_SERVICE_ROLE_KEY,
      SMTP_HOST: local.SMTP_HOST || "127.0.0.1",
      SMTP_PORT: local.SMTP_PORT || "57325",
      NOTIFICATION_FROM_EMAIL: "Brandigade CRM <crm@crm.test>",
      APP_URL: "http://localhost:3102",
    });
    for (const k of ["RESEND_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"]) delete process.env[k];
    __setAdminClientForTests(null);
    admin = createClient(SB_URL, local.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    ownerDb = createClient(SB_URL, local.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: session, error } = await ownerDb.auth.signInWithPassword({ email: users.owner.email, password: users.owner.password });
    if (error || !session.user) throw error || new Error("owner sign-in failed (run npm run seed:local)");
    ownerId = session.user.id;
    const { data: editor } = await admin.from("profiles").select("id").eq("email", users.editor.email).single();
    editorId = editor!.id;
    const { data: m } = await admin.from("workspace_members").select("workspace_id").eq("user_id", ownerId).limit(1).single();
    workspaceId = m!.workspace_id;
    // Make sure the editor wants these emails; put their row back afterwards.
    const { data: prefs } = await admin.from("user_preferences").select("*").eq("user_id", editorId).maybeSingle();
    editorPrefs = prefs;
    await admin.from("user_preferences").upsert({ user_id: editorId, notify_task_assigned: true, notify_task_reminders: true }, { onConflict: "user_id" });
  });

  afterAll(async () => {
    try {
      for (const id of taskIds) {
        await admin.from("job_queue").delete().like("dedupe_key", `%${id}%`);
        await admin.from("tasks").delete().eq("id", id);
      }
      await admin.from("activities").delete().like("subject", `${TAG}%`);
      if (editorPrefs) {
        await admin
          .from("user_preferences")
          .update({ notify_task_assigned: editorPrefs.notify_task_assigned, notify_task_reminders: editorPrefs.notify_task_reminders })
          .eq("user_id", editorId);
      } else if (editorId) {
        await admin.from("user_preferences").delete().eq("user_id", editorId);
      }
      const mine = await mailpitSearch(`subject:"${TAG}"`);
      if (mine.length) {
        await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: mine.map((x) => x.ID) }) });
      }
      await ownerDb?.auth.signOut();
    } finally {
      process.env = { ...savedEnv };
      __setAdminClientForTests(null);
    }
  });

  it("assigning a task queues one job; the email reaches the assignee exactly once", async () => {
    const { data: task, error } = await ownerDb
      .from("tasks")
      .insert({ workspace_id: workspaceId, title: `${TAG} <b>Call</b> Maya & co`, assigned_to: editorId, notes: "Bring <samples>", priority: "high" })
      .select("id,assignment_version")
      .single();
    expect(error).toBeNull();
    taskIds.push(task!.id);

    // The database trigger queued it, attributed to the owner.
    const { data: jobs } = await admin.from("job_queue").select("*").eq("dedupe_key", `task_assigned:${task!.id}:1`);
    expect(jobs).toHaveLength(1);
    const job = jobs![0];
    expect(job).toMatchObject({ kind: KINDS.assigned, status: "pending", payload: { task_id: task!.id, assignee_id: editorId, assigned_by: ownerId, assignment_version: 1 } });

    const out: any = await notificationJobHandlers[KINDS.assigned](job, ctx());
    expect(out.status).toBe("done");
    await admin.from("job_queue").update({ status: "done", result: out.result, finished_at: new Date().toISOString() }).eq("id", job.id);

    const found = await waitForMail(`to:${users.editor.email} subject:"${TAG}"`, 1);
    expect(found).toHaveLength(1);
    expect(found[0].Subject).toBe(`Assigned to you: ${TAG} <b>Call</b> Maya & co`);
    const msg: any = await (await fetch(`${MAILPIT}/api/v1/message/${found[0].ID}`)).json();
    expect(msg.HTML).toContain(`${TAG} &lt;b&gt;Call&lt;/b&gt; Maya &amp; co`);
    expect(msg.HTML).toContain(`href="http://localhost:3102/?task=${task!.id}"`);
    expect(msg.HTML).toContain("assigned you a task");
    expect(msg.Text).toContain("Bring <samples>");
    expect(msg.From.Address).toBe("crm@crm.test");

    // Run it again, as a worker would after a crash before "done" was recorded.
    const { data: again } = await admin.from("job_queue").select("*").eq("id", job.id).single();
    const second: any = await notificationJobHandlers[KINDS.assigned]({ ...again, status: "running" }, ctx());
    expect(second.status).toBe("done");
    // Saving the task again without changing the assignee queues nothing new.
    await ownerDb.from("tasks").update({ notes: "Bring <samples> please" }).eq("id", task!.id);
    const { data: stillOne } = await admin.from("job_queue").select("id").like("dedupe_key", `task_assigned:${task!.id}:%`);
    expect(stillOne).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 800));
    expect(await mailpitSearch(`to:${users.editor.email} subject:"${TAG}"`)).toHaveLength(1);
  });

  it("a due reminder is planned from real rows, queued once and emailed once", async () => {
    const ws = await loadWorkspaceContext(admin, workspaceId);
    const now = new Date();
    const due = localParts(now.getTime() - 60_000, ws!.timeZone); // went off a minute ago, team time
    const { data: task, error } = await ownerDb
      .from("tasks")
      .insert({ workspace_id: workspaceId, title: `${TAG} reminder`, assigned_to: editorId, due_date: due.date, due_time: due.time, reminder: "at_due" })
      .select("*")
      .single();
    expect(error).toBeNull();
    taskIds.push(task!.id);

    const plan = planNotifications({ now, workspaceTz: ws!.timeZone, tasks: [task as TaskRow], members: ws!.members, prefsByUser: ws!.prefsByUser });
    const reminder = plan.find((j) => j.kind === KINDS.reminder)!;
    expect(reminder.dedupeKey).toBe(`task_reminder:${task!.id}:${due.date}:${due.time}:at_due`);
    const id = await enqueueJob(reminder.kind, reminder.payload, { dedupeKey: reminder.dedupeKey, workspaceId });
    expect(id).not.toBeNull();
    expect(await enqueueJob(reminder.kind, reminder.payload, { dedupeKey: reminder.dedupeKey, workspaceId })).toBeNull(); // the database dedupes

    const { data: job } = await admin.from("job_queue").select("*").eq("id", id!).single();
    const out: any = await notificationJobHandlers[KINDS.reminder]({ ...job, status: "running", attempts: 1 }, ctx());
    expect(out.status).toBe("done");
    await admin.from("job_queue").update({ status: "done", result: out.result, finished_at: new Date().toISOString() }).eq("id", id!);
    const found = await waitForMail(`to:${users.editor.email} subject:"${TAG} reminder"`, 1);
    expect(found).toHaveLength(1);
    expect(found[0].Subject).toMatch(new RegExp(`^(Due now|Overdue): ${TAG} reminder$`));

    // Completed tasks are skipped at send time.
    await ownerDb.from("tasks").update({ status: "done" }).eq("id", task!.id);
    const stale: any = await notificationJobHandlers[KINDS.reminder]({ ...job, id: -1, status: "running", result: null }, ctx());
    expect(stale).toMatchObject({ status: "skipped", result: { reason: "The task is already done" } });
    await new Promise((r) => setTimeout(r, 500));
    expect(await mailpitSearch(`subject:"${TAG} reminder"`)).toHaveLength(1);
  });
});
