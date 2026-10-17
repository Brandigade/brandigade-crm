import { describe, expect, it } from "vitest";
import { decodeMimeWords, messageIdList, normalizeMessageId, parseAddressList } from "../../../lib/server/email/addresses.js";
import { gmailBodies, parseGmailMessage, parseGraphMessage, participants, graphBodies } from "../../../lib/server/email/parse.js";
import { bound, htmlToText, makeSnippet, sanitizeEmailHtml } from "../../../lib/server/email/sanitize.js";
import { matchLeads } from "../../../lib/server/email/ingest.js";
import { __setEmailRepoForTests } from "../../../lib/server/email/repo.js";
import { memoryRepo } from "../../fakes/email/memory-repo.js";
import { afterEach } from "vitest";

afterEach(() => __setEmailRepoForTests(null));

describe("address headers", () => {
  it("parses names, quotes, comments, groups and lowercases addresses", () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Example.com>, bob@Y.io (Bob), Team: a@z.co, B <b@z.co>;')).toEqual([
      { email: "jane@example.com", name: "Doe, Jane" },
      { email: "bob@y.io", name: null },
      { email: "a@z.co", name: null },
      { email: "b@z.co", name: "B" },
    ]);
    expect(parseAddressList("=?UTF-8?B?WsO2ZQ==?= <zoe@x.de>")).toEqual([{ email: "zoe@x.de", name: "Zöe" }]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("dup@x.io, DUP@x.io")).toHaveLength(1);
    expect(parseAddressList(null)).toEqual([]);
  });
  it("decodes RFC 2047 B and Q words in any charset", () => {
    expect(decodeMimeWords("=?ISO-8859-1?Q?Caf=E9_cr=E8me?= ok")).toBe("Café crème ok");
    expect(decodeMimeWords("=?UTF-8?B?w6k=?= =?UTF-8?B?w6k=?=")).toBe("éé");
    expect(decodeMimeWords("plain")).toBe("plain");
  });
  it("normalizes message ids", () => {
    expect(normalizeMessageId(" <abc@x> ")).toBe("<abc@x>");
    expect(normalizeMessageId("abc@x")).toBe("<abc@x>");
    expect(normalizeMessageId("garbage")).toBeNull();
    expect(messageIdList("<a@x> <b@x>\r\n <c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });
});

const gmailMsg = (labels: string[], headers: Record<string, string>, payloadExtra: any = {}) => ({
  id: "m1",
  threadId: "t1",
  labelIds: labels,
  snippet: "Hi &#39;there&#39; &amp; welcome",
  internalDate: String(Date.parse("2026-10-01T10:00:00Z")),
  payload: { mimeType: "multipart/mixed", headers: Object.entries(headers).map(([name, value]) => ({ name, value })), ...payloadExtra },
});

describe("Gmail parsing", () => {
  const headers = {
    From: "Maya Rivera <MAYA@cedar.example>",
    To: "eddie@brandigade.com, Sam <sam@north.example>",
    Cc: "grace@lumen.example",
    Subject: "=?UTF-8?Q?Caf=C3=A9_plans?=",
    "Message-Id": "<CAF123@mail.gmail.com>",
    "In-Reply-To": "<prev@x>",
    References: "<first@x> <prev@x>",
  };
  it("reads metadata, direction and dates", () => {
    const p = parseGmailMessage(gmailMsg(["INBOX", "UNREAD"], headers), "Eddie@brandigade.com");
    expect(p).toMatchObject({
      providerMessageId: "m1",
      threadId: "t1",
      internetMessageId: "<CAF123@mail.gmail.com>",
      inReplyTo: "<prev@x>",
      references: "<first@x> <prev@x>",
      direction: "inbound",
      from: { email: "maya@cedar.example", name: "Maya Rivera" },
      subject: "Café plans",
      snippet: "Hi 'there' & welcome",
      sentAt: "2026-10-01T10:00:00.000Z",
      skip: false,
    });
    expect(p.to.map((a) => a.email)).toEqual(["eddie@brandigade.com", "sam@north.example"]);
    expect(parseGmailMessage(gmailMsg(["SENT"], headers), "eddie@brandigade.com").direction).toBe("outbound");
    for (const l of ["SPAM", "TRASH", "DRAFT", "CHAT"]) expect(parseGmailMessage(gmailMsg([l], headers), "x@y.z").skip).toBe(true);
  });
  it("extracts text and html bodies by charset and detects attachments", () => {
    const latin = Buffer.from("Olé señor", "latin1").toString("base64url");
    const payload = {
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }], body: { data: latin } },
            { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: Buffer.from("<p>Olé</p>").toString("base64url") } },
          ],
        },
        { mimeType: "application/pdf", filename: "quote.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "a1" } },
      ],
    };
    const m = gmailMsg(["INBOX"], headers, payload);
    expect(gmailBodies(m.payload as any)).toEqual({ text: "Olé señor", html: "<p>Olé</p>" });
    expect(parseGmailMessage(m as any, "x@y.z").hasAttachments).toBe(true);
    const inlineOnly = gmailMsg(["INBOX"], headers, { parts: [{ mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-Disposition", value: "inline" }], body: { attachmentId: "x" } }] });
    expect(parseGmailMessage(inlineOnly as any, "x@y.z").hasAttachments).toBe(false);
  });
});

describe("Graph parsing", () => {
  const msg = {
    id: "AAMk1",
    conversationId: "c1",
    internetMessageId: "<abc@outlook.com>",
    subject: "Quote\r\nfollow-up",
    from: { emailAddress: { name: "Priya Shah", address: "Priya.Shah@Lumen.example" } },
    toRecipients: [{ emailAddress: { name: "me@brandigade.com", address: "ME@brandigade.com" } }],
    ccRecipients: [],
    receivedDateTime: "2026-10-02T08:00:00Z",
    sentDateTime: "2026-10-02T07:59:00Z",
    hasAttachments: true,
    bodyPreview: "Hello   there",
    isDraft: false,
    parentFolderId: "fld-inbox",
    internetMessageHeaders: [{ name: "In-Reply-To", value: "<prev@x>" }],
    body: { contentType: "html", content: "<b>Hi</b>" },
  };
  it("maps fields, lowercases addresses and drops name==address", () => {
    const p = parseGraphMessage(msg, "me@brandigade.com", "inbox");
    expect(p).toMatchObject({
      providerMessageId: "AAMk1",
      threadId: "c1",
      internetMessageId: "<abc@outlook.com>",
      inReplyTo: "<prev@x>",
      direction: "inbound",
      from: { email: "priya.shah@lumen.example", name: "Priya Shah" },
      to: [{ email: "me@brandigade.com", name: null }],
      subject: "Quote follow-up",
      snippet: "Hello there",
      sentAt: "2026-10-02T07:59:00.000Z",
      hasAttachments: true,
      skip: false,
    });
    expect(parseGraphMessage(msg, "me@brandigade.com", "sentitems").direction).toBe("outbound");
    expect(parseGraphMessage({ ...msg, from: { emailAddress: { address: "me@brandigade.com" } } }, "me@brandigade.com").direction).toBe("outbound");
    expect(parseGraphMessage({ ...msg, isDraft: true }, "x@y.z").skip).toBe(true);
    expect(parseGraphMessage({ ...msg, "@removed": { reason: "deleted" } }, "x@y.z").skip).toBe(true);
    expect(parseGraphMessage(msg, "x@y.z", undefined, ["fld-inbox"]).skip).toBe(true);
    expect(graphBodies(msg)).toEqual({ text: null, html: "<b>Hi</b>" });
    expect(graphBodies({ ...msg, body: { contentType: "text", content: "plain" } })).toEqual({ text: "plain", html: null });
  });
});

describe("participant matching", () => {
  it("is case-insensitive and never matches the mailbox's own address", async () => {
    const { repo, db } = memoryRepo();
    __setEmailRepoForTests(repo);
    db.contacts.push(
      { id: "c-maya", workspace_id: "ws", email_normalized: "maya@cedar.example" },
      { id: "c-dup", workspace_id: "ws", email_normalized: "maya@cedar.example" },
      { id: "c-me", workspace_id: "ws", email_normalized: "eddie@brandigade.com" },
      { id: "c-other-ws", workspace_id: "ws2", email_normalized: "sam@north.example" },
    );
    const m = { from: { email: "MAYA@Cedar.Example", name: null }, to: [{ email: "eddie@brandigade.com", name: null }], cc: [{ email: "sam@north.example", name: null }], bcc: [] };
    expect(participants(m, ["Eddie@Brandigade.com"])).toEqual(["maya@cedar.example", "sam@north.example"]);
    expect(await matchLeads("ws", "EDDIE@brandigade.com", [m, { from: null, to: [], cc: [], bcc: [] }])).toEqual([["c-dup", "c-maya"], []]);
  });
});

describe("HTML sanitization", () => {
  it("removes scripts, styles, event handlers, forms, frames and objects", () => {
    const dirty = `<html><head><title>T</title><style>body{color:red}</style><script>alert(1)</script></head>
      <body onload="evil()"><p onclick="x()" style="color:#333; background:url(javascript:alert(1)); position:fixed">Hi <b>there</b></p>
      <img src="https://img.example/a.png" onerror="alert(1)" width="20">
      <iframe src="https://evil"></iframe><object data="x"></object><embed src="y"><form action="https://evil"><input name="p"><button>Go</button></form>
      <svg><script>alert(2)</script></svg><a href="javascript:alert(1)">bad</a><a href="https://ok.example/x">good</a>
      <a href="mailto:a@b.co">mail</a><img src="data:image/png;base64,AAAA"><img src="cid:logo"><meta http-equiv="refresh" content="0;url=https://evil"></body></html>`;
    const clean = sanitizeEmailHtml(dirty)!;
    for (const bad of ["<script", "alert(2)", "<style", "onload", "onclick", "onerror", "<iframe", "<object", "<embed", "<form", "<input", "<button", "<svg", "javascript:", "<meta", "url(", "position", "<title"]) {
      expect(clean).not.toContain(bad);
    }
    expect(clean).toContain('<p style="color:#333">Hi <b>there</b></p>');
    expect(clean).toContain('<img src="https://img.example/a.png" width="20" />');
    expect(clean).toContain('<a href="https://ok.example/x" rel="noopener noreferrer" target="_blank">good</a>');
    expect(clean).toContain('href="mailto:a@b.co"');
    expect(clean).toContain('src="data:image/png;base64,AAAA"');
    expect(clean).toContain('src="cid:logo"');
    expect(sanitizeEmailHtml("<script>only</script>")).toBeNull();
  });
  it("bounds very large HTML and keeps it well-formed", () => {
    const big = "<div>" + "<p>word ".repeat(200_000) + "</div>";
    const clean = sanitizeEmailHtml(big)!;
    expect(clean.length).toBeLessThanOrEqual(400_100);
    expect(clean.endsWith("</div>")).toBe(true);
  });
  it("turns HTML into readable text and bounds text", () => {
    expect(htmlToText("<style>x{}</style><p>Hello&nbsp;<b>Maya</b></p><ul><li>One</li><li>Two</li></ul>Bye<br>now &amp; then")).toBe("Hello Maya\n• One\n• Two\nBye\nnow & then");
    expect(bound("a😀b", 2)).toBe("a");
    expect(makeSnippet("  lots   of\n\nspace ")).toBe("lots of space");
    expect(makeSnippet("x".repeat(1000))).toHaveLength(300);
  });
});
