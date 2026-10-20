import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, sha256Hex } from "../../../lib/server/crypto.js";
import { MailboxAuth } from "../../../lib/server/email/tokens.js";
import { ReconnectRequiredError } from "../../../lib/server/email/provider-http.js";
import { setupEmail, USERS, WS, type EmailTest } from "./helpers.js";

let t: EmailTest;
beforeEach(() => {
  t = setupEmail();
});
afterEach(() => {
  t.teardown();
  vi.useRealTimers();
});

const cookieOf = (res: Response) => {
  const set = res.headers.get("set-cookie") || "";
  return { raw: set, value: /crm_oauth=([^;]*)/.exec(set)?.[1] ?? null };
};

// Start, then the browser's visit to /launch (which sets the cookie and
// forwards to the provider).
async function start(provider: "google" | "microsoft", who: "editor" | "owner" = "editor") {
  const r = await t.call("/api/email/oauth/start", { body: { provider }, who });
  expect(r.status).toBe(200);
  expect(r.res.headers.get("set-cookie")).toBeNull();
  const launch = new URL(r.json.url as string);
  expect(launch.pathname).toBe("/api/email/oauth/launch");
  const l = await t.call(launch.pathname + launch.search);
  expect(l.status).toBe(302);
  return { url: l.res.headers.get("location") || "", cookie: cookieOf(l.res), launch };
}

async function callback(callbackUrl: string, cookie: string | null) {
  const u = new URL(callbackUrl);
  return t.call(u.pathname + u.search, { headers: cookie ? { cookie: `other=1; crm_oauth=${cookie}` } : {} });
}

const location = (r: { res: Response }) => r.res.headers.get("location") || "";

describe("POST /api/email/oauth/start", () => {
  it("is for editors only and needs the provider to be configured", async () => {
    expect((await t.call("/api/email/oauth/start", { body: { provider: "google" } })).status).toBe(401);
    expect((await t.call("/api/email/oauth/start", { body: { provider: "google" }, who: "viewer" })).status).toBe(403);
    expect((await t.call("/api/email/oauth/start", { body: { provider: "yahoo" }, who: "editor" })).json.code).toBe("invalid_provider");
    delete process.env.GOOGLE_CLIENT_SECRET;
    const r = await t.call("/api/email/oauth/start", { body: { provider: "google" }, who: "editor" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("not_configured");
  });

  it("builds the Google consent URL with PKCE, offline access and the exact scopes", async () => {
    const { url, cookie } = await start("google");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("http://google.test/auth");
    const p = u.searchParams;
    expect(p.get("client_id")).toBe(t.google.clientId);
    expect(p.get("redirect_uri")).toBe("https://crm.example/api/email/oauth/google/callback");
    expect(p.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The state is stored only as a hash, bound to the person, expiring in 10 minutes.
    const state = p.get("state")!;
    expect(t.db.oauth_states).toHaveLength(1);
    const row = t.db.oauth_states[0];
    expect(row.state_hash).toBe(sha256Hex(state));
    expect(JSON.stringify(row)).not.toContain(state);
    expect(row).toMatchObject({ user_id: USERS.editor.id, workspace_id: WS, provider: "google" });
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(row.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    // PKCE: the stored (encrypted) verifier matches the challenge; the cookie's hash is bound too.
    const bound = JSON.parse(decryptSecret(row.code_verifier_enc, `oauth:${row.state_hash}`));
    expect(createHash("sha256").update(bound.verifier).digest("base64url")).toBe(p.get("code_challenge"));
    expect(bound.nonceHash).toBe(sha256Hex(cookie.value!));
    expect(row.code_verifier_enc).not.toContain(bound.verifier);
    // Browser-binding cookie attributes.
    expect(cookie.raw).toMatch(/HttpOnly/);
    expect(cookie.raw).toMatch(/; Secure;/);
    expect(cookie.raw).toMatch(/SameSite=Lax/);
    expect(cookie.raw).toMatch(/Path=\/api\/email\/oauth/);
    expect(cookie.raw).toMatch(/Max-Age=600/);
  });

  it("builds the Microsoft URL for the configured tenant", async () => {
    process.env.MICROSOFT_TENANT_ID = "contoso-tenant";
    const { url } = await start("microsoft");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("http://ms.test/login/contoso-tenant/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid email offline_access User.Read Mail.Read Mail.Send");
    expect(u.searchParams.get("redirect_uri")).toBe("https://crm.example/api/email/oauth/microsoft/callback");
    expect(u.searchParams.get("response_mode")).toBe("query");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("the launch step needs the right browser code, doesn't use the attempt up, and fails safely", async () => {
    const r = await t.call("/api/email/oauth/start", { body: { provider: "google" }, who: "editor" });
    const launch = new URL(r.json.url as string);
    const state = launch.searchParams.get("state")!;
    const wrong = new URL(launch);
    wrong.searchParams.set("n", "someone-else");
    const bad = await t.call(wrong.pathname + wrong.search);
    expect(bad.res.headers.get("location")).toBe("https://crm.example/?email_error=browser_mismatch#profile");
    expect(bad.res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await t.call("/api/email/oauth/launch?state=nope&n=x")).res.headers.get("location")).toBe("https://crm.example/?email_error=invalid_state#profile");
    // Opening it twice is harmless: the attempt is only used up at the callback.
    for (let i = 0; i < 2; i++) {
      const ok = await t.call(launch.pathname + launch.search);
      expect(new URL(ok.res.headers.get("location")!).searchParams.get("state")).toBe(state);
    }
    expect(t.db.oauth_states).toHaveLength(1);
    t.db.oauth_states[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await t.call(launch.pathname + launch.search)).res.headers.get("location")).toBe("https://crm.example/?email_error=expired#profile");
  });

  it("uses the server's own address when it isn't the site's (Supabase Edge Function)", async () => {
    process.env.SERVER_URL = "https://ref.supabase.co/functions/v1";
    const r = await t.call("/api/email/oauth/start", { body: { provider: "google" }, who: "editor" });
    expect(r.json.url).toMatch(/^https:\/\/ref\.supabase\.co\/functions\/v1\/api\/email\/oauth\/launch\?state=/);
    const launch = new URL(r.json.url);
    const l = await t.call(launch.pathname.replace("/functions/v1", "") + launch.search);
    expect(new URL(l.res.headers.get("location")!).searchParams.get("redirect_uri")).toBe("https://ref.supabase.co/functions/v1/api/email/oauth/google/callback");
    expect(l.res.headers.get("set-cookie")).toMatch(/Path=\/functions\/v1\/api\/email\/oauth;/);
    delete process.env.SERVER_URL;
  });

  it("omits Secure only for an http://localhost APP_URL", async () => {
    t.teardown();
    t = setupEmail({ appUrl: "http://localhost:3101" });
    const { cookie } = await start("google");
    expect(cookie.raw).not.toMatch(/Secure/);
    expect(cookie.raw).toMatch(/HttpOnly/);
  });
});

describe("OAuth callback", () => {
  it("connects a Gmail mailbox: tokens encrypted with the account id, status active, cookie cleared", async () => {
    const { url, cookie } = await start("google");
    const r = await callback(t.google.authorize(url, "Eddie@Brandigade.com"), cookie.value);
    expect(r.status).toBe(302);
    expect(location(r)).toBe("https://crm.example/?email_connected=google#profile");
    expect(r.res.headers.get("set-cookie")).toMatch(/crm_oauth=; .*Max-Age=0/);
    expect(t.db.accounts).toHaveLength(1);
    const a = t.db.accounts[0];
    expect(a).toMatchObject({ provider: "google", email_address: "eddie@brandigade.com", user_id: USERS.editor.id, workspace_id: WS, status: "active", sync_enabled: true });
    expect(Date.parse(a.next_sync_at)).toBeLessThanOrEqual(Date.now());
    const tok = t.db.tokens.find((x) => x.account_id === a.id)!;
    expect(tok.refresh_token_enc).toMatch(/^v1\./);
    const rt = decryptSecret(tok.refresh_token_enc!, a.id);
    expect(t.google.refreshTokens.has(rt)).toBe(true);
    expect(() => decryptSecret(tok.refresh_token_enc!, "another-account")).toThrow();
    // The token exchange used PKCE and the client secret.
    const exchange = t.google.calls.find((c) => c.path === "/token")!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("code_verifier")).toBeTruthy();
    expect(form.get("client_secret")).toBe(t.google.clientSecret);
    expect(form.get("redirect_uri")).toBe("https://crm.example/api/email/oauth/google/callback");
    expect(t.db.oauth_states).toHaveLength(0);
  });

  it("connects an Outlook mailbox and keeps the display name", async () => {
    const { url, cookie } = await start("microsoft");
    const r = await callback(t.microsoft.authorize(url, "olivia@brandigade.onmicrosoft.com"), cookie.value);
    expect(location(r)).toBe("https://crm.example/?email_connected=microsoft#profile");
    expect(t.db.accounts[0]).toMatchObject({ provider: "microsoft", email_address: "olivia@brandigade.onmicrosoft.com", display_name: "Mailbox olivia" });
    const form = new URLSearchParams(t.microsoft.calls.find((c) => c.path.endsWith("/token"))!.body);
    expect(form.get("scope")).toContain("Mail.Send");
  });

  it("reconnecting updates the same mailbox row and makes it active again", async () => {
    const first = await start("google");
    await callback(t.google.authorize(first.url, "eddie@brandigade.com"), first.cookie.value);
    t.db.accounts[0].status = "reconnect_required";
    t.db.accounts[0].sync_cursor = { historyId: "55" };
    const second = await start("google");
    await callback(t.google.authorize(second.url, "eddie@brandigade.com"), second.cookie.value);
    expect(t.db.accounts).toHaveLength(1);
    expect(t.db.accounts[0]).toMatchObject({ status: "active", last_error: null, sync_cursor: { historyId: "55" } });
  });

  it("rejects a missing or wrong browser cookie (forwarded consent links can't link someone else's mailbox)", async () => {
    const a = await start("google");
    const r1 = await callback(t.google.authorize(a.url, "victim@example.com"), null);
    expect(location(r1)).toBe("https://crm.example/?email_error=browser_mismatch#profile");
    const b = await start("google");
    const r2 = await callback(t.google.authorize(b.url, "victim@example.com"), "attacker-guess");
    expect(location(r2)).toBe("https://crm.example/?email_error=browser_mismatch#profile");
    // A cookie from a different attempt doesn't fit either.
    const c = await start("google");
    const d = await start("google");
    const r3 = await callback(t.google.authorize(c.url, "victim@example.com"), d.cookie.value);
    expect(location(r3)).toContain("email_error=browser_mismatch");
    expect(t.db.accounts).toHaveLength(0);
    expect(r3.res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("states are single use", async () => {
    const { url, cookie } = await start("google");
    const back = t.google.authorize(url, "eddie@brandigade.com");
    expect(location(await callback(back, cookie.value))).toContain("email_connected=google");
    const again = await callback(back, cookie.value);
    expect(location(again)).toBe("https://crm.example/?email_error=invalid_state#profile");
  });

  it("states expire after 10 minutes", async () => {
    const { url, cookie } = await start("google");
    const back = t.google.authorize(url, "eddie@brandigade.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    expect(location(await callback(back, cookie.value))).toContain("email_error=expired");
    expect(t.db.accounts).toHaveLength(0);
  });

  it("a state started for Google can't finish at the Microsoft callback", async () => {
    const { url, cookie } = await start("google");
    const back = new URL(t.google.authorize(url, "eddie@brandigade.com"));
    back.pathname = "/api/email/oauth/microsoft/callback";
    expect(location(await callback(back.toString(), cookie.value))).toContain("email_error=invalid_state");
    expect(location(await callback(back.toString().replace("microsoft", "google"), cookie.value))).toContain("email_error=invalid_state"); // consumed
  });

  it("unknown states, denied consent and provider errors never echo provider text", async () => {
    expect(location(await callback("https://crm.example/api/email/oauth/google/callback?code=x&state=forged", "c"))).toContain("email_error=invalid_state");
    const { url, cookie } = await start("google");
    const state = new URL(url).searchParams.get("state")!;
    const denied = await callback(`https://crm.example/api/email/oauth/google/callback?state=${state}&error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}`, cookie.value);
    expect(location(denied)).toBe("https://crm.example/?email_error=access_denied#profile");
    const s2 = await start("google");
    const st2 = new URL(s2.url).searchParams.get("state")!;
    const other = await callback(`https://crm.example/api/email/oauth/google/callback?state=${st2}&error=server_error&error_description=Boom`, s2.cookie.value);
    expect(location(other)).toBe("https://crm.example/?email_error=provider_error#profile");
  });

  it("a failed code exchange (bad PKCE verifier) is reported without details", async () => {
    const { url, cookie } = await start("google");
    const back = t.google.authorize(url, "eddie@brandigade.com");
    const code = new URL(back).searchParams.get("code")!;
    t.google.codes.get(code)!.challenge = "tampered";
    const r = await callback(back, cookie.value);
    expect(location(r)).toBe("https://crm.example/?email_error=token_exchange#profile");
  });

  it("refuses consent without the Gmail scopes or without a refresh token", async () => {
    t.google.grantedScope = "openid email https://www.googleapis.com/auth/gmail.readonly";
    const a = await start("google");
    expect(location(await callback(t.google.authorize(a.url, "e@x.io"), a.cookie.value))).toContain("email_error=missing_scopes");
    t.google.grantedScope = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
    t.google.issueRefreshToken = false;
    const b = await start("google");
    expect(location(await callback(t.google.authorize(b.url, "e@x.io"), b.cookie.value))).toContain("email_error=no_refresh_token");
    expect(t.db.accounts).toHaveLength(0);
  });

  it("refuses Microsoft accounts without a mailbox", async () => {
    const { url, cookie } = await start("microsoft");
    t.microsoft.mailbox("nomail@contoso.example").hasExchange = false;
    expect(location(await callback(t.microsoft.authorize(url, "nomail@contoso.example"), cookie.value))).toContain("email_error=no_mailbox");
  });

  it("refuses when the person lost editor rights in the meantime", async () => {
    const { url, cookie } = await start("google");
    t.db.members.find((m) => m.user_id === USERS.editor.id)!.role = "viewer";
    expect(location(await callback(t.google.authorize(url, "e@x.io"), cookie.value))).toContain("email_error=forbidden");
  });
});

describe("token refresh", () => {
  it("refreshes when less than 2 minutes are left, not before", async () => {
    const account = await t.connected("google", "eddie@brandigade.com");
    const row = t.db.tokens.find((x) => x.account_id === account.id)!;
    row.access_token_expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
    const auth = new MailboxAuth(account);
    const first = await auth.accessToken();
    expect(t.google.calls.filter((c) => c.path === "/token")).toHaveLength(0);
    row.access_token_expires_at = new Date(Date.now() + 90_000).toISOString();
    const second = await new MailboxAuth(account).accessToken();
    expect(t.google.calls.filter((c) => c.path === "/token")).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(decryptSecret(t.db.tokens[0].access_token_enc!, account.id)).toBe(second);
    expect(Date.parse(t.db.tokens[0].access_token_expires_at!)).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("stores Microsoft's rotated refresh token on every refresh", async () => {
    const account = await t.connected("microsoft", "olivia@contoso.example");
    t.db.tokens[0].access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    await new MailboxAuth(account).accessToken();
    const rotated = t.microsoft.issuedRefreshTokens.at(-1)!;
    expect(decryptSecret(t.db.tokens[0].refresh_token_enc!, account.id)).toBe(rotated);
    const form = new URLSearchParams(t.microsoft.calls.find((c) => c.path.endsWith("/token"))!.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("scope")).toContain("offline_access");
  });

  it("a 401 from the API triggers one refresh and retry", async () => {
    const account = await t.connected("google", "eddie@brandigade.com");
    t.google.fail({ match: (_r, u) => u.pathname.endsWith("/profile"), status: 401 });
    const auth = new MailboxAuth(account);
    const profile = await auth.json<{ emailAddress: string }>("http://google.test/gmail/v1/users/me/profile");
    expect(profile.emailAddress).toBe("eddie@brandigade.com");
    expect(t.google.calls.filter((c) => c.path === "/token")).toHaveLength(1);
  });

  it("invalid_grant (revoked consent) -> reconnect_required with a human message, and syncing stops", async () => {
    const account = await t.connected("google", "eddie@brandigade.com");
    t.db.tokens[0].access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    t.google.revokeAll("eddie@brandigade.com");
    await expect(new MailboxAuth(account).accessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(t.db.accounts[0]).toMatchObject({ status: "reconnect_required", sync_lock_until: null });
    expect(t.db.accounts[0].last_error).toMatch(/Gmail access was revoked or has expired\. Reconnect/);
    expect(await t.repo.claimAccounts(10, 60)).toHaveLength(0);
  });

  it("missing or unreadable tokens also ask for a reconnect", async () => {
    const account = await t.connected("microsoft", "olivia@contoso.example");
    t.db.tokens[0].refresh_token_enc = "v1.garbage";
    await expect(new MailboxAuth(account).accessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(t.db.accounts[0].status).toBe("reconnect_required");
  });

  it("never sends the bearer token to another host", async () => {
    const account = await t.connected("microsoft", "olivia@contoso.example");
    await expect(new MailboxAuth(account).fetch("https://evil.example/graph/v1.0/me")).rejects.toThrow(/unexpected host/);
  });
});
