import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRouter } from "../../../lib/server/router.js";
import { emailRoutes } from "../../../lib/server/email/routes.js";
import { emailJobHandlers } from "../../../lib/server/email/worker.js";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { __setEmailRepoForTests } from "../../../lib/server/email/repo.js";
import { __setEmailFetchForTests } from "../../../lib/server/email/provider-http.js";
import { serveFakeProviders, type FakeProviders } from "../../fakes/email/serve.js";
// @ts-expect-error plain JS helper shared with the dev scripts
import { parseEnv } from "../../../scripts/env.mjs";

// The real route handlers and worker against the shared LOCAL Supabase stack
// (tables, RLS, triggers, get_timeline) with the provider fakes behind a
// local HTTP server. Skipped automatically when the local stack isn't
// running. Every row it creates is prefixed EMAILTEST and removed afterwards.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fileEnv: Record<string, string> = fs.existsSync(path.join(root, ".env.local")) ? parseEnv(fs.readFileSync(path.join(root, ".env.local"), "utf8")) : {};
const SB_URL = fileEnv.SUPABASE_URL || "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SB_URL);
const reachable = isLocal && !!fileEnv.SUPABASE_SERVICE_ROLE_KEY && !!fileEnv.TOKEN_ENCRYPTION_KEY
  ? await fetch(`${SB_URL}/auth/v1/health`, { headers: { apikey: fileEnv.SUPABASE_ANON_KEY || "" }, signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)
  : false;
const users = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/local-users.json"), "utf8"));

const RUN = Date.now().toString(36);
const TAG = `EMAILTEST ${RUN}`;
const MAILBOX = `emailtest-editor-${RUN}@gmail.test`;
const MAYA = `emailtest-maya-${RUN}@cedar.example`;
const SAM = `emailtest-sam-${RUN}@north.example`;

describe.skipIf(!reachable)("email integration (local Supabase + fake Gmail server)", () => {
  const savedEnv = { ...process.env };
  let fakes: FakeProviders;
  let admin: SupabaseClient;
  let workspaceId: string;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const contacts: Record<string, string> = {};
  const handle = createRouter(emailRoutes);
  let accountId = "";

  async function signIn(who: "owner" | "editor" | "viewer") {
    const c = createClient(SB_URL, fileEnv.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await c.auth.signInWithPassword({ email: users[who].email, password: users[who].password });
    if (error || !data.session) throw error || new Error("sign-in failed");
    tokens[who] = data.session.access_token;
    userIds[who] = data.user.id;
  }
  const asUser = (who: string) =>
    createClient(SB_URL, fileEnv.SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tokens[who]}` } } });

  async function call(p: string, o: { method?: string; body?: unknown; who?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = {};
    if (o.who) headers.authorization = `Bearer ${tokens[o.who]}`;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await handle(new Request(`http://localhost:3101${p}`, { method: o.method || (o.body !== undefined ? "POST" : "GET"), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
    const text = await res.text();
    return { res, status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  }

  async function timelineEmails(who: string, contactId: string) {
    const { data, error } = await asUser(who).rpc("get_timeline", { p_kind: "contact", p_id: contactId, p_types: ["email"] });
    if (error) throw error;
    return (data || []) as any[];
  }

  beforeAll(async () => {
    fakes = await serveFakeProviders();
    Object.assign(process.env, fileEnv, fakes.env, { APP_URL: "http://localhost:3101" });
    __setAdminClientForTests(null);
    __setEmailRepoForTests(null);
    __setEmailFetchForTests(null);
    admin = createClient(SB_URL, fileEnv.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    await Promise.all([signIn("owner"), signIn("editor"), signIn("viewer")]);
    const { data: ws } = await admin.from("workspaces").select("id").limit(1).single();
    workspaceId = ws!.id;
    for (const [key, email] of [["maya", MAYA], ["sam", SAM]] as const) {
      const { data, error } = await admin.from("contacts").insert({ workspace_id: workspaceId, first_name: `${TAG} ${key}`, email }).select("id").single();
      if (error) throw error;
      contacts[key] = data.id;
    }
    fakes.consentEmail.google = MAILBOX;
    fakes.google.addMessage(MAILBOX, { from: `Maya <${MAYA.toUpperCase()}>`, to: MAILBOX, subject: `${TAG} quote`, text: "Hello from Maya", html: "<p>Hello <b>from</b> Maya</p><script>x()</script>", daysAgo: 2 });
    fakes.google.addMessage(MAILBOX, { from: "newsletter@shop.example", to: MAILBOX, subject: `${TAG} newsletter`, text: "not a lead", daysAgo: 1 });
  }, 60_000);

  afterAll(async () => {
    try {
      if (admin) {
        if (accountId) await admin.from("email_sends").delete().eq("account_id", accountId);
        if (userIds.editor) await admin.from("email_sends").delete().eq("user_id", userIds.editor).like("subject", `${TAG}%`);
        await admin.from("email_accounts").delete().like("email_address", `emailtest-%${RUN}%`); // cascades to messages and tokens
        const ids = Object.values(contacts);
        if (ids.length) {
          await admin.from("job_queue").delete().eq("kind", "email.backfill_contact").in("payload->>contact_id", ids);
          await admin.from("contacts").delete().in("id", ids);
        }
        await admin.from("activities").delete().like("subject", `${TAG}%`);
        if (userIds.editor) await admin.from("oauth_states").delete().eq("user_id", userIds.editor);
      }
    } finally {
      await fakes?.close();
      process.env = savedEnv;
      __setAdminClientForTests(null);
    }
  }, 60_000);

  it("connects a mailbox through OAuth with the browser-binding cookie", async () => {
    const start = await call("/api/email/oauth/start", { body: { provider: "google" }, who: "editor" });
    expect(start.status).toBe(200);
    const setCookie = start.res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/^crm_oauth=[^;]+; HttpOnly; SameSite=Lax; Path=\/api\/email\/oauth; Max-Age=600$/); // no Secure on http://localhost
    const cookie = setCookie.split(";")[0];
    // The fake consent screen redirects back to the CRM.
    const consent = await fetch(start.json.url, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("http://localhost:3101/api/email/oauth/google/callback");
    // Without the cookie (another browser) nothing is connected, and the state is burned.
    const wrong = await call(back.pathname + back.search, { cookie: "crm_oauth=someone-else" });
    expect(wrong.res.headers.get("location")).toBe("http://localhost:3101/?email_error=browser_mismatch#profile");

    const again = await call("/api/email/oauth/start", { body: { provider: "google" }, who: "editor" });
    const cookie2 = (again.res.headers.get("set-cookie") || "").split(";")[0];
    const back2 = new URL((await fetch(again.json.url, { redirect: "manual" })).headers.get("location")!);
    const ok = await call(back2.pathname + back2.search, { cookie: cookie2 });
    expect(ok.status).toBe(302);
    expect(ok.res.headers.get("location")).toBe("http://localhost:3101/?email_connected=google#profile");
    expect(cookie).not.toBe(cookie2);

    const { data: acc } = await admin.from("email_accounts").select("*").eq("email_address", MAILBOX).single();
    expect(acc).toMatchObject({ user_id: userIds.editor, workspace_id: workspaceId, provider: "google", status: "active", sharing: "team" });
    accountId = acc.id;
    const { data: tok } = await admin.from("email_account_tokens").select("*").eq("account_id", accountId).single();
    expect(tok.refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(tok)).not.toMatch(/g-rt-|g-at-/); // never stored in plain text
    const { count } = await admin.from("oauth_states").select("*", { count: "exact", head: true }).eq("user_id", userIds.editor);
    expect(count).toBe(0);
    // The browser can see its own mailbox row, never the tokens.
    const mine = await asUser("editor").from("email_accounts").select("id").eq("id", accountId);
    expect(mine.data).toHaveLength(1);
    const leak = await asUser("editor").from("email_account_tokens").select("*");
    expect(leak.data ?? []).toHaveLength(0);
    const list = await call("/api/email/accounts", { who: "editor" });
    expect(list.json.accounts.map((a: any) => a.id)).toContain(accountId);
  });

  it("syncs: only the lead email is stored, and it appears on the lead's timeline for the team", async () => {
    expect(accountId).toBeTruthy();
    const r = await call(`/api/email/accounts/${accountId}/sync`, { body: {}, who: "editor" });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ ok: true, done: true, stored: 1 });
    const { data: msgs } = await admin.from("email_messages").select("*").eq("account_id", accountId);
    expect(msgs).toHaveLength(1);
    expect(msgs![0]).toMatchObject({ direction: "inbound", from_address: MAYA, matched_contact_ids: [contacts.maya], visibility: "team" });
    expect(msgs![0].body_html).toBe("<p>Hello <b>from</b> Maya</p>");
    // Rerun is idempotent.
    await admin.from("email_accounts").update({ next_sync_at: new Date().toISOString(), last_sync_started_at: null }).eq("id", accountId);
    await call(`/api/email/accounts/${accountId}/sync`, { body: {}, who: "editor" });
    expect((await admin.from("email_messages").select("id").eq("account_id", accountId)).data).toHaveLength(1);

    for (const who of ["editor", "owner", "viewer"]) {
      const items = await timelineEmails(who, contacts.maya);
      expect(items.map((i) => i.subject)).toEqual([`${TAG} quote`]);
      expect(items[0].email).toMatchObject({ id: msgs![0].id, direction: "inbound", from_address: MAYA });
    }
  });

  it("a private mailbox's emails are invisible to other members, even the owner", async () => {
    const { error } = await asUser("editor").rpc("update_email_account_settings", { p_account: accountId, p_sharing: "private" });
    expect(error).toBeNull();
    expect(await timelineEmails("editor", contacts.maya)).toHaveLength(1);
    expect(await timelineEmails("owner", contacts.maya)).toHaveLength(0);
    expect(await timelineEmails("viewer", contacts.maya)).toHaveLength(0);
    const { data: msg } = await admin.from("email_messages").select("id").eq("account_id", accountId).single();
    expect((await asUser("owner").from("email_messages").select("id").eq("id", msg!.id)).data).toHaveLength(0);
    expect((await asUser("editor").from("email_messages").select("id").eq("id", msg!.id)).data).toHaveLength(1);
    // Someone else can't change it back.
    const denied = await asUser("owner").rpc("set_email_visibility", { p_message: msg!.id, p_visibility: "team" });
    expect(denied.error).toBeTruthy();
    await asUser("editor").rpc("update_email_account_settings", { p_account: accountId, p_sharing: "team" });
    expect(await timelineEmails("owner", contacts.maya)).toHaveLength(1);
  });

  it("sends an email that shows on the lead's timeline at once, exactly once", async () => {
    const clientRequestId = randomUUID();
    const body = { clientRequestId, to: [SAM], subject: `${TAG} proposal`, bodyText: "Hi Sam,\nthe proposal is attached.", contactId: contacts.sam };
    const r = await call("/api/email/send", { body, who: "editor" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("sent");
    const again = await call("/api/email/send", { body, who: "editor" });
    expect(again.json).toMatchObject({ replayed: true, emailMessageId: r.json.emailMessageId });
    expect(fakes.google.sent).toHaveLength(1);
    const items = await timelineEmails("owner", contacts.sam);
    expect(items.map((i) => i.subject)).toEqual([`${TAG} proposal`]);
    expect(items[0].email.direction).toBe("outbound");
    const { data: send } = await admin.from("email_sends").select("*").eq("user_id", userIds.editor).eq("client_request_id", clientRequestId).single();
    expect(send).toMatchObject({ status: "sent", email_message_id: r.json.emailMessageId });
    // Viewers can't send.
    expect((await call("/api/email/send", { body: { ...body, clientRequestId: randomUUID() }, who: "viewer" })).status).toBe(403);
  });

  it("backfills a new lead's earlier emails from the connected mailbox", async () => {
    const tom = `emailtest-tom-${RUN}@atlas.example`;
    fakes.google.addMessage(MAILBOX, { from: tom, to: MAILBOX, subject: `${TAG} from tom`, text: "hi", daysAgo: 45 });
    const { data, error } = await admin.from("contacts").insert({ workspace_id: workspaceId, first_name: `${TAG} tom`, email: tom.toUpperCase() }).select("id").single();
    if (error) throw error;
    contacts.tom = data.id;
    // The database queued the job when the lead got an address.
    const { data: job } = await admin.from("job_queue").select("*").eq("kind", "email.backfill_contact").eq("payload->>contact_id", data.id).single();
    expect(job.payload).toMatchObject({ contact_id: data.id, email: tom });
    const out = await emailJobHandlers["email.backfill_contact"](job, { deadline: Date.now() + 40_000 });
    expect(out).toMatchObject({ status: "done" });
    const items = await timelineEmails("editor", data.id);
    expect(items.map((i) => i.subject)).toEqual([`${TAG} from tom`]);
  });

  it("disconnecting revokes access, deletes tokens and keeps the logged emails", async () => {
    const r = await call(`/api/email/accounts/${accountId}/disconnect`, { body: {}, who: "editor" });
    expect(r.json).toMatchObject({ ok: true, revoked: true });
    expect((await admin.from("email_account_tokens").select("account_id").eq("account_id", accountId)).data).toHaveLength(0);
    const { data: acc } = await admin.from("email_accounts").select("status,sync_enabled").eq("id", accountId).single();
    expect(acc).toEqual({ status: "disconnected", sync_enabled: false });
    expect(await timelineEmails("owner", contacts.maya)).toHaveLength(1);
  });
});
