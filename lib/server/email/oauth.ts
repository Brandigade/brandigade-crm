import { EDITORS, requireAuth } from "../auth.js";
import { decryptSecret, encryptSecret, pkcePair, randomToken, safeEqual, sha256Hex } from "../crypto.js";
import { appUrl } from "../env.js";
import { badRequest, json, notConfigured, readJson } from "../http.js";
import { expectJson } from "../retry.js";
import { normalizeAddress } from "./addresses.js";
import {
  clientCredentials,
  GOOGLE_SCOPES,
  isProvider,
  MICROSOFT_SCOPES,
  providerConfigured,
  providerLabel,
  redirectUri,
  REQUIRED_SCOPES,
  urls,
  type Provider,
} from "./config.js";
import { providerFetch } from "./provider-http.js";
import { repo } from "./repo.js";
import { storeTokens, tokenRequest, type TokenResponse } from "./tokens.js";

// Connecting a mailbox (OAuth 2.0 authorization code flow with PKCE).
//
//   POST /api/email/oauth/start  {provider}
//     -> creates a single-use state (stored only as its SHA-256), a PKCE
//        verifier and a browser nonce, all bound to the person and expiring in
//        10 minutes. The nonce goes back as an HttpOnly cookie scoped to the
//        OAuth paths; only its hash is stored (inside the encrypted verifier).
//   GET /api/email/oauth/<provider>/callback
//     -> requires that same browser's cookie, consumes the state, exchanges
//        the code (PKCE + client secret), reads the mailbox address, stores the
//        tokens encrypted, and sends the person back to their Profile page.
//
// The cookie stops "account linking" attacks: if someone forwards their
// consent link to a colleague, the colleague's browser doesn't have the
// cookie, so their mailbox can't end up connected to the sender's account.

export const OAUTH_COOKIE = "crm_oauth";
export const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/email/oauth";

/** Error codes the browser understands (js/email.js). Provider text never goes in the URL. */
export type OAuthErrorCode =
  | "invalid_state"
  | "expired"
  | "browser_mismatch"
  | "access_denied"
  | "provider_error"
  | "invalid_request"
  | "not_configured"
  | "forbidden"
  | "token_exchange"
  | "missing_scopes"
  | "no_refresh_token"
  | "no_mailbox"
  | "server_error";

function secureCookies(): boolean {
  const u = new URL(appUrl());
  return !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
}

export function oauthCookie(nonce: string, maxAgeSeconds = STATE_TTL_MS / 1000): string {
  return `${OAUTH_COOKIE}=${nonce}; HttpOnly;${secureCookies() ? " Secure;" : ""} SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}`;
}

export const clearOAuthCookie = () => oauthCookie("", 0);

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function redirectWithCookie(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": clearOAuthCookie(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export const successRedirect = (p: Provider) => `${appUrl()}/?email_connected=${p}#profile`;
export const errorRedirect = (code: OAuthErrorCode) => `${appUrl()}/?email_error=${code}#profile`;

const verifierAad = (stateHash: string) => `oauth:${stateHash}`;

export function authorizationUrl(p: Provider, state: string, challenge: string): string {
  const { clientId } = clientCredentials(p);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(p),
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (p === "google") {
    params.set("scope", GOOGLE_SCOPES.join(" "));
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    params.set("include_granted_scopes", "true");
    return `${urls.googleAuth()}?${params}`;
  }
  params.set("scope", MICROSOFT_SCOPES.join(" "));
  params.set("response_mode", "query");
  params.set("prompt", "select_account");
  return `${urls.microsoftLogin()}/authorize?${params}`;
}

/** POST /api/email/oauth/start */
export async function startOAuth(req: Request): Promise<Response> {
  const auth = await requireAuth(req, { roles: EDITORS });
  const body = await readJson<{ provider?: unknown }>(req, 10_000);
  if (!isProvider(body.provider)) throw badRequest("Choose Gmail or Outlook.", "invalid_provider");
  const provider = body.provider;
  if (!providerConfigured(provider)) throw notConfigured(providerLabel(provider));

  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = pkcePair();
  const stateHash = sha256Hex(state);
  await repo().deleteExpiredOAuthStates(auth.userId).catch(() => {});
  await repo().insertOAuthState({
    state_hash: stateHash,
    user_id: auth.userId,
    workspace_id: auth.workspaceId,
    provider,
    code_verifier_enc: encryptSecret(JSON.stringify({ verifier, nonceHash: sha256Hex(nonce) }), verifierAad(stateHash)),
    return_to: null,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  return json({ url: authorizationUrl(provider, state, challenge) }, { headers: { "Set-Cookie": oauthCookie(nonce) } });
}

export function grantedScopesOk(p: Provider, scope: string | undefined): boolean {
  if (!scope) return p === "microsoft"; // Google always reports what was granted
  const granted = new Set(
    scope
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, ""))
      .filter(Boolean),
  );
  return REQUIRED_SCOPES[p].every((s) => granted.has(s.toLowerCase()));
}

function idTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8"));
    return normalizeAddress(claims.email || claims.preferred_username || "");
  } catch {
    return null;
  }
}

/** The connected mailbox's address (and name), read with the new access token. */
async function mailboxIdentity(p: Provider, t: TokenResponse): Promise<{ email: string; name: string | null } | null> {
  const headers = { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" };
  if (p === "google") {
    const res = await providerFetch(`${urls.gmailApi()}/users/me/profile`, { headers });
    const profile = await expectJson<{ emailAddress?: string }>(res, "Gmail profile");
    const email = normalizeAddress(profile?.emailAddress || "") || idTokenEmail(t.id_token);
    return email ? { email, name: null } : null;
  }
  const prefer = { ...headers, Prefer: 'IdType="ImmutableId"' };
  const res = await providerFetch(`${urls.graphApi()}/me?$select=mail,userPrincipalName,displayName`, { headers: prefer });
  const me = await expectJson<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(res, "Microsoft profile");
  const email = normalizeAddress(me?.mail || "") || normalizeAddress(me?.userPrincipalName || "") || idTokenEmail(t.id_token);
  if (!email) return null;
  // Accounts without an Exchange Online mailbox can sign in but can't sync.
  const inbox = await providerFetch(`${urls.graphApi()}/me/mailFolders/inbox?$select=id`, { headers: prefer });
  await expectJson(inbox, "Outlook mailbox");
  return { email, name: (me?.displayName || "").trim().slice(0, 200) || null };
}

/** GET /api/email/oauth/<provider>/callback */
export async function oauthCallback(req: Request, provider: Provider): Promise<Response> {
  const fail = (code: OAuthErrorCode, detail?: unknown) => {
    if (detail) console.warn(`Mailbox connect (${provider}) failed: ${code}`, detail instanceof Error ? detail.message : detail);
    return redirectWithCookie(errorRedirect(code));
  };
  try {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "";
    if (!state || state.length > 200) return fail("invalid_state");
    const stateHash = sha256Hex(state);
    // Consumed first, so a state can never be used twice, whatever happens next.
    const row = await repo().takeOAuthState(stateHash);
    if (!row || row.provider !== provider) return fail("invalid_state");
    if (!(Date.parse(row.expires_at) > Date.now())) return fail("expired");

    let bound: { verifier?: string; nonceHash?: string };
    try {
      bound = JSON.parse(decryptSecret(row.code_verifier_enc, verifierAad(stateHash)));
    } catch {
      return fail("invalid_state");
    }
    const nonce = readCookie(req, OAUTH_COOKIE);
    if (!nonce || !bound.nonceHash || !bound.verifier || !safeEqual(sha256Hex(nonce), bound.nonceHash)) return fail("browser_mismatch");

    const providerError = url.searchParams.get("error");
    if (providerError) return fail(providerError === "access_denied" ? "access_denied" : "provider_error");
    const code = url.searchParams.get("code") || "";
    if (!code || code.length > 4096) return fail("invalid_request");
    if (!providerConfigured(provider)) return fail("not_configured");
    const role = await repo().memberRole(row.workspace_id, row.user_id);
    if (role !== "owner" && role !== "editor") return fail("forbidden");

    let tokens: TokenResponse;
    try {
      const params: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(provider),
        code_verifier: bound.verifier,
      };
      if (provider === "microsoft") params.scope = MICROSOFT_SCOPES.join(" ");
      tokens = await tokenRequest(provider, params, { retries: 1 });
    } catch (err) {
      return fail("token_exchange", err);
    }
    if (!grantedScopesOk(provider, tokens.scope)) return fail("missing_scopes");
    if (!tokens.refresh_token) return fail("no_refresh_token");

    let identity: { email: string; name: string | null } | null;
    try {
      identity = await mailboxIdentity(provider, tokens);
    } catch (err) {
      return fail("no_mailbox", err);
    }
    if (!identity) return fail("no_mailbox");

    const now = new Date().toISOString();
    const account = await repo().upsertAccount({
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      provider,
      email_address: identity.email,
      display_name: identity.name,
      status: "active",
      sync_enabled: true,
      last_error: null,
      last_error_at: null,
      consecutive_failures: 0,
      next_sync_at: now,
      sync_lock_until: null,
      connected_at: now,
    });
    try {
      await storeTokens(account.id, tokens);
    } catch (err) {
      await repo()
        .updateAccount(account.id, { status: "reconnect_required", last_error: "The connection couldn't be saved. Connect the mailbox again." })
        .catch(() => {});
      return fail("server_error", err);
    }
    return redirectWithCookie(successRedirect(provider));
  } catch (err) {
    console.error(`Mailbox connect (${provider}) failed unexpectedly`, err instanceof Error ? err.message : err);
    return redirectWithCookie(errorRedirect("server_error"));
  }
}
