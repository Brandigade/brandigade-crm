import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeMimeWords } from "../../../lib/server/email/addresses.js";
import { syncAccount } from "../../../lib/server/email/sync.js";
import { newAccount } from "../../fakes/email/memory-repo.js";
import { setupEmail, USERS, WS, type EmailTest } from "./helpers.js";

let t: EmailTest;
beforeEach(() => {
  t = setupEmail();
});
afterEach(() => t.teardown());

const ME = "eddie@brandigade.com";
const MS = "olivia@contoso.example";
const headerOf = (raw: string, name: string) => {
  const head = raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  const line = head.split("\r\n").find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(name.length + 1).trim() : null;
};
const send = (body: Record<string, unknown>, who: "editor" | "viewer" | "owner" | "editor2" = "editor") =>
  t.call("/api/email/send", { body: { clientRequestId: randomUUID(), subject: "Hello", bodyText: "Hi there", ...body }, who });

describe("POST /api/email/send (Gmail)", () => {
  it("sends a correct MIME message and puts it on the lead's timeline at once", async () => {
    const maya = t.contact("maya@cedar.example");
    const account = await t.connected("google", ME);
    const r = await send({ to: ["Maya@Cedar.example"], cc: ["boss@brandigade.com"], subject: "Café proposal ☕", bodyText: "Hi Maya,\nHere it is.", contactId: maya.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "sent" });
    expect(t.google.sent).toHaveLength(1);
    const raw = t.google.sent[0].raw;
    expect(headerOf(raw, "From")).toBe('"Eddie Editor" <eddie@brandigade.com>');
    expect(headerOf(raw, "To")).toBe("maya@cedar.example");
    expect(headerOf(raw, "Cc")).toBe("boss@brandigade.com");
    expect(decodeMimeWords(headerOf(raw, "Subject")!)).toBe("Café proposal ☕");
    expect(t.google.sent[0].threadId).toBeUndefined();

    const row = t.db.messages[0];
    expect(row).toMatchObject({
      account_id: account.id,
      direction: "outbound",
      provider_message_id: t.google.sent[0].id,
      matched_contact_ids: [maya.id],
      subject: "Café proposal ☕",
      body_text: "Hi Maya,\nHere it is.",
      visibility: "team",
      owner_user_id: USERS.editor.id,
    });
    // The Message-ID Gmail actually used was read back (Gmail may replace ours).
    expect(row.internet_message_id).toBe(`<gmail-${t.google.sent[0].id}@mail.gmail.com>`);
    expect(t.db.sends[0]).toMatchObject({ status: "sent", provider_message_id: t.google.sent[0].id, email_message_id: row.id, contact_id: maya.id });
    expect(r.json.emailMessageId).toBe(row.id);

    // The next sync sees the same message in SENT and doesn't duplicate it.
    await syncAccount(t.db.accounts[0], { deadline: Date.now() + 30_000 });
    expect(t.db.messages).toHaveLength(1);
  });

  it("is idempotent: the same clientRequestId never sends twice", async () => {
    t.contact("maya@cedar.example");
    await t.connected("google", ME);
    const id = randomUUID();
    const first = await send({ clientRequestId: id, to: ["maya@cedar.example"] });
    const again = await send({ clientRequestId: id, to: ["maya@cedar.example"], subject: "changed" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "sent", replayed: true, sendId: first.json.sendId, emailMessageId: first.json.emailMessageId });
    expect(t.google.sent).toHaveLength(1);
    // Two identical requests at the same moment: still one email.
    const id2 = randomUUID();
    const both = await Promise.all([send({ clientRequestId: id2, to: ["maya@cedar.example"] }), send({ clientRequestId: id2, to: ["maya@cedar.example"] })]);
    expect(both.map((b) => b.status).sort()).toEqual([200, 409]);
    expect(both.find((b) => b.status === 409)!.json.code).toBe("send_in_progress");
    expect(t.google.sent).toHaveLength(2);
    expect(t.db.sends).toHaveLength(2);
  });

  it("threads replies: In-Reply-To, References and the Gmail threadId of my own copy", async () => {
    const maya = t.contact("maya@cedar.example");
    const account = await t.connected("google", ME);
    t.db.messages.push({
      id: randomUUID(), workspace_id: WS, account_id: account.id, owner_user_id: USERS.editor.id, provider: "google",
      provider_message_id: "gm-orig", provider_thread_id: "th-orig", internet_message_id: "<orig@cedar.example>", in_reply_to: null,
      references_header: "<first@cedar.example>", direction: "inbound", from_address: "maya@cedar.example", from_name: "Maya",
      to_addresses: [{ email: ME, name: null }], cc_addresses: [], bcc_addresses: [], subject: "Quote", snippet: "", body_text: "", body_html: null,
      has_attachments: false, sent_at: new Date().toISOString(), visibility: "team", matched_contact_ids: [maya.id],
    });
    const r = await send({ to: ["maya@cedar.example"], subject: "Re: Quote", replyToMessageId: t.db.messages[0].id });
    expect(r.status).toBe(200);
    const raw = t.google.sent[0].raw;
    expect(headerOf(raw, "In-Reply-To")).toBe("<orig@cedar.example>");
    expect(headerOf(raw, "References")).toBe("<first@cedar.example> <orig@cedar.example>");
    expect(t.google.sent[0].threadId).toBe("th-orig");
    expect(t.db.messages.find((m) => m.provider_message_id === t.google.sent[0].id)).toMatchObject({ in_reply_to: "<orig@cedar.example>", provider_thread_id: "th-orig" });
  });

  it("replying to a teammate's shared email threads by headers; their private email is off limits", async () => {
    const maya = t.contact("maya@cedar.example");
    await t.connected("google", ME);
    const teammates = newAccount({ workspace_id: WS, user_id: USERS.editor2.id, provider: "google", email_address: "sara@brandigade.com" });
    t.db.accounts.push(teammates);
    const base = {
      workspace_id: WS, account_id: teammates.id, owner_user_id: USERS.editor2.id, provider: "google" as const, provider_thread_id: "th-x",
      in_reply_to: null, references_header: null, direction: "inbound" as const, from_address: "maya@cedar.example", from_name: null,
      to_addresses: [], cc_addresses: [], bcc_addresses: [], subject: "Q", snippet: "", body_text: "", body_html: null, has_attachments: false,
      sent_at: new Date().toISOString(), matched_contact_ids: [maya.id],
    };
    t.db.messages.push({ ...base, id: randomUUID(), provider_message_id: "p1", internet_message_id: "<shared@x>", visibility: "team" });
    t.db.messages.push({ ...base, id: randomUUID(), provider_message_id: "p2", internet_message_id: "<private@x>", visibility: "private" });
    const ok = await send({ to: ["maya@cedar.example"], replyToMessageId: t.db.messages[0].id });
    expect(ok.status).toBe(200);
    expect(headerOf(t.google.sent[0].raw, "In-Reply-To")).toBe("<shared@x>");
    expect(t.google.sent[0].threadId).toBeUndefined();
    const denied = await send({ to: ["maya@cedar.example"], replyToMessageId: t.db.messages[1].id });
    expect(denied.status).toBe(404);
    expect(t.google.sent).toHaveLength(1);
  });

  it("limits sending to 30 emails per 10 minutes per person", async () => {
    await t.connected("google", ME);
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      t.db.sends.push({
        id: randomUUID(), workspace_id: WS, account_id: null, user_id: USERS.editor.id, client_request_id: randomUUID(), contact_id: null,
        in_reply_to_message_id: null, to_addresses: [], cc_addresses: [], subject: null, body_text: null, status: "sent",
        provider_message_id: null, email_message_id: null, error: null, created_at: new Date(now - (i < 5 ? 11 * 60_000 : 60_000)).toISOString(), sent_at: null,
      });
    }
    const allowed = await send({ to: ["x@y.io"] }); // 25 in the window
    expect(allowed.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await send({ to: ["x@y.io"] })).status).toBe(200);
    const blocked = await send({ to: ["x@y.io"] });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe("rate_limited");
    expect(t.google.sent).toHaveLength(5);
    // Someone else isn't affected.
    await t.connected("google", "sara@brandigade.com", "editor2");
    expect((await send({ to: ["x@y.io"] }, "editor2")).status).toBe(200);
  });

  it("an unconfirmed send (5xx after the request went out) is never retried", async () => {
    await t.connected("google", ME);
    t.google.fail({ match: (_r, u) => u.pathname.endsWith("/messages/send"), status: 503, body: { error: { code: 503, message: "Backend Error" } } });
    const id = randomUUID();
    const r = await send({ clientRequestId: id, to: ["x@y.io"] });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("send_unconfirmed");
    expect(t.google.calls.filter((c) => c.path.endsWith("/messages/send"))).toHaveLength(1); // no automatic retry
    expect(t.db.sends[0]).toMatchObject({ status: "pending" });
    expect(t.db.sends[0].error).toMatch(/^unconfirmed/);
    const again = await send({ clientRequestId: id, to: ["x@y.io"] });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("send_unconfirmed");
    expect(t.google.calls.filter((c) => c.path.endsWith("/messages/send"))).toHaveLength(1);
  });

  it("a definite rejection is marked failed and the same draft may be sent again", async () => {
    await t.connected("google", ME);
    t.google.fail({ match: (_r, u) => u.pathname.endsWith("/messages/send"), status: 400, body: { error: { code: 400, message: "Invalid To header" } } });
    const id = randomUUID();
    const r = await send({ clientRequestId: id, to: ["x@y.io"] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: "provider_rejected" });
    expect(r.json.error).toContain("Invalid To header");
    expect(t.db.sends[0].status).toBe("failed");
    const retry = await send({ clientRequestId: id, to: ["x@y.io"] });
    expect(retry.status).toBe(200);
    expect(t.google.sent).toHaveLength(1);
    expect(t.db.sends).toHaveLength(1);
    expect(t.db.sends[0].status).toBe("sent");
  });

  it("checks role, mailbox ownership, status and input before anything is sent", async () => {
    const mine = await t.connected("google", ME);
    const theirs = await t.connected("google", "sara@brandigade.com", "editor2");
    expect((await send({ to: ["x@y.io"] }, "viewer")).status).toBe(403);
    expect((await send({ to: ["x@y.io"], accountId: theirs.id })).status).toBe(404);
    const injected = await send({ to: ["x@y.io"], subject: "Hi\r\nBcc: everyone@example.com" });
    expect(injected.status).toBe(400);
    expect(injected.json.code).toBe("invalid_header");
    expect((await send({ to: ["not-an-address"] })).json.code).toBe("invalid_recipient");
    t.db.accounts.find((a) => a.id === mine.id)!.status = "reconnect_required";
    const r = await send({ to: ["x@y.io"], accountId: mine.id });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("reconnect_required");
    t.db.accounts.find((a) => a.id === mine.id)!.status = "disconnected";
    expect((await send({ to: ["x@y.io"] })).json.code).toBe("no_mailbox");
    expect(t.google.sent).toHaveLength(0);
    expect(t.db.sends).toHaveLength(0);
  });

  it("revoked access while sending asks for a reconnect and marks the send failed", async () => {
    await t.connected("google", ME);
    t.db.tokens[0].access_token_expires_at = new Date(Date.now() - 1).toISOString();
    t.google.revokeAll(ME);
    const r = await send({ to: ["x@y.io"] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("reconnect_required");
    expect(t.db.sends[0].status).toBe("failed");
    expect(t.db.accounts[0].status).toBe("reconnect_required");
  });

  it("emails to people who aren't leads are sent but not stored", async () => {
    await t.connected("google", ME);
    const r = await send({ to: ["friend@else.example"] });
    expect(r.status).toBe(200);
    expect(r.json.emailMessageId).toBeNull();
    expect(t.db.messages).toHaveLength(0);
  });
});

describe("POST /api/email/send (Outlook)", () => {
  it("creates a draft, sends it, and stores it under the draft's immutable id", async () => {
    const priya = t.contact("priya@lumen.example");
    await t.connected("microsoft", MS);
    const r = await send({ to: [{ email: "priya@lumen.example", name: "Priya" }], subject: "Brief", bodyText: "Line 1\nLine 2" });
    expect(r.status).toBe(200);
    const calls = t.microsoft.calls.map((c) => `${c.method} ${c.path.replace(/^.*\/v1\.0/, "")}`);
    expect(calls).toEqual(expect.arrayContaining(["POST /me/messages", expect.stringMatching(/^POST \/me\/messages\/[^/]+\/send$/)]));
    const create = JSON.parse(t.microsoft.calls.find((c) => c.method === "POST" && c.path.endsWith("/me/messages"))!.body!);
    expect(create).toMatchObject({ subject: "Brief", body: { contentType: "Text", content: "Line 1\nLine 2" }, toRecipients: [{ emailAddress: { address: "priya@lumen.example", name: "Priya" } }] });
    expect(t.microsoft.calls.every((c) => !c.path.includes("/v1.0/") || (c.prefer || "").includes("ImmutableId"))).toBe(true);
    const box = t.microsoft.mailbox(MS);
    const sent = box.messages.find((m) => m.folder === "sentitems")!;
    expect(t.db.messages[0]).toMatchObject({ provider_message_id: sent.id, direction: "outbound", matched_contact_ids: [priya.id], internet_message_id: sent.internetMessageId });
  });

  it("replies with createReply on my own copy, keeping the quoted original", async () => {
    const priya = t.contact("priya@lumen.example");
    const account = await t.connected("microsoft", MS);
    const orig = t.microsoft.addMessage(MS, { from: "priya@lumen.example", to: [MS], subject: "Brief", html: "<p>Original text</p>" });
    await syncAccount(account, { deadline: Date.now() + 30_000 });
    const stored = t.db.messages.find((m) => m.provider_message_id === orig.id)!;
    expect(stored.matched_contact_ids).toEqual([priya.id]);
    const r = await send({ to: ["priya@lumen.example"], subject: "Re: Brief", bodyText: "Thanks <Priya>", replyToMessageId: stored.id });
    expect(r.status).toBe(200);
    expect(t.microsoft.calls.some((c) => c.path.endsWith(`/me/messages/${orig.id}/createReply`))).toBe(true);
    const patch = JSON.parse(t.microsoft.calls.find((c) => c.method === "PATCH")!.body!);
    expect(patch.subject).toBe("Re: Brief");
    expect(patch.body.contentType).toBe("HTML");
    expect(patch.body.content).toContain("Thanks &lt;Priya&gt;");
    expect(patch.body.content).toContain("Original text");
    expect(patch.body.content.indexOf("Thanks")).toBeLessThan(patch.body.content.indexOf("Original text"));
    const sent = t.microsoft.mailbox(MS).messages.find((m) => m.folder === "sentitems")!;
    expect(sent.conversationId).toBe(orig.conversationId);
  });

  it("removes the draft when Outlook refuses to send it", async () => {
    await t.connected("microsoft", MS);
    t.microsoft.fail({ match: (r, u) => r.method === "POST" && u.pathname.endsWith("/send"), status: 400, body: { error: { code: "ErrorInvalidRecipients", message: "At least one recipient is not valid." } } });
    const r = await send({ to: ["x@y.io"] });
    expect(r.status).toBe(422);
    expect(t.microsoft.mailbox(MS).messages.filter((m) => m.folder === "drafts")).toHaveLength(0);
    expect(t.db.sends[0].status).toBe("failed");
  });
});
