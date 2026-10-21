import type { Route } from "../router.js";
import { OWNER, requireAuth } from "../auth.js";
import { HttpError, badRequest, json, notConfigured } from "../http.js";
import { enqueueJob } from "../jobs.js";
import { adminClient } from "../supabase.js";
import { KINDS, dedupeKeys, personTimeZone, prefsFrom, workspaceTimeZone } from "./rules.js";
import { testEmail } from "./content.js";
import { memberName, must } from "./data.js";
import { publicSenderInfo, redactSecrets, senderConfig, sendEmail, type OutgoingEmail, type SendResult, type SenderConfig } from "./sender.js";
import { maskEmail } from "./worker.js";
import { DAY } from "./time.js";

// Notification routes. Preferences themselves are read and written by the
// browser straight in user_preferences (row level security: own row only).
//
//   POST /api/notifications/test    any signed-in member: sends a test email to
//                                   themselves through the configured sender.
//                                   One per person per minute (job_queue dedupe
//                                   key with the minute in it). Viewers may use
//                                   it too: it only ever goes to the caller.
//   GET  /api/notifications/status  owner: which sender is configured (never
//                                   secret values), last-24h counts and recent
//                                   delivery failures.

export const MAX_TEST_EMAILS_PER_DAY = 5;

export interface RouteDeps {
  sender?: () => SenderConfig | null;
  send?: (msg: OutgoingEmail, cfg: SenderConfig) => Promise<SendResult>;
  now?: () => Date;
}

const errorText = (err: unknown) => redactSecrets(err instanceof Error ? err.message : String(err));

export function createNotificationRoutes(overrides: RouteDeps = {}): Route[] {
  const sender = overrides.sender ?? senderConfig;
  const send = overrides.send ?? ((msg: OutgoingEmail, cfg: SenderConfig) => sendEmail(msg, {}, cfg));
  const clock = overrides.now ?? (() => new Date());

  async function sendTest(req: Request): Promise<Response> {
    const auth = await requireAuth(req);
    const cfg = sender();
    if (!cfg) throw notConfigured("Email sending");
    const db = adminClient();
    const now = clock();
    const [profile, prefsRow, workspace] = await Promise.all([
      db.from("profiles").select("id,email,display_name").eq("id", auth.userId).maybeSingle(),
      db.from("user_preferences").select("*").eq("user_id", auth.userId).maybeSingle(),
      db.from("workspaces").select("id,settings").eq("id", auth.workspaceId).maybeSingle(),
    ]);
    const person = must(profile, "load profile") as { email: string | null; display_name: string | null } | null;
    const to = (person?.email || auth.email || "").trim();
    if (!to) throw badRequest("Your account has no email address.", "no_email");
    const tz = personTimeZone(prefsFrom(must(prefsRow, "load preferences") as any), workspaceTimeZone((must(workspace, "load workspace") as any)?.settings));

    // The queued row is the rate limit (one per minute) and the delivery log.
    // It is scheduled 15 minutes out so no worker picks it up while this
    // request is sending it.
    // Also at most a few a day, so test emails can't use up the sender's daily quota.
    const { count: today } = await db
      .from("job_queue")
      .select("id", { count: "exact", head: true })
      .eq("kind", KINDS.test)
      .eq("payload->>user_id", auth.userId)
      .gte("created_at", new Date(now.getTime() - DAY).toISOString());
    if ((today || 0) >= MAX_TEST_EMAILS_PER_DAY) throw new HttpError(429, "You have sent the maximum number of test emails for today.", "rate_limited");
    const key = dedupeKeys.test(auth.userId, now);
    const jobId = await enqueueJob(KINDS.test, { user_id: auth.userId }, { dedupeKey: key, workspaceId: auth.workspaceId, runAfter: new Date(now.getTime() + 15 * 60_000), maxAttempts: 1 });
    if (jobId === null) throw new HttpError(429, "You can send one test email a minute. Try again in a moment.", "rate_limited");

    const content = testEmail({ recipientName: memberName({ display_name: person?.display_name ?? null, email: to }), senderLabel: cfg.label, now, timeZone: tz });
    const finished = new Date().toISOString();
    const record = async (fields: Record<string, unknown>) => {
      try {
        const { error } = await db.from("job_queue").update({ attempts: 1, finished_at: finished, locked_until: null, ...fields }).eq("id", jobId);
        if (error) console.warn("notifications: couldn't log the test email:", error.message);
      } catch (err) {
        console.warn("notifications: couldn't log the test email:", errorText(err));
      }
    };
    let sent: SendResult;
    try {
      sent = await send({ to, toName: person?.display_name, subject: content.subject, html: content.html, text: content.text, idempotencyKey: key }, cfg);
    } catch (err) {
      const message = errorText(err);
      await record({ status: "dead", last_error: message.slice(0, 2000) });
      console.warn("notifications: test email failed:", message);
      throw new HttpError(502, `The test email wasn't sent: ${message}`, "send_failed");
    }
    await record({ status: "done", result: { sent_at: finished, provider: sent.provider, message_id: sent.messageId, recipient_id: auth.userId, to: maskEmail(to), subject: content.subject } });
    return json({ sent: true, to, provider: sent.provider });
  }

  async function status(req: Request): Promise<Response> {
    await requireAuth(req, { roles: OWNER });
    const db = adminClient();
    const since = new Date(clock().getTime() - DAY).toISOString();
    const count = async (statuses: string[]) => {
      const { count: n, error } = await db
        .from("job_queue")
        .select("id", { count: "exact", head: true })
        .like("kind", "notify.%")
        .in("status", statuses)
        .gte("updated_at", since);
      if (error) throw new Error(`count jobs: ${error.message}`);
      return n || 0;
    };
    const [sent, skipped, failed, waiting, failuresRes] = await Promise.all([
      count(["done"]),
      count(["skipped"]),
      count(["dead"]),
      count(["pending", "retry", "running"]),
      db
        .from("job_queue")
        .select("id,kind,status,attempts,max_attempts,last_error,updated_at,payload")
        .like("kind", "notify.%")
        .in("status", ["retry", "dead"])
        .order("updated_at", { ascending: false })
        .limit(10),
    ]);
    const failures = (must(failuresRes, "load failures") || []) as {
      id: number;
      kind: string;
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      updated_at: string;
      payload: Record<string, unknown> | null;
    }[];

    // Name the task and the person for each failure (the owner can see both anyway).
    const taskIds = [...new Set(failures.map((f) => f.payload?.task_id).filter((v): v is string => typeof v === "string"))];
    const userIds = [
      ...new Set(
        failures.map((f) => f.payload?.recipient_id || f.payload?.assignee_id || f.payload?.user_id).filter((v): v is string => typeof v === "string"),
      ),
    ];
    const [tasks, people] = await Promise.all([
      taskIds.length ? db.from("tasks").select("id,title").in("id", taskIds) : Promise.resolve({ data: [], error: null }),
      userIds.length ? db.from("profiles").select("id,email,display_name").in("id", userIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const titleById = new Map(((tasks.data || []) as { id: string; title: string }[]).map((t) => [t.id, t.title]));
    const nameById = new Map(((people.data || []) as { id: string; email: string | null; display_name: string | null }[]).map((p) => [p.id, memberName(p)]));

    return json({
      sender: publicSenderInfo(sender()),
      last24h: { sent, skipped, failed, waiting },
      recentFailures: failures.map((f) => {
        const taskId = typeof f.payload?.task_id === "string" ? f.payload.task_id : null;
        const userId = (f.payload?.recipient_id || f.payload?.assignee_id || f.payload?.user_id) as string | undefined;
        return {
          id: f.id,
          kind: f.kind,
          status: f.status,
          attempts: f.attempts,
          maxAttempts: f.max_attempts,
          error: f.last_error ? redactSecrets(f.last_error) : null,
          at: f.updated_at,
          taskId,
          taskTitle: taskId ? titleById.get(taskId) || null : null,
          recipient: userId ? nameById.get(userId) || null : null,
        };
      }),
    });
  }

  return [
    { method: "POST", path: "/api/notifications/test", handler: sendTest },
    { method: "GET", path: "/api/notifications/status", handler: status },
  ];
}

// Notification routes (test email, sender status). See docs/ARCHITECTURE.md.
export const notificationRoutes: Route[] = createNotificationRoutes();
