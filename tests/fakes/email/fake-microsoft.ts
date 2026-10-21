import { createHash, randomBytes } from "node:crypto";
import type { InjectedFailure } from "./fake-google.js";

// An in-process fake of Microsoft identity (v2.0 token endpoint) and the
// Graph mail endpoints the CRM uses. Routes by path, so any base works:
//   <login>/<tenant>/oauth2/v2.0/{authorize,token}
//   <graph>/v1.0/me, /me/mailFolders/..., /me/messages/...

type Folder = "inbox" | "sentitems" | "drafts" | "junkemail" | "deleteditems";

interface Recipient {
  emailAddress: { address: string; name?: string };
}

export interface FakeGraphMessage {
  id: string;
  folder: Folder;
  changeSeq: number;
  conversationId: string;
  internetMessageId: string;
  subject: string;
  from?: Recipient;
  toRecipients: Recipient[];
  ccRecipients: Recipient[];
  bccRecipients: Recipient[];
  receivedDateTime: string;
  sentDateTime: string;
  hasAttachments: boolean;
  bodyPreview: string;
  isDraft: boolean;
  body: { contentType: string; content: string };
  internetMessageHeaders?: { name: string; value: string }[];
}

interface Mailbox {
  email: string;
  displayName: string;
  hasExchange: boolean;
  seq: number;
  messages: FakeGraphMessage[];
  expiredTokens: Set<string>;
}

const FOLDER_IDS: Record<Folder, string> = { inbox: "fld-inbox", sentitems: "fld-sent", drafts: "fld-drafts", junkemail: "fld-junk", deleteditems: "fld-deleted" };
const jsonRes = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
let n = 0;
const nextId = (p: string) => `${p}${(++n).toString(36)}${randomBytes(4).toString("hex")}`;
const rcpt = (s: string): Recipient => {
  const m = /^(.*)<(.+)>$/.exec(s.trim());
  return m ? { emailAddress: { address: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, "") } } : { emailAddress: { address: s.trim() } };
};
const SELECTED = ["id", "conversationId", "internetMessageId", "subject", "from", "sender", "toRecipients", "ccRecipients", "bccRecipients", "receivedDateTime", "sentDateTime", "hasAttachments", "bodyPreview", "isDraft", "parentFolderId"];

export const MICROSOFT_GRANTED_SCOPE = "Mail.Read Mail.Send User.Read openid profile email";

export class FakeMicrosoft {
  clientId = "ms-client-id";
  clientSecret = "ms-client-secret";
  grantedScope = MICROSOFT_GRANTED_SCOPE;
  accessTtlSeconds = 3600;
  pageSize = 50;
  graphBase = "http://ms.test/graph/v1.0";
  codes = new Map<string, { challenge: string; redirectUri: string; email: string; used: boolean }>();
  refreshTokens = new Map<string, { email: string; revoked: boolean }>();
  accessTokens = new Map<string, { email: string; exp: number }>();
  mailboxes = new Map<string, Mailbox>();
  calls: { method: string; path: string; search: URLSearchParams; body?: string; prefer?: string | null }[] = [];
  failures: InjectedFailure[] = [];
  /** Called before every request (tests use it to move the clock). */
  onRequest?: (req: Request, url: URL) => void;
  /** Every refresh returns a new refresh token (like Microsoft); the old one keeps working. */
  issuedRefreshTokens: string[] = [];

  mailbox(email: string): Mailbox {
    const key = email.toLowerCase();
    let m = this.mailboxes.get(key);
    if (!m) {
      m = { email: key, displayName: "Mailbox " + key.split("@")[0], hasExchange: true, seq: 1, messages: [], expiredTokens: new Set() };
      this.mailboxes.set(key, m);
    }
    return m;
  }

  authorize(authUrl: string, email: string): string {
    const p = new URL(authUrl).searchParams;
    if (p.get("client_id") !== this.clientId) throw new Error("fake ms: wrong client_id");
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("fake ms: PKCE missing");
    const code = nextId("mscode-");
    this.codes.set(code, { challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")!, email: email.toLowerCase(), used: false });
    this.mailbox(email);
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state")!);
    return back.toString();
  }

  issueTokens(email: string, ttlSeconds = this.accessTtlSeconds) {
    const refresh = nextId("ms-rt-");
    const access = nextId("ms-at-");
    this.refreshTokens.set(refresh, { email: email.toLowerCase(), revoked: false });
    this.accessTokens.set(access, { email: email.toLowerCase(), exp: Date.now() + ttlSeconds * 1000 });
    this.mailbox(email);
    return { access_token: access, refresh_token: refresh, expires_in: ttlSeconds, scope: this.grantedScope };
  }

  addMessage(
    email: string,
    m: { folder?: Folder; from: string; to?: string[]; cc?: string[]; subject?: string; html?: string; text?: string; daysAgo?: number; internetMessageId?: string; isDraft?: boolean; hasAttachments?: boolean; inReplyTo?: string },
  ): FakeGraphMessage {
    const box = this.mailbox(email);
    const at = new Date(Date.now() - (m.daysAgo ?? 0) * 86400_000).toISOString();
    const id = nextId("AAMk-");
    const msg: FakeGraphMessage = {
      id,
      folder: m.folder ?? "inbox",
      changeSeq: ++box.seq,
      conversationId: nextId("conv-"),
      internetMessageId: m.internetMessageId ?? `<${id}@outlook.example>`,
      subject: m.subject ?? "Hello",
      from: rcpt(m.from),
      toRecipients: (m.to || []).map(rcpt),
      ccRecipients: (m.cc || []).map(rcpt),
      bccRecipients: [],
      receivedDateTime: at,
      sentDateTime: at,
      hasAttachments: !!m.hasAttachments,
      bodyPreview: (m.text || (m.html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 255),
      isDraft: !!m.isDraft,
      body: m.html !== undefined ? { contentType: "html", content: m.html } : { contentType: "text", content: m.text || "" },
      internetMessageHeaders: m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : [],
    };
    box.messages.push(msg);
    return msg;
  }

  /** Makes every delta token issued so far invalid (410 SyncStateNotFound). */
  expireDeltaTokens(email: string) {
    const box = this.mailbox(email);
    for (let i = 0; i <= box.seq; i++) box.expiredTokens.add(String(i));
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
    const at = m && this.accessTokens.get(m[1]);
    if (!at || at.exp < Date.now()) return null;
    return this.mailbox(at.email);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.onRequest?.(req, url);
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.text();
    this.calls.push({ method: req.method, path: url.pathname, search: url.searchParams, body, prefer: req.headers.get("prefer") });
    for (const f of this.failures) {
      if ((f.times ?? 1) > 0 && f.match(req, url)) {
        f.times = (f.times ?? 1) - 1;
        return jsonRes(f.status, f.body ?? { error: { code: "InjectedFailure", message: "Injected failure" } }, f.headers);
      }
    }
    if (/\/oauth2\/v2\.0\/token$/.test(url.pathname) && req.method === "POST") return this.token(new URLSearchParams(body || ""));
    const g = /\/v1\.0\/me(\/.*)?$/.exec(url.pathname);
    if (!g) return jsonRes(404, { error: { code: "NotFound", message: "Unknown path " + url.pathname } });
    this.graphBase = `${url.origin}${url.pathname.slice(0, url.pathname.indexOf("/me"))}`;
    const box = this.userFor(req);
    if (!box) return jsonRes(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } });
    const rest = g[1] || "";
    if (rest === "") return jsonRes(200, { mail: box.email, userPrincipalName: box.email, displayName: box.displayName });
    let m: RegExpExecArray | null;
    if ((m = /^\/mailFolders\/([a-z]+)\/messages\/delta$/.exec(rest))) return this.delta(box, m[1] as Folder, url);
    if ((m = /^\/mailFolders\/([a-z]+)$/.exec(rest))) {
      if (!box.hasExchange) return jsonRes(404, { error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } });
      const id = FOLDER_IDS[m[1] as Folder];
      return id ? jsonRes(200, { id }) : jsonRes(404, { error: { code: "ErrorInvalidIdMalformed" } });
    }
    if (rest === "/messages" && req.method === "GET") return this.search(box, url);
    if (rest === "/messages" && req.method === "POST") return this.createDraft(box, JSON.parse(body || "{}"));
    if ((m = /^\/messages\/([^/]+)\/createReply$/.exec(rest)) && req.method === "POST") return this.createReply(box, decodeURIComponent(m[1]), JSON.parse(body || "{}"));
    if ((m = /^\/messages\/([^/]+)\/send$/.exec(rest)) && req.method === "POST") return this.sendDraft(box, decodeURIComponent(m[1]));
    if ((m = /^\/messages\/([^/]+)$/.exec(rest))) {
      const id = decodeURIComponent(m[1]);
      const msg = box.messages.find((x) => x.id === id);
      if (!msg) return jsonRes(404, { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
      if (req.method === "GET") return jsonRes(200, this.full(msg));
      if (req.method === "PATCH") {
        Object.assign(msg, JSON.parse(body || "{}"));
        return jsonRes(200, this.full(msg));
      }
      if (req.method === "DELETE") {
        box.messages = box.messages.filter((x) => x.id !== id);
        return jsonRes(204);
      }
    }
    return jsonRes(404, { error: { code: "NotFound" } });
  }

  private token(p: URLSearchParams): Response {
    if (p.get("client_id") !== this.clientId || p.get("client_secret") !== this.clientSecret) return jsonRes(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
    if (!p.get("scope")) return jsonRes(400, { error: "invalid_request", error_description: "AADSTS900144: The request body must contain the 'scope' parameter." });
    if (p.get("grant_type") === "authorization_code") {
      const c = this.codes.get(p.get("code") || "");
      if (!c || c.used) return jsonRes(400, { error: "invalid_grant", error_description: "AADSTS70008: The provided authorization code has expired." });
      if (c.redirectUri !== p.get("redirect_uri")) return jsonRes(400, { error: "invalid_request", error_description: "AADSTS50011: redirect URI mismatch" });
      if (createHash("sha256").update(p.get("code_verifier") || "").digest("base64url") !== c.challenge) return jsonRes(400, { error: "invalid_grant", error_description: "AADSTS501481: The Code_Verifier does not match." });
      c.used = true;
      return jsonRes(200, { ...this.issueTokens(c.email), token_type: "Bearer" });
    }
    if (p.get("grant_type") === "refresh_token") {
      const rt = this.refreshTokens.get(p.get("refresh_token") || "");
      if (!rt || rt.revoked) return jsonRes(400, { error: "invalid_grant", error_description: "AADSTS70000: The refresh token has been revoked." });
      const t = this.issueTokens(rt.email);
      this.issuedRefreshTokens.push(t.refresh_token);
      return jsonRes(200, { ...t, token_type: "Bearer" });
    }
    return jsonRes(400, { error: "unsupported_grant_type" });
  }

  private view(msg: FakeGraphMessage, fields = SELECTED): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f === "parentFolderId") out.parentFolderId = FOLDER_IDS[msg.folder];
      else if (f === "sender") out.sender = msg.from;
      else if (f in msg) out[f] = (msg as any)[f];
    }
    return out;
  }

  private full(msg: FakeGraphMessage) {
    return { ...this.view(msg), body: msg.body, internetMessageHeaders: msg.internetMessageHeaders || [] };
  }

  private delta(box: Mailbox, folder: Folder, url: URL): Response {
    const p = url.searchParams;
    let since: string | null = null;
    let after = 0;
    let offset = 0;
    let snapshot = box.seq;
    if (p.get("$deltatoken")) {
      const t = p.get("$deltatoken")!;
      if (box.expiredTokens.has(t)) return jsonRes(410, { error: { code: "SyncStateNotFound", message: "The sync state generation is not found." } });
      after = Number(t);
    } else if (p.get("$skiptoken")) {
      const s = JSON.parse(Buffer.from(p.get("$skiptoken")!, "base64url").toString("utf8"));
      ({ since, after, offset, snapshot } = s);
    } else {
      const f = /receivedDateTime ge (\S+)/.exec(p.get("$filter") || "");
      since = f ? f[1] : null;
    }
    const all = box.messages
      .filter((m) => m.folder === folder && m.changeSeq > after && m.changeSeq <= snapshot && (!since || m.receivedDateTime >= since))
      .sort((a, b) => a.changeSeq - b.changeSeq);
    const page = all.slice(offset, offset + this.pageSize);
    const link = `${this.graphBase}/me/mailFolders/${folder}/messages/delta`;
    const out: Record<string, unknown> = { value: page.map((m) => this.view(m)) };
    if (offset + this.pageSize < all.length) {
      out["@odata.nextLink"] = `${link}?$skiptoken=${Buffer.from(JSON.stringify({ since, after, offset: offset + this.pageSize, snapshot })).toString("base64url")}`;
    } else {
      out["@odata.deltaLink"] = `${link}?$deltatoken=${snapshot}`;
    }
    return jsonRes(200, out);
  }

  private search(box: Mailbox, url: URL): Response {
    const q = url.searchParams.get("$search") || "";
    const m = /participants:(\S+) AND received>=(\d{4}-\d{2}-\d{2})/.exec(q);
    if (!m) return jsonRes(400, { error: { code: "BadRequest", message: "Unsupported search" } });
    const addr = m[1].toLowerCase();
    const since = m[2];
    const top = Number(url.searchParams.get("$top") || 10);
    const skip = Number(url.searchParams.get("$skip") || 0);
    const hits = box.messages.filter((x) => {
      const people = [x.from, ...x.toRecipients, ...x.ccRecipients, ...x.bccRecipients].map((r) => r?.emailAddress.address.toLowerCase());
      return people.includes(addr) && x.receivedDateTime.slice(0, 10) >= since;
    });
    const page = hits.slice(skip, skip + top);
    const out: Record<string, unknown> = { value: page.map((x) => this.view(x)) };
    if (skip + top < hits.length) {
      const next = new URL(url.toString());
      next.searchParams.set("$skip", String(skip + top));
      out["@odata.nextLink"] = `${this.graphBase}/me/messages?${next.searchParams.toString()}`;
    }
    return jsonRes(200, out);
  }

  private createDraft(box: Mailbox, payload: any): Response {
    const msg = this.addMessage(box.email, { folder: "drafts", from: box.email, subject: payload.subject, text: payload.body?.content, isDraft: true });
    msg.toRecipients = payload.toRecipients || [];
    msg.ccRecipients = payload.ccRecipients || [];
    msg.body = { contentType: (payload.body?.contentType || "text").toLowerCase(), content: payload.body?.content || "" };
    return jsonRes(201, this.full(msg));
  }

  private createReply(box: Mailbox, id: string, payload: any): Response {
    const orig = box.messages.find((x) => x.id === id);
    if (!orig) return jsonRes(404, { error: { code: "ErrorItemNotFound" } });
    const draft = this.addMessage(box.email, { folder: "drafts", from: box.email, subject: "RE: " + orig.subject, isDraft: true });
    draft.conversationId = orig.conversationId;
    draft.toRecipients = payload.message?.toRecipients || (orig.from ? [orig.from] : []);
    draft.ccRecipients = payload.message?.ccRecipients || [];
    draft.body = { contentType: "html", content: `<html><head></head><body><hr><div id="quoted">${orig.body.content}</div></body></html>` };
    draft.internetMessageHeaders = [{ name: "In-Reply-To", value: orig.internetMessageId }];
    return jsonRes(201, this.full(draft));
  }

  private sendDraft(box: Mailbox, id: string): Response {
    const msg = box.messages.find((x) => x.id === id);
    if (!msg || !msg.isDraft) return jsonRes(404, { error: { code: "ErrorItemNotFound" } });
    msg.isDraft = false;
    msg.folder = "sentitems";
    msg.sentDateTime = msg.receivedDateTime = new Date().toISOString();
    msg.changeSeq = ++box.seq;
    return jsonRes(202);
  }
}
