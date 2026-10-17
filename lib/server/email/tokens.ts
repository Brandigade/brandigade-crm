import { decryptSecret, encryptSecret } from "../crypto.js";
import { expectJson, ProviderError, type RetryOptions } from "../retry.js";
import { clientCredentials, MICROSOFT_SCOPES, providerLabel, tokenUrl, urls, type Provider } from "./config.js";
import { isRevokedGrant, oauthErrorCode, providerFetch, ReconnectRequiredError } from "./provider-http.js";
import { repo, type AccountRow } from "./repo.js";

// OAuth tokens for a connected mailbox. They are stored encrypted with the
// account id as associated data (so a ciphertext can't be moved to another
// mailbox), refreshed when less than two minutes remain, and never logged.

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

/** Stores freshly issued tokens for a mailbox (connect / reconnect). */
export async function storeTokens(accountId: string, t: TokenResponse): Promise<void> {
  if (!t.refresh_token) throw new Error("No refresh token was issued");
  await repo().upsertTokens({
    account_id: accountId,
    access_token_enc: encryptSecret(t.access_token, accountId),
    refresh_token_enc: encryptSecret(t.refresh_token, accountId),
    access_token_expires_at: new Date(Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000).toISOString(),
    scope: t.scope ? String(t.scope).slice(0, 2000) : null,
  });
}

/** Marks a mailbox as needing a new consent and stops syncing it. */
export async function markReconnectRequired(account: AccountRow, message: string): Promise<void> {
  await repo().updateAccount(
    account.id,
    { status: "reconnect_required", last_error: message, last_error_at: new Date().toISOString(), sync_lock_until: null },
    { onlyIfStatus: "active" },
  );
  account.status = "reconnect_required";
}

export function reconnectMessage(p: Provider): string {
  return `${providerLabel(p)} access was revoked or has expired. Reconnect the mailbox to keep syncing.`;
}

/** POSTs a form to a provider token endpoint. */
export async function tokenRequest(p: Provider, params: Record<string, string>, opts: RetryOptions = {}): Promise<TokenResponse> {
  const { clientId, clientSecret } = clientCredentials(p);
  const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret });
  const res = await providerFetch(
    tokenUrl(p),
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString() },
    opts,
  );
  const json = await expectJson<TokenResponse>(res, `${providerLabel(p)} token endpoint`);
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new ProviderError(502, `${providerLabel(p)} token endpoint: no access token in the response`);
  }
  return json;
}

/**
 * Authorized access to one mailbox for the length of a sync or send. The
 * access token is cached in memory and refreshed (and re-stored) when it is
 * about to expire or the provider says it is no longer valid.
 */
export class MailboxAuth {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(public readonly account: AccountRow) {}

  get provider(): Provider {
    return this.account.provider;
  }

  /** Only the provider's own API host ever receives the bearer token. */
  private apiBase(): string {
    return this.provider === "google" ? urls.gmailApi() : urls.graphApi();
  }

  private async fail(message: string): Promise<never> {
    await markReconnectRequired(this.account, message);
    throw new ReconnectRequiredError(message);
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.expiresAt - Date.now() > REFRESH_MARGIN_MS) return this.token;
    const row = await repo().getTokens(this.account.id);
    if (!row || !row.refresh_token_enc) return this.fail(reconnectMessage(this.provider));
    let access: string | null = null;
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(row.refresh_token_enc, this.account.id);
      if (row.access_token_enc) access = decryptSecret(row.access_token_enc, this.account.id);
    } catch {
      return this.fail("The saved sign-in for this mailbox can't be read any more. Reconnect the mailbox.");
    }
    const expires = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
    if (!force && access && expires - Date.now() > REFRESH_MARGIN_MS) {
      this.token = access;
      this.expiresAt = expires;
      return access;
    }
    return this.refresh(refreshToken);
  }

  private async refresh(refreshToken: string): Promise<string> {
    const params: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
    if (this.provider === "microsoft") params.scope = MICROSOFT_SCOPES.join(" ");
    let t: TokenResponse;
    try {
      t = await tokenRequest(this.provider, params);
    } catch (err) {
      if (err instanceof ProviderError && err.status >= 400 && err.status < 500 && isRevokedGrant(err.body)) {
        return this.fail(reconnectMessage(this.provider));
      }
      if (err instanceof ProviderError && ["invalid_client", "unauthorized_client"].includes(oauthErrorCode(err.body))) {
        throw new Error(`${providerLabel(this.provider)} refused the CRM's app credentials. Ask the CRM owner to check the ${providerLabel(this.provider)} app settings.`, {
          cause: err,
        });
      }
      throw err;
    }
    const expiresAt = Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000;
    const patch: Record<string, string | null> = {
      access_token_enc: encryptSecret(t.access_token, this.account.id),
      access_token_expires_at: new Date(expiresAt).toISOString(),
    };
    // Microsoft rotates refresh tokens: always keep the newest one.
    if (t.refresh_token) patch.refresh_token_enc = encryptSecret(t.refresh_token, this.account.id);
    if (t.scope) patch.scope = String(t.scope).slice(0, 2000);
    await repo().updateTokens(this.account.id, patch);
    this.token = t.access_token;
    this.expiresAt = expiresAt;
    return t.access_token;
  }

  /** fetch() with the mailbox's bearer token; one refresh-and-retry on 401. */
  async fetch(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
    if (!url.startsWith(this.apiBase() + "/")) throw new Error("Refusing to send mailbox credentials to an unexpected host");
    const call = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (!headers.has("Accept")) headers.set("Accept", "application/json");
      return providerFetch(url, { ...init, headers }, opts);
    };
    let res = await call(await this.accessToken());
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      res = await call(await this.accessToken(true));
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        return this.fail(reconnectMessage(this.provider));
      }
    }
    return res;
  }

  /** GET/POST returning parsed JSON (or null for 202/204). */
  async json<T>(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<T> {
    const res = await this.fetch(url, init, opts);
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => {});
      return null as T;
    }
    return expectJson<T>(res, providerLabel(this.provider));
  }
}
