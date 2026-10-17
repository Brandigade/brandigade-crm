import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncAccount, syncBackoffMs, syncDueEmailAccounts } from "../../../lib/server/email/sync.js";
import { setupEmail, USERS, type EmailTest } from "./helpers.js";

let t: EmailTest;
beforeEach(() => {
  t = setupEmail();
});
afterEach(() => {
  t.teardown();
  vi.useRealTimers();
});

const ME = "eddie@brandigade.com";
const soon = () => Date.now() + 40_000;
const fresh = (id: string) => t.db.accounts.find((a) => a.id === id)!;
const gmailCalls = (pred: (path: string, s: URLSearchParams) => boolean) => t.google.calls.filter((c) => pred(c.path, c.search));

describe("Gmail sync", () => {
  async function seedMailbox() {
    const maya = t.contact("Maya@Cedar.example");
    const sam = t.contact("sam@north.example");
    t.contact(ME); // a lead with my own address must never match
    const m = {
      inbound: t.google.addMessage(ME, { from: "Maya Rivera <maya@cedar.example>", to: ME, subject: "Quote", text: "Hi Eddie", html: '<p onclick="x()">Hi <b>Eddie</b></p><script>bad()</script>', daysAgo: 2, attachments: ["quote.pdf"] }),
      stranger: t.google.addMessage(ME, { from: "news@shop.example", to: ME, subject: "Sale", text: "50% off", daysAgo: 1 }),
      sent: t.google.addMessage(ME, { from: ME, to: "Sam <SAM@north.example>", cc: "maya@cedar.example", subject: "Follow-up", text: "Hello Sam", labels: ["SENT"], daysAgo: 1 }),
      spam: t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "spam", text: "x", labels: ["SPAM"], daysAgo: 1 }),
      draft: t.google.addMessage(ME, { from: ME, to: "maya@cedar.example", subject: "draft", text: "x", labels: ["DRAFT"], daysAgo: 1 }),
      old: t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "old", text: "x", daysAgo: 40 }),
      self: t.google.addMessage(ME, { from: ME, to: ME, subject: "note to self", text: "x", labels: ["SENT", "INBOX"], daysAgo: 1 }),
    };
    return { maya, sam, m };
  }

  it("first sync: last 30 days, metadata first, body only for lead emails, sanitized", async () => {
    const { maya, sam, m } = await seedMailbox();
    const account = await t.connected("google", ME);
    const historyAtStart = t.google.mailbox(ME).historyId;
    const r = await syncAccount(account, { deadline: soon() });
    expect(r).toMatchObject({ ok: true, done: true, stored: 2 });

    const list = gmailCalls((p) => p.endsWith("/messages"))[0];
    expect(list.search.get("q")).toBe("newer_than:30d -in:drafts -in:chats");
    const fullFetches = gmailCalls((p, s) => /\/messages\/gm-/.test(p) && s.get("format") === "full").map((c) => c.path.split("/").pop());
    expect(fullFetches.sort()).toEqual([m.inbound.id, m.sent.id].sort());
    const meta = gmailCalls((p, s) => /\/messages\/gm-/.test(p) && s.get("format") === "metadata");
    expect(meta.length).toBe(4); // inbound, stranger, sent, self (spam/drafts/old never listed)
    expect(meta[0].search.getAll("metadataHeaders")).toEqual(expect.arrayContaining(["From", "To", "Cc", "Bcc", "Subject", "Message-ID", "In-Reply-To", "References", "Date"]));

    expect(t.db.messages).toHaveLength(2);
    const inbound = t.db.messages.find((x) => x.provider_message_id === m.inbound.id)!;
    expect(inbound).toMatchObject({
      direction: "inbound",
      from_address: "maya@cedar.example",
      from_name: "Maya Rivera",
      to_addresses: [{ email: ME, name: null }],
      matched_contact_ids: [maya.id],
      visibility: "team",
      owner_user_id: USERS.editor.id,
      has_attachments: true,
      body_text: "Hi Eddie",
      provider_thread_id: m.inbound.threadId,
    });
    expect(inbound.body_html).toBe("<p>Hi <b>Eddie</b></p>");
    const sent = t.db.messages.find((x) => x.provider_message_id === m.sent.id)!;
    expect(sent.direction).toBe("outbound");
    expect(sent.matched_contact_ids).toEqual([maya.id, sam.id].sort());
    expect(sent.to_addresses).toEqual([{ email: "sam@north.example", name: "Sam" }]);

    const a = fresh(account.id);
    expect(a).toMatchObject({ initial_sync_done: true, consecutive_failures: 0, last_error: null, sync_lock_until: null });
    expect(a.sync_cursor).toEqual({ historyId: String(historyAtStart) });
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeGreaterThan(100_000);
    expect(a.last_synced_at).toBeTruthy();
  });

  it("private mailboxes store private copies", async () => {
    t.contact("maya@cedar.example");
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, text: "x", daysAgo: 1 });
    const account = await t.connected("google", ME, "editor", { sharing: "private" });
    await syncAccount(account, { deadline: soon() });
    expect(t.db.messages[0].visibility).toBe("private");
  });

  it("incremental sync uses history.list, is idempotent and skips spam/drafts", async () => {
    const { maya } = await seedMailbox();
    const account = await t.connected("google", ME);
    await syncAccount(account, { deadline: soon() });
    expect(t.db.messages).toHaveLength(2);
    const afterFirst = fresh(account.id).sync_cursor.historyId;
    // Nothing new: no duplicate rows, no message fetches.
    t.google.calls = [];
    await syncAccount(fresh(account.id), { deadline: soon() });
    expect(t.db.messages).toHaveLength(2);
    expect(gmailCalls((p) => p.endsWith("/messages"))).toHaveLength(0);
    expect(gmailCalls((p) => p.endsWith("/history"))).toHaveLength(1);

    const reply = t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "Re: Quote", text: "Thanks!" });
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "junk", text: "x", labels: ["SPAM"] });
    t.google.addMessage(ME, { from: ME, to: "maya@cedar.example", subject: "unsent", text: "x", labels: ["DRAFT"] });
    t.google.calls = [];
    const r = await syncAccount(fresh(account.id), { deadline: soon() });
    expect(r).toMatchObject({ ok: true, stored: 1 });
    expect(t.db.messages.map((x) => x.provider_message_id)).toContain(reply.id);
    expect(t.db.messages.find((x) => x.provider_message_id === reply.id)!.matched_contact_ids).toEqual([maya.id]);
    expect(gmailCalls((p) => p.endsWith("/history"))[0].search.get("historyTypes")).toBe("messageAdded");
    expect(fresh(account.id).sync_cursor.historyId).toBe(String(t.google.mailbox(ME).historyId));
    // Replaying the same history (e.g. after a crash) changes nothing.
    fresh(account.id).sync_cursor = { historyId: afterFirst };
    await syncAccount(fresh(account.id), { deadline: soon() });
    expect(t.db.messages).toHaveLength(3);
    expect(new Set(t.db.messages.map((x) => x.provider_message_id)).size).toBe(3);
  });

  it("history 404 falls back to a 7-day rescan", async () => {
    t.contact("maya@cedar.example");
    const account = await t.connected("google", ME);
    await syncAccount(account, { deadline: soon() });
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "while away", text: "x", daysAgo: 3 });
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, subject: "too old for the rescan", text: "x", daysAgo: 10 });
    t.google.expireHistory(ME);
    t.google.calls = [];
    const r = await syncAccount(fresh(account.id), { deadline: soon() });
    expect(r.ok).toBe(true);
    expect(gmailCalls((p) => p.endsWith("/messages"))[0].search.get("q")).toBe("newer_than:7d -in:drafts -in:chats");
    expect(t.db.messages.map((m) => m.subject)).toEqual(["while away"]);
    expect(fresh(account.id).sync_cursor.historyId).toBe(String(t.google.mailbox(ME).historyId));
  });

  it("a first sync that runs out of time resumes where it stopped", async () => {
    t.contact("maya@cedar.example");
    for (let i = 0; i < 250; i++) t.google.addMessage(ME, { from: i % 5 === 0 ? "maya@cedar.example" : `x${i}@other.example`, to: ME, subject: `m${i}`, text: "x", daysAgo: 1 });
    const account = await t.connected("google", ME);
    vi.useFakeTimers({ toFake: ["Date"] });
    t.google.onRequest = (_r, u) => {
      if (u.pathname.endsWith("/messages")) vi.setSystemTime(Date.now() + 10_000);
    };
    const r1 = await syncAccount(account, { deadline: Date.now() + 15_000 });
    expect(r1).toMatchObject({ ok: true, done: false });
    const a1 = fresh(account.id);
    expect(a1.sync_cursor.scan).toMatchObject({ pageToken: "100", examined: 100 });
    expect(a1.initial_sync_done).toBe(false);
    expect(Date.parse(a1.next_sync_at)).toBeLessThanOrEqual(Date.now()); // continue at the next tick
    t.google.onRequest = undefined;
    const r2 = await syncAccount(a1, { deadline: Date.now() + 60_000 });
    expect(r2).toMatchObject({ ok: true, done: true });
    expect(t.db.messages).toHaveLength(50);
    expect(new Set(t.db.messages.map((m) => m.provider_message_id)).size).toBe(50);
    expect(fresh(account.id)).toMatchObject({ initial_sync_done: true });
    expect(fresh(account.id).sync_cursor.scan).toBeUndefined();
  });

  it("failures back off exponentially (capped at an hour) and keep a readable error", async () => {
    const account = await t.connected("google", ME);
    t.google.fail({ match: (_r, u) => u.pathname.endsWith("/profile"), status: 500, body: { error: { code: 500, message: "Backend Error" } }, times: 8 });
    const r = await syncAccount(account, { deadline: soon() });
    expect(r.ok).toBe(false);
    let a = fresh(account.id);
    expect(a.consecutive_failures).toBe(1);
    expect(a.last_error).toBe("Gmail: Backend Error");
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeGreaterThan(55_000);
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeLessThan(65_000);
    expect(a.sync_lock_until).toBeNull();
    await syncAccount(a, { deadline: soon() });
    a = fresh(account.id);
    expect(a.consecutive_failures).toBe(2);
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeGreaterThan(115_000);
    expect(syncBackoffMs(1)).toBe(60_000);
    expect(syncBackoffMs(3)).toBe(240_000);
    expect(syncBackoffMs(30)).toBe(3_600_000);
    // Success resets the counter and the error.
    await syncAccount(a, { deadline: soon() });
    expect(fresh(account.id)).toMatchObject({ consecutive_failures: 0, last_error: null });
  });

  it("a provider rate limit waits exactly as long as asked, without counting as a failure", async () => {
    const account = await t.connected("google", ME);
    t.google.fail({ match: (_r, u) => u.pathname.endsWith("/profile"), status: 429, headers: { "Retry-After": "120" }, body: { error: { code: 429, message: "Rate Limit Exceeded" } } });
    const r = await syncAccount(account, { deadline: soon() });
    expect(r).toMatchObject({ ok: false, rateLimited: true });
    const a = fresh(account.id);
    expect(a.consecutive_failures).toBe(0);
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeGreaterThan(115_000);
    expect(Date.parse(a.next_sync_at) - Date.now()).toBeLessThanOrEqual(121_000);
  });

  it("revoked access stops the mailbox until it is reconnected", async () => {
    const account = await t.connected("google", ME);
    t.db.tokens[0].access_token_expires_at = new Date(Date.now() - 1).toISOString();
    t.google.revokeAll(ME);
    const r = await syncAccount(account, { deadline: soon() });
    expect(r).toMatchObject({ ok: false, reconnectRequired: true });
    expect(fresh(account.id)).toMatchObject({ status: "reconnect_required", sync_lock_until: null });
  });
});

describe("Outlook (Graph) sync", () => {
  const MS = "olivia@contoso.example";
  const graphCalls = (pred: (path: string, s: URLSearchParams) => boolean) => t.microsoft.calls.filter((c) => pred(c.path, c.search));

  async function seed() {
    const priya = t.contact("priya@lumen.example");
    t.microsoft.pageSize = 2;
    const m = {
      in1: t.microsoft.addMessage(MS, { from: "Priya <Priya@Lumen.example>", to: [MS], subject: "Brief", html: "<p>Brief <img src=x onerror=alert(1)></p>", daysAgo: 3 }),
      in2: t.microsoft.addMessage(MS, { from: "a@x.example", to: [MS], subject: "noise", text: "n", daysAgo: 2 }),
      in3: t.microsoft.addMessage(MS, { from: "b@x.example", to: [MS], subject: "noise", text: "n", daysAgo: 2 }),
      old: t.microsoft.addMessage(MS, { from: "priya@lumen.example", to: [MS], subject: "old", text: "o", daysAgo: 45 }),
      sent: t.microsoft.addMessage(MS, { folder: "sentitems", from: MS, to: ["priya@lumen.example"], subject: "Re: Brief", text: "Sure", daysAgo: 1 }),
      draft: t.microsoft.addMessage(MS, { folder: "drafts", from: MS, to: ["priya@lumen.example"], subject: "draft", text: "d", isDraft: true }),
    };
    return { priya, m };
  }

  it("first sync: delta on Inbox and Sent Items for the last 30 days, with paging", async () => {
    const { priya, m } = await seed();
    const account = await t.connected("microsoft", MS);
    const r = await syncAccount(account, { deadline: soon() });
    expect(r).toMatchObject({ ok: true, done: true, stored: 2 });
    const firstDelta = graphCalls((p) => p.endsWith("/mailFolders/inbox/messages/delta"))[0];
    const filter = firstDelta.search.get("$filter")!;
    expect(filter).toMatch(/^receivedDateTime ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const since = Date.parse(filter.split(" ge ")[1]);
    expect(Math.round((Date.now() - since) / 86400_000)).toBe(30);
    expect(firstDelta.prefer).toContain('IdType="ImmutableId"');
    expect(graphCalls((p, s) => p.includes("/delta") && s.has("$skiptoken")).length).toBeGreaterThan(0); // followed nextLink
    // Bodies only for the two lead emails.
    const bodyFetches = graphCalls((p) => /\/me\/messages\/AAMk/.test(p)).map((c) => c.path.split("/").pop());
    expect(bodyFetches.sort()).toEqual([m.in1.id, m.sent.id].sort());
    const in1 = t.db.messages.find((x) => x.provider_message_id === m.in1.id)!;
    expect(in1).toMatchObject({ direction: "inbound", from_address: "priya@lumen.example", matched_contact_ids: [priya.id], provider_thread_id: m.in1.conversationId });
    expect(in1.body_html).toBe('<p>Brief <img src="x" /></p>');
    expect(t.db.messages.find((x) => x.provider_message_id === m.sent.id)!.direction).toBe("outbound");
    const a = fresh(account.id);
    expect(a.initial_sync_done).toBe(true);
    expect(a.sync_cursor.folders.inbox).toMatchObject({ complete: true });
    expect(a.sync_cursor.folders.inbox.link).toContain("$deltatoken=");
    expect(a.sync_cursor.folders.sentitems.link).toContain("$deltatoken=");
  });

  it("incremental sync follows the stored deltaLink and is idempotent", async () => {
    await seed();
    const account = await t.connected("microsoft", MS);
    await syncAccount(account, { deadline: soon() });
    await syncAccount(fresh(account.id), { deadline: soon() });
    expect(t.db.messages).toHaveLength(2);
    t.microsoft.addMessage(MS, { from: "priya@lumen.example", to: [MS], subject: "New", text: "n" });
    t.microsoft.calls = [];
    const r = await syncAccount(fresh(account.id), { deadline: soon() });
    expect(r).toMatchObject({ ok: true, stored: 1 });
    expect(graphCalls((p, s) => p.includes("/delta") && s.has("$deltatoken")).length).toBe(2);
    expect(graphCalls((p, s) => p.includes("/delta") && s.has("$filter")).length).toBe(0);
    expect(t.db.messages).toHaveLength(3);
  });

  it("an expired delta (410 SyncStateNotFound) restarts that folder with a 7-day window", async () => {
    await seed();
    const account = await t.connected("microsoft", MS);
    await syncAccount(account, { deadline: soon() });
    t.microsoft.addMessage(MS, { from: "priya@lumen.example", to: [MS], subject: "During outage", text: "n", daysAgo: 4 });
    t.microsoft.expireDeltaTokens(MS);
    t.microsoft.calls = [];
    const r = await syncAccount(fresh(account.id), { deadline: soon() });
    expect(r.ok).toBe(true);
    const restart = graphCalls((p, s) => p.endsWith("/inbox/messages/delta") && s.has("$filter"))[0];
    const since = Date.parse(restart.search.get("$filter")!.split(" ge ")[1]);
    expect(Math.round((Date.now() - since) / 86400_000)).toBe(7);
    expect(t.db.messages.map((x) => x.subject).sort()).toEqual(["Brief", "During outage", "Re: Brief"]);
  });

  it("never follows a stored link that points somewhere else", async () => {
    await seed();
    const account = await t.connected("microsoft", MS, "editor", {
      initial_sync_done: true,
      sync_cursor: { folders: { inbox: { link: "https://evil.example/graph/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=1", complete: true } } },
    });
    const r = await syncAccount(account, { deadline: soon() });
    expect(r.ok).toBe(true);
    expect(fresh(account.id).sync_cursor.folders.inbox.link).toMatch(/^http:\/\/ms\.test\/graph\/v1\.0\//);
  });
});

describe("syncDueEmailAccounts", () => {
  it("claims only due, active mailboxes of editors/owners and releases every lock", async () => {
    t.contact("maya@cedar.example");
    t.google.addMessage(ME, { from: "maya@cedar.example", to: ME, text: "x", daysAgo: 1 });
    const due = await t.connected("google", ME);
    const notDue = await t.connected("google", "later@brandigade.com", "editor2", { next_sync_at: new Date(Date.now() + 60_000).toISOString() });
    const viewers = await t.connected("google", "vera@brandigade.com", "viewer");
    const broken = await t.connected("microsoft", "olivia@contoso.example", "owner", { status: "reconnect_required" });
    const paused = await t.connected("microsoft", "p@contoso.example", "owner", { sync_enabled: false });
    const summary: any = await syncDueEmailAccounts({ deadline: Date.now() + 45_000 });
    expect(summary).toMatchObject({ claimed: 1, synced: 1, failed: 0, stored: 1 });
    expect(fresh(due.id).last_synced_at).toBeTruthy();
    for (const a of [notDue, viewers, broken, paused]) expect(fresh(a.id).last_synced_at).toBeNull();
    expect(t.db.accounts.every((a) => !a.sync_lock_until)).toBe(true);
  });

  it("does nothing when no provider is configured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;
    await t.connected("google", ME);
    expect(await syncDueEmailAccounts({ deadline: Date.now() + 45_000 })).toEqual({ skipped: "not_configured" });
  });
});
