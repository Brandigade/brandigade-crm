import { createHash, randomBytes } from "node:crypto";

// An in-process fake of the parts of Google OAuth and the Gmail API the CRM
// uses. Usable as a fetch implementation (fake.fetch) or behind a local HTTP
// server (tests/fakes/email/serve.ts). Routes by path, so any base URL works:
//   <base>/auth  <base>/token  <base>/revoke  <base>/gmail/v1/users/me/...

export interface FakeGmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  headers: [string, string][];
  text?: string;
  html?: string;
  charset?: string;
  attachments?: string[];
  raw?: string;
}

interface Mailbox {
  email: string;
  historyId: number;
  oldestHistoryId: number;
  messages: FakeGmailMessage[];
  history: { id: number; messageId: string }[];
}

export interface InjectedFailure {
  match: (req: Request, url: URL) => boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times?: number;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let seq = 0;
const nextId = (p: string) => `${p}${(++seq).toString(16).padStart(6, "0")}${randomBytes(3).toString("hex")}`;

export const GOOGLE_FULL_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

export class FakeGoogle {
  clientId = "google-client-id";
  clientSecret = "google-client-secret";
  grantedScope = GOOGLE_FULL_SCOPE;
  issueRefreshToken = true;
  accessTtlSeconds = 3600;
  /** Gmail sometimes replaces the Message-ID of API sends; the CRM must read it back. */
  replaceMessageIdOnSend = true;
  codes = new Map<string, { challenge: string; method: string; redirectUri: string; email: string; used: boolean }>();
  refreshTokens = new Map<string, { email: string; revoked: boolean }>();
  accessTokens = new Map<string, { email: string; exp: number; refresh: string }>();
  mailboxes = new Map<string, Mailbox>();
  calls: { method: string; path: string; search: URLSearchParams; body?: string }[] = [];
  sent: { email: string; raw: string; threadId?: string; id: string }[] = [];
  revoked: string[] = [];
  failures: InjectedFailure[] = [];
  /** Called before every request (tests use it to move the clock). */
  onRequest?: (req: Request, url: URL) => void;

  mailbox(email: string): Mailbox {
    const key = email.toLowerCase();
    let m = this.mailboxes.get(key);
    if (!m) {
      m = { email: key, historyId: 1000, oldestHistoryId: 1, messages: [], history: [] };
      this.mailboxes.set(key, m);
    }
    return m;
  }

  /** Simulates the consent screen: returns the redirect back to the CRM with a code. */
  authorize(authUrl: string, email: string): string {
    const u = new URL(authUrl);
    const p = u.searchParams;
    if (p.get("client_id") !== this.clientId) throw new Error("fake google: wrong client_id");
    if (p.get("response_type") !== "code") throw new Error("fake google: response_type");
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("fake google: PKCE missing");
    const code = nextId("code-");
    this.codes.set(code, { challenge: p.get("code_challenge")!, method: "S256", redirectUri: p.get("redirect_uri")!, email: email.toLowerCase(), used: false });
    this.mailbox(email);
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state")!);
    back.searchParams.set("scope", this.grantedScope);
    return back.toString();
  }

  /** Issues tokens directly (for tests that start with a connected mailbox). */
  issueTokens(email: string, ttlSeconds = this.accessTtlSeconds) {
    const refresh = nextId("g-rt-");
    const access = nextId("g-at-");
    this.refreshTokens.set(refresh, { email: email.toLowerCase(), revoked: false });
    this.accessTokens.set(access, { email: email.toLowerCase(), exp: Date.now() + ttlSeconds * 1000, refresh });
    this.mailbox(email);
    return { access_token: access, refresh_token: refresh, expires_in: ttlSeconds, scope: this.grantedScope };
  }

  addMessage(
    email: string,
    m: {
      from: string;
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      text?: string;
      html?: string;
      charset?: string;
      labels?: string[];
      daysAgo?: number;
      messageId?: string;
      inReplyTo?: string;
      references?: string;
      threadId?: string;
      attachments?: string[];
    },
  ): FakeGmailMessage {
    const box = this.mailbox(email);
    const id = nextId("gm-");
    box.historyId += 1;
    const headers: [string, string][] = [["From", m.from]];
    if (m.to) headers.push(["To", m.to]);
    if (m.cc) headers.push(["Cc", m.cc]);
    if (m.bcc) headers.push(["Bcc", m.bcc]);
    headers.push(["Subject", m.subject ?? "Hello"]);
    headers.push(["Message-ID", m.messageId ?? `<${id}@mail.example>`]);
    if (m.inReplyTo) headers.push(["In-Reply-To", m.inReplyTo]);
    if (m.references) headers.push(["References", m.references]);
    const msg: FakeGmailMessage = {
      id,
      threadId: m.threadId ?? nextId("th-"),
      labelIds: m.labels ?? ["INBOX"],
      internalDate: Date.now() - (m.daysAgo ?? 0) * 86400_000,
      historyId: box.historyId,
      headers,
      text: m.text,
      html: m.html,
      charset: m.charset,
      attachments: m.attachments,
    };
    box.messages.push(msg);
    box.history.push({ id: box.historyId, messageId: id });
    return msg;
  }

  /** Gmail forgets history older than this (history.list then answers 404). */
  expireHistory(email: string) {
    const box = this.mailbox(email);
    box.oldestHistoryId = box.historyId + 1;
    box.historyId += 1;
  }

  revokeAll(email: string) {
    for (const [, v] of this.refreshTokens) if (v.email === email.toLowerCase()) v.revoked = true;
  }

  fail(f: InjectedFailure) {
    this.failures.push({ times: 1, ...f });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return this.handle(req);
  };

  private userFor(req: Request): Mailbox | null {
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") || "");
    if (!m) return null;
    const at = this.accessTokens.get(m[1]);
    if (!at || at.exp < Date.now() || this.refreshTokens.get(at.refresh)?.revoked) return null;
    return this.mailbox(at.email);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.onRequest?.(req, url);
    const body = req.method === "GET" ? undefined : await req.text();
    this.calls.push({ method: req.method, path: url.pathname, search: url.searchParams, body });
    for (const f of this.failures) {
      if ((f.times ?? 1) > 0 && f.match(req, url)) {
        f.times = (f.times ?? 1) - 1;
        return jsonRes(f.status, f.body ?? { error: { code: f.status, message: "Injected failure" } }, f.headers);
      }
    }
    const path = url.pathname;
    if (path.endsWith("/token") && req.method === "POST") return this.token(new URLSearchParams(body || ""));
    if (path.endsWith("/revoke") && req.method === "POST") {
      const token = new URLSearchParams(body || "").get("token") || "";
      const rt = this.refreshTokens.get(token);
      if (!rt) return jsonRes(400, { error: "invalid_token" });
      rt.revoked = true;
      this.revoked.push(token);
      return jsonRes(200, {});
    }
    const api = /\/gmail\/v1\/users\/me(\/.*)$/.exec(path);
    if (!api) return jsonRes(404, { error: { code: 404, message: "Unknown path " + path } });
    const box = this.userFor(req);
    if (!box) return jsonRes(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
    const rest = api[1];
    if (rest === "/profile") return jsonRes(200, { emailAddress: box.email, historyId: String(box.historyId), messagesTotal: box.messages.length });
    if (rest === "/messages" && req.method === "GET") return this.list(box, url.searchParams);
    if (rest === "/messages/send" && req.method === "POST") return this.send(box, JSON.parse(body || "{}"));
    const get = /^\/messages\/([^/]+)$/.exec(rest);
    if (get && req.method === "GET") return this.get(box, decodeURIComponent(get[1]), url.searchParams);
    if (rest === "/history") return this.historyList(box, url.searchParams);
    return jsonRes(404, { error: { code: 404, message: "Not found" } });
  }

  private token(p: URLSearchParams): Response {
    if (p.get("client_id") !== this.clientId || p.get("client_secret") !== this.clientSecret) return jsonRes(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
    if (p.get("grant_type") === "authorization_code") {
      const c = this.codes.get(p.get("code") || "");
      if (!c || c.used) return jsonRes(400, { error: "invalid_grant", error_description: "Malformed auth code." });
      if (c.redirectUri !== p.get("redirect_uri")) return jsonRes(400, { error: "redirect_uri_mismatch" });
      const verifier = p.get("code_verifier") || "";
      if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return jsonRes(400, { error: "invalid_grant", error_description: "Invalid code verifier." });
      c.used = true;
      const t = this.issueTokens(c.email);
      const idToken = [b64url(JSON.stringify({ alg: "none" })), b64url(JSON.stringify({ email: c.email, email_verified: true })), ""].join(".");
      return jsonRes(200, { ...t, ...(this.issueRefreshToken ? {} : { refresh_token: undefined }), token_type: "Bearer", id_token: idToken });
    }
    if (p.get("grant_type") === "refresh_token") {
      const rt = this.refreshTokens.get(p.get("refresh_token") || "");
      if (!rt || rt.revoked) return jsonRes(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const access = nextId("g-at-");
      this.accessTokens.set(access, { email: rt.email, exp: Date.now() + this.accessTtlSeconds * 1000, refresh: p.get("refresh_token")! });
      return jsonRes(200, { access_token: access, expires_in: this.accessTtlSeconds, scope: this.grantedScope, token_type: "Bearer" });
    }
    return jsonRes(400, { error: "unsupported_grant_type" });
  }

  private matches(m: FakeGmailMessage, q: string): boolean {
    const labels = m.labelIds;
    if (labels.includes("SPAM") || labels.includes("TRASH")) return false;
    if (/-in:drafts/.test(q) && labels.includes("DRAFT")) return false;
    if (/-in:chats/.test(q) && labels.includes("CHAT")) return false;
    const newer = /newer_than:(\d+)d/.exec(q);
    if (newer && m.internalDate < Date.now() - Number(newer[1]) * 86400_000) return false;
    const group = /\{from:(\S+) to:\S+ cc:\S+ bcc:\S+\}/.exec(q);
    if (group) {
      const addr = group[1].toLowerCase();
      const hay = m.headers
        .filter(([k]) => ["from", "to", "cc", "bcc"].includes(k.toLowerCase()))
        .map(([, v]) => v.toLowerCase())
        .join(" ");
      if (!hay.includes(addr)) return false;
    }
    return true;
  }

  private list(box: Mailbox, p: URLSearchParams): Response {
    const q = p.get("q") || "";
    const max = Math.min(500, Number(p.get("maxResults") || 100));
    const offset = Number(p.get("pageToken") || 0);
    const all = box.messages.filter((m) => this.matches(m, q)).sort((a, b) => b.internalDate - a.internalDate);
    const page = all.slice(offset, offset + max);
    const out: Record<string, unknown> = { resultSizeEstimate: all.length };
    if (page.length) out.messages = page.map((m) => ({ id: m.id, threadId: m.threadId }));
    if (offset + max < all.length) out.nextPageToken = String(offset + max);
    return jsonRes(200, out);
  }

  private payload(m: FakeGmailMessage, format: string, wanted: string[]) {
    const headers = m.headers.map(([name, value]) => ({ name, value }));
    if (format === "metadata") {
      const set = new Set(wanted.map((w) => w.toLowerCase()));
      return { mimeType: "multipart/mixed", headers: headers.filter((h) => !set.size || set.has(h.name.toLowerCase())) };
    }
    const cs = m.charset || "utf-8";
    const enc = (s: string) => (cs.toLowerCase() === "utf-8" ? Buffer.from(s, "utf8") : Buffer.from(s, "latin1")).toString("base64url");
    const alt: any[] = [];
    if (m.text !== undefined) alt.push({ partId: "0.0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: `text/plain; charset="${cs}"` }], body: { size: m.text.length, data: enc(m.text) } });
    if (m.html !== undefined) alt.push({ partId: "0.1", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: `text/html; charset="${cs}"` }], body: { size: m.html.length, data: enc(m.html) } });
    const parts: any[] = [{ partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: alt }];
    for (const [i, f] of (m.attachments || []).entries()) {
      parts.push({ partId: String(i + 1), mimeType: "application/pdf", filename: f, headers: [{ name: "Content-Disposition", value: `attachment; filename="${f}"` }], body: { size: 100, attachmentId: "att-" + i } });
    }
    return { mimeType: "multipart/mixed", headers, body: { size: 0 }, parts };
  }

  private get(box: Mailbox, id: string, p: URLSearchParams): Response {
    const m = box.messages.find((x) => x.id === id);
    if (!m) return jsonRes(404, { error: { code: 404, message: "Requested entity was not found." } });
    const format = p.get("format") || "full";
    const snippet = (m.text || (m.html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120).replace(/'/g, "&#39;");
    return jsonRes(200, {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds,
      snippet,
      historyId: String(m.historyId),
      internalDate: String(m.internalDate),
      payload: this.payload(m, format, p.getAll("metadataHeaders")),
    });
  }

  private historyList(box: Mailbox, p: URLSearchParams): Response {
    const start = Number(p.get("startHistoryId") || 0);
    if (!start || start < box.oldestHistoryId) return jsonRes(404, { error: { code: 404, message: "Requested entity was not found." } });
    const max = Math.min(500, Number(p.get("maxResults") || 100));
    const offset = Number(p.get("pageToken") || 0);
    const recs = box.history.filter((h) => h.id > start);
    const page = recs.slice(offset, offset + max).map((h) => {
      const m = box.messages.find((x) => x.id === h.messageId)!;
      return { id: String(h.id), messages: [{ id: m.id, threadId: m.threadId }], messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] };
    });
    const out: Record<string, unknown> = { historyId: String(box.historyId) };
    if (page.length) out.history = page;
    if (offset + max < recs.length) out.nextPageToken = String(offset + max);
    return jsonRes(200, out);
  }

  private send(box: Mailbox, body: { raw?: string; threadId?: string }): Response {
    if (!body.raw) return jsonRes(400, { error: { code: 400, message: "Invalid raw" } });
    const raw = Buffer.from(body.raw, "base64url").toString("utf8");
    const [head] = raw.split("\r\n\r\n");
    const unfolded = head.replace(/\r\n[ \t]+/g, " ");
    const headers: [string, string][] = unfolded.split("\r\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string];
    });
    const id = nextId("gm-");
    if (this.replaceMessageIdOnSend) {
      const i = headers.findIndex(([k]) => k.toLowerCase() === "message-id");
      if (i >= 0) headers[i] = ["Message-ID", `<gmail-${id}@mail.gmail.com>`];
    }
    const textPart = /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
    box.historyId += 1;
    const msg: FakeGmailMessage = {
      id,
      threadId: body.threadId || nextId("th-"),
      labelIds: ["SENT"],
      internalDate: Date.now(),
      historyId: box.historyId,
      headers,
      text: textPart ? Buffer.from(textPart[1].replace(/\r\n/g, ""), "base64").toString("utf8") : "",
      raw,
    };
    box.messages.push(msg);
    box.history.push({ id: box.historyId, messageId: id });
    this.sent.push({ email: box.email, raw, threadId: body.threadId, id });
    return jsonRes(200, { id, threadId: msg.threadId, labelIds: ["SENT"] });
  }
}
