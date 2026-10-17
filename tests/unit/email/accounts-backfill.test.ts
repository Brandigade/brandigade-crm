import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailJobHandlers } from "../../../lib/server/email/worker.js";
import { syncAccount } from "../../../lib/server/email/sync.js";
import { RetryJobLater } from "../../../lib/server/jobs.js";
import { setupEmail, USERS, type EmailTest } from "./helpers.js";

let t: EmailTest;
beforeEach(() => {
  t = setupEmail();
});
afterEach(() => t.teardown());

const ME = "eddie@brandigade.com";
const MS = "olivia@contoso.example";

describe("mailbox routes", () => {
  it("GET /api/email/accounts lists only my mailboxes, without tokens or sync internals", async () => {
    const mine = await t.connected("google", ME, "editor", { sync_cursor: { historyId: "123" }, sync_lock_until: new Date(Date.now() + 30_000).toISOString() });
    await t.connected("microsoft", MS, "editor2");
    await t.connected("google", "old@brandigade.com", "editor", { status: "disconnected" });
    const r = await t.call("/api/email/accounts", { who: "editor" });
    expect(r.status).toBe(200);
    expect(r.json.accounts).toHaveLength(1);
    expect(r.json.accounts[0]).toMatchObject({ id: mine.id, provider: "google", email_address: ME, status: "active", sharing: "team", syncing: true });
    const text = JSON.stringify(r.json);
    for (const secret of ["sync_cursor", "historyId", "token", "refresh", "v1."]) expect(text).not.toContain(secret);
    expect((await t.call("/api/email/accounts")).status).toBe(401);
    expect((await t.call("/api/email/accounts", { who: "viewer" })).json.accounts).toEqual([]);
  });

  it("POST /accounts/:id/sync runs a bounded sync for the mailbox owner only", async () => {
    t.contact("maya@cedar.example");
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, text: "x" });
    const mine = await t.connected("google", ME);
    const theirs = await t.connected("google", "sara@brandigade.com", "editor2");
    expect((await t.call(`/api/email/accounts/${theirs.id}/sync`, { body: {}, who: "editor" })).status).toBe(404);
    expect((await t.call(`/api/email/accounts/${mine.id}/sync`, { body: {}, who: "viewer" })).status).toBe(403);
    const r = await t.call(`/api/email/accounts/${mine.id}/sync`, { body: {}, who: "editor" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ queued: false, result: { ok: true, done: true, stored: 1 } });
    expect(r.json.account.last_synced_at).toBeTruthy();
    expect(t.db.accounts.find((a) => a.id === mine.id)!.sync_lock_until).toBeNull();
    // Already running elsewhere: just queued.
    t.db.accounts.find((a) => a.id === mine.id)!.sync_lock_until = new Date(Date.now() + 60_000).toISOString();
    t.db.accounts.find((a) => a.id === mine.id)!.last_sync_started_at = new Date(Date.now() - 60_000).toISOString();
    expect((await t.call(`/api/email/accounts/${mine.id}/sync`, { body: {}, who: "editor" })).json.queued).toBe(true);
    t.db.accounts.find((a) => a.id === mine.id)!.status = "reconnect_required";
    expect((await t.call(`/api/email/accounts/${mine.id}/sync`, { body: {}, who: "editor" })).json.code).toBe("reconnect_required");
  });

  it("POST /accounts/:id/disconnect revokes at Google, deletes tokens and keeps logged emails", async () => {
    t.contact("maya@cedar.example");
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, text: "x" });
    const mine = await t.connected("google", ME);
    await syncAccount(mine, { deadline: Date.now() + 30_000 });
    expect(t.db.messages).toHaveLength(1);
    const theirs = await t.connected("google", "sara@brandigade.com", "editor2");
    expect((await t.call(`/api/email/accounts/${theirs.id}/disconnect`, { body: {}, who: "editor" })).status).toBe(404);
    const r = await t.call(`/api/email/accounts/${mine.id}/disconnect`, { body: {}, who: "editor" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, revoked: true });
    expect(t.google.revoked).toHaveLength(1);
    expect(t.db.tokens.find((x) => x.account_id === mine.id)).toBeUndefined();
    expect(t.db.accounts.find((a) => a.id === mine.id)).toMatchObject({ status: "disconnected", sync_enabled: false, sync_cursor: {} });
    expect(t.db.messages).toHaveLength(1);
    expect((await t.call("/api/email/accounts", { who: "editor" })).json.accounts).toEqual([]);
    expect((await t.repo.claimAccounts(10, 60)).map((a) => a.id)).toEqual([theirs.id]);
  });

  it("Outlook mailboxes and viewers can be disconnected too (no Google revoke)", async () => {
    const box = await t.connected("microsoft", MS, "viewer");
    const r = await t.call(`/api/email/accounts/${box.id}/disconnect`, { body: {}, who: "viewer" });
    expect(r.json).toMatchObject({ ok: true, revoked: false });
    expect(t.db.tokens).toHaveLength(0);
  });
});

describe("job email.backfill_contact", () => {
  const job = (payload: Record<string, unknown>) => ({ id: 1, kind: "email.backfill_contact", payload, workspace_id: null, dedupe_key: null, attempts: 1, max_attempts: 6, run_after: "" });
  const run = (payload: Record<string, unknown>, deadline = Date.now() + 45_000) => emailJobHandlers["email.backfill_contact"](job(payload), { deadline });

  it("pulls in a new lead's last 90 days from every active Gmail and Outlook mailbox, idempotently", async () => {
    const maya = t.contact("maya@cedar.example");
    const gm = await t.connected("google", ME);
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "existing", text: "x", daysAgo: 5 });
    await syncAccount(gm, { deadline: Date.now() + 30_000 });
    const existing = t.db.messages[0];
    expect(existing.matched_contact_ids).toEqual([maya.id]);

    // Tom becomes a lead later: he was on cc of the stored email, and wrote 60 days ago.
    t.db.messages[0].cc_addresses = [{ email: "tom@atlas.example", name: null }];
    t.google.mailbox(ME).messages[0].headers.push(["Cc", "tom@atlas.example"]);
    t.google.addMessage(ME, { from: "Tom <tom@atlas.example>", to: ME, subject: "intro", text: "hi", daysAgo: 60 });
    t.google.addMessage(ME, { from: "tom@atlas.example", to: ME, subject: "ancient", text: "hi", daysAgo: 120 });
    t.google.addMessage(ME, { from: "tom@atlas.example", to: ME, subject: "junk", text: "hi", daysAgo: 3, labels: ["SPAM"] });
    await t.connected("microsoft", MS, "owner");
    t.microsoft.addMessage(MS, { from: "tom@atlas.example", to: [MS], subject: "outlook intro", text: "hi", daysAgo: 30 });
    t.microsoft.addMessage(MS, { folder: "junkemail", from: "tom@atlas.example", to: [MS], subject: "outlook junk", text: "hi", daysAgo: 3 });
    t.microsoft.addMessage(MS, { from: "tom@atlas.example", to: [MS], subject: "outlook ancient", text: "hi", daysAgo: 100 });
    await t.connected("google", "vera@brandigade.com", "viewer"); // viewers' mailboxes are not used
    const tom = t.contact("Tom@Atlas.example");

    const out = await run({ contact_id: tom.id, email: "tom@atlas.example" });
    expect(out).toMatchObject({ status: "done", result: { mailboxes: 2 } });
    const subjects = t.db.messages.map((m) => m.subject).sort();
    expect(subjects).toEqual(["existing", "intro", "outlook intro"]);
    expect(t.db.messages.find((m) => m.id === existing.id)!.matched_contact_ids).toEqual([maya.id, tom.id].sort());
    expect(t.db.messages.find((m) => m.subject === "intro")!.matched_contact_ids).toEqual([tom.id]);
    const q = t.google.calls.find((c) => c.path.endsWith("/messages") && (c.search.get("q") || "").includes("tom@"))!.search.get("q");
    expect(q).toBe("{from:tom@atlas.example to:tom@atlas.example cc:tom@atlas.example bcc:tom@atlas.example} newer_than:90d -in:drafts -in:chats");
    const search = t.microsoft.calls.find((c) => c.search.has("$search"))!.search.get("$search")!;
    expect(search).toMatch(/^"participants:tom@atlas\.example AND received>=\d{4}-\d{2}-\d{2}"$/);
    expect(t.google.calls.some((c) => c.path.includes("vera"))).toBe(false);

    const before = JSON.stringify(t.db.messages);
    await run({ contact_id: tom.id, email: "tom@atlas.example" });
    expect(JSON.stringify(t.db.messages)).toBe(before);
  });

  it("skips leads that are gone or whose address changed, and rejects bad payloads", async () => {
    await t.connected("google", ME);
    const c = t.contact("new@x.io");
    expect(await run({ contact_id: randomUUID(), email: "a@b.co" })).toMatchObject({ status: "skipped" });
    expect(await run({ contact_id: c.id, email: "old@x.io" })).toMatchObject({ status: "skipped" });
    await expect(run({})).rejects.toThrow(/contact_id/);
  });

  it("asks to be retried later when time runs out, and skips mailboxes that need reconnecting", async () => {
    const c = t.contact("tom@atlas.example");
    const gm = await t.connected("google", ME);
    await expect(run({ contact_id: c.id, email: "tom@atlas.example" }, Date.now() + 5_000)).rejects.toBeInstanceOf(RetryJobLater);
    t.db.tokens.find((x) => x.account_id === gm.id)!.access_token_expires_at = new Date(Date.now() - 1).toISOString();
    t.google.revokeAll(ME);
    expect(await run({ contact_id: c.id, email: "tom@atlas.example" })).toMatchObject({ status: "done", result: { mailboxes: 0 } });
    expect(t.db.accounts.find((a) => a.id === gm.id)!.status).toBe("reconnect_required");
    expect(USERS.editor.id).toBeTruthy();
  });
});
