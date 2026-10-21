import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { PermanentJobError } from "../../../lib/server/jobs.js";
import { createRouter } from "../../../lib/server/router.js";
import { createNotificationRoutes, notificationRoutes } from "../../../lib/server/notifications/routes.js";
import { SMTP_SENDER, WS, crm, fakeSend } from "./fixtures.js";

const env = { ...process.env };
beforeEach(() => {
  process.env.SUPABASE_URL = "http://sb.test";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.APP_URL = "https://crm.example";
  for (const k of ["RESEND_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SMTP_HOST", "SMTP_PASS"]) delete process.env[k];
});
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

const USERS = {
  "tok-owner": { id: "owner", email: "owner@crm.test" },
  "tok-ed": { id: "ed", email: "editor@crm.test" },
  "tok-vi": { id: "vi", email: "viewer@crm.test" },
  "tok-out": { id: "outsider", email: "out@crm.test" },
};

function setup(opts: { sender?: typeof SMTP_SENDER | null; fail?: Error; now?: Date; over?: Parameters<typeof crm>[0] } = {}) {
  const db = crm(opts.over);
  const known = USERS as Record<string, { id: string; email: string }>;
  db.client.auth = { getUser: async (t: string) => (known[t] ? { data: { user: known[t] }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
  __setAdminClientForTests(db.client);
  const mail = fakeSend({ fail: opts.fail });
  let now = opts.now ?? new Date("2026-10-17T05:00:10Z");
  const handle = createRouter(
    createNotificationRoutes({ sender: () => (opts.sender === undefined ? SMTP_SENDER : opts.sender), send: mail.send, now: () => now }),
  );
  const call = (method: string, path: string, token?: string) =>
    handle(new Request(`http://x${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: method === "POST" ? "{}" : undefined }));
  return { db, mail, call, tick: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("routes", () => {
  it("exports the two routes", () => {
    expect(notificationRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/notifications/test", "GET /api/notifications/status"]);
  });
});

describe("POST /api/notifications/test", () => {
  it("needs a signed-in member", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/notifications/test")).status).toBe(401);
    expect((await call("POST", "/api/notifications/test", "forged")).status).toBe(401);
    expect((await call("POST", "/api/notifications/test", "tok-out")).status).toBe(403);
  });
  it("sends a test email to the caller (viewers too) and logs it", async () => {
    const { call, mail, db } = setup();
    const res = await call("POST", "/api/notifications/test", "tok-vi");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, to: "viewer@crm.test", provider: "smtp" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "viewer@crm.test", subject: "Test email from Brandigade CRM" });
    const job = db.jobs()[0];
    expect(job).toMatchObject({ kind: "notify.test_email", status: "done", dedupe_key: "test_email:vi:2026-10-17T05:00", workspace_id: WS });
    expect(job.result).toMatchObject({ recipient_id: "vi", to: "vi***@crm.test" });
    // Scheduled out of reach of the workers while the request sends it.
    expect(Date.parse(job.run_after)).toBeGreaterThan(Date.parse("2026-10-17T05:10:00Z"));
  });
  it("allows one per person per minute", async () => {
    const { call, mail, tick } = setup();
    expect((await call("POST", "/api/notifications/test", "tok-ed")).status).toBe(200);
    const again = await call("POST", "/api/notifications/test", "tok-ed");
    expect(again.status).toBe(429);
    expect(((await again.json()) as any).code).toBe("rate_limited");
    expect((await call("POST", "/api/notifications/test", "tok-owner")).status).toBe(200); // someone else
    tick(60_000);
    expect((await call("POST", "/api/notifications/test", "tok-ed")).status).toBe(200);
    expect(mail.sent).toHaveLength(3);
  });
  it("a sent email is reported as sent even if logging it fails", async () => {
    const { call, mail, db } = setup();
    const update = db.client.from;
    db.client.from = (t: string) => {
      const q = update(t);
      if (t !== "job_queue") return q;
      const original = q.update;
      q.update = (...a: unknown[]) => {
        original(...a);
        throw new Error("connection reset");
      };
      return q;
    };
    const res = await call("POST", "/api/notifications/test", "tok-ed");
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
  });
  it("503 when no sender is set up", async () => {
    const { call, db } = setup({ sender: null });
    const res = await call("POST", "/api/notifications/test", "tok-ed");
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe("not_configured");
    expect(db.jobs()).toEqual([]);
  });
  it("a refused send is reported and logged as a failure", async () => {
    const { call, db } = setup({ fail: new PermanentJobError("The mail server rejected the login") });
    const res = await call("POST", "/api/notifications/test", "tok-ed");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The test email wasn't sent: The mail server rejected the login", code: "send_failed" });
    expect(db.jobs()[0]).toMatchObject({ status: "dead", last_error: "The mail server rejected the login" });
  });
});

describe("GET /api/notifications/status", () => {
  it("is owner-only", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/notifications/status", "tok-ed")).status).toBe(403);
    expect((await call("GET", "/api/notifications/status", "tok-vi")).status).toBe(403);
    expect((await call("GET", "/api/notifications/status")).status).toBe(401);
  });
  it("shows the sender (no secrets), 24 h counts and recent failures", async () => {
    process.env.SMTP_PASS = "very-secret-password";
    const recent = new Date().toISOString();
    const { call } = setup({
      over: {
        job_queue: [
          { id: 1, kind: "notify.task_assigned", status: "done", updated_at: recent, payload: {} },
          { id: 2, kind: "notify.task_reminder", status: "skipped", updated_at: recent, payload: {} },
          { id: 3, kind: "notify.task_reminder", status: "dead", attempts: 6, max_attempts: 6, updated_at: recent, last_error: "Login very-secret-password rejected", payload: { task_id: "t1", recipient_id: "ed" } },
          { id: 4, kind: "notify.daily_digest", status: "retry", attempts: 2, max_attempts: 6, updated_at: recent, last_error: "timeout", payload: { user_id: "vi" } },
          { id: 5, kind: "email.backfill_contact", status: "dead", updated_at: recent, last_error: "not ours", payload: {} },
          { id: 6, kind: "notify.task_assigned", status: "done", updated_at: "2026-01-01T00:00:00Z", payload: {} },
        ],
      },
    });
    const res = await call("GET", "/api/notifications/status", "tok-owner");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("very-secret-password");
    expect(body.sender).toEqual({ configured: true, kind: "smtp", label: SMTP_SENDER.label, from: "Brandigade CRM <crm@crm.test>" });
    expect(body.last24h).toEqual({ sent: 1, skipped: 1, failed: 1, waiting: 1 });
    expect(body.recentFailures).toHaveLength(2);
    const dead = body.recentFailures.find((f: any) => f.id === 3);
    expect(dead).toMatchObject({ kind: "notify.task_reminder", status: "dead", attempts: 6, taskTitle: "Send <samples> & pricing", recipient: "Eddie <Editor>", error: "Login *** rejected" });
    expect(body.recentFailures.find((f: any) => f.id === 4)).toMatchObject({ status: "retry", recipient: "viewer" });
  });
  it("says so when no sender is set up", async () => {
    const { call } = setup({ sender: null });
    const body: any = await (await call("GET", "/api/notifications/status", "tok-owner")).json();
    expect(body.sender).toEqual({ configured: false, kind: null, label: null, from: null });
  });
});
