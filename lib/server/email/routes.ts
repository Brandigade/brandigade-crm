import type { Route } from "../router.js";
import { EDITORS, requireAuth, type AuthContext } from "../auth.js";
import { decryptSecret } from "../crypto.js";
import { HttpError, json, notFound } from "../http.js";
import { providerConfigured, providerLabel, urls } from "./config.js";
import { oauthCallback, startOAuth } from "./oauth.js";
import { providerFetch } from "./provider-http.js";
import { repo, type AccountRow } from "./repo.js";
import { sendEmail } from "./send.js";
import { syncAccount } from "./sync.js";

// Email integration routes (Gmail + Outlook). See docs/ARCHITECTURE.md.
//
//   POST /api/email/oauth/start                    connect a mailbox (editors)
//   GET  /api/email/oauth/google/callback          provider redirects here
//   GET  /api/email/oauth/microsoft/callback
//   GET  /api/email/accounts                       my mailboxes
//   POST /api/email/accounts/:id/sync              sync my mailbox now (editors)
//   POST /api/email/accounts/:id/disconnect        disconnect my mailbox
//   POST /api/email/send                           compose / reply (editors)

/** What the browser may know about a mailbox: no tokens, no sync cursor. */
export function publicAccount(a: AccountRow) {
  return {
    id: a.id,
    provider: a.provider,
    email_address: a.email_address,
    display_name: a.display_name,
    status: a.status,
    sharing: a.sharing,
    sync_enabled: a.sync_enabled,
    initial_sync_done: a.initial_sync_done,
    last_synced_at: a.last_synced_at,
    last_error: a.last_error,
    last_error_at: a.last_error_at,
    connected_at: a.connected_at,
    next_sync_at: a.next_sync_at,
    syncing: !!a.sync_lock_until && Date.parse(a.sync_lock_until) > Date.now(),
  };
}

async function ownAccount(auth: AuthContext, id: string): Promise<AccountRow> {
  const account = /^[0-9a-f-]{36}$/i.test(id) ? await repo().getAccount(id) : null;
  // Someone else's mailbox looks exactly like a missing one.
  if (!account || account.user_id !== auth.userId || account.workspace_id !== auth.workspaceId) throw notFound("Mailbox not found.");
  return account;
}

async function listAccounts(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  const accounts = await repo().listAccounts({ workspaceId: auth.workspaceId, userId: auth.userId });
  return json({ accounts: accounts.filter((a) => a.status !== "disconnected").map(publicAccount) });
}

const INLINE_SYNC_MS = 20_000;

async function syncNow(req: Request, id: string): Promise<Response> {
  const auth = await requireAuth(req, { roles: EDITORS });
  const account = await ownAccount(auth, id);
  if (account.status === "reconnect_required") throw new HttpError(409, "Reconnect this mailbox first.", "reconnect_required");
  if (account.status !== "active") throw new HttpError(409, "This mailbox is disconnected.", "mailbox_unavailable");
  if (!account.sync_enabled) throw new HttpError(409, "Syncing is paused for this mailbox. Turn it back on first.", "sync_paused");
  if (!providerConfigured(account.provider)) throw new HttpError(503, `${providerLabel(account.provider)} isn't set up on the server yet.`, "not_configured");

  await repo().updateAccount(account.id, { next_sync_at: new Date().toISOString() }, { onlyIfStatus: "active" });
  // Run one bounded sync right away, unless a sync is already running.
  const recentlyStarted = account.last_sync_started_at && Date.now() - Date.parse(account.last_sync_started_at) < 10_000;
  const locked = recentlyStarted ? null : await repo().lockAccount(account.id, Math.ceil(INLINE_SYNC_MS / 1000) + 30);
  if (!locked) {
    const fresh = (await repo().getAccount(account.id)) || account;
    return json({ account: publicAccount(fresh), queued: true });
  }
  const result = await syncAccount(locked, { deadline: Date.now() + INLINE_SYNC_MS });
  const fresh = (await repo().getAccount(account.id)) || locked;
  return json({
    account: publicAccount(fresh),
    queued: false,
    result: { ok: result.ok, done: !!result.done, stored: result.stored, examined: result.examined, error: result.ok ? null : fresh.last_error },
  });
}

async function revokeAtGoogle(account: AccountRow): Promise<boolean> {
  const tokens = await repo().getTokens(account.id);
  if (!tokens) return false;
  // Revoking the refresh token also revokes every access token issued from it.
  const enc = tokens.refresh_token_enc || tokens.access_token_enc;
  if (!enc) return false;
  let token: string;
  try {
    token = decryptSecret(enc, account.id);
  } catch {
    return false;
  }
  try {
    const res = await providerFetch(
      urls.googleRevoke(),
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() },
      { retries: 1, timeoutMs: 10_000 },
    );
    await res.body?.cancel().catch(() => {});
    // 400 means Google already considers the token invalid: nothing left to revoke.
    return res.ok || res.status === 400;
  } catch (err) {
    console.warn(`Revoking Google access for mailbox ${account.id} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function disconnect(req: Request, id: string): Promise<Response> {
  // Any member may disconnect their own mailbox (that only ever removes access).
  const auth = await requireAuth(req);
  const account = await ownAccount(auth, id);
  const revoked = account.provider === "google" && providerConfigured("google") ? await revokeAtGoogle(account) : false;
  await repo().deleteTokens(account.id);
  const updated = await repo().updateAccount(account.id, {
    status: "disconnected",
    sync_enabled: false,
    sync_lock_until: null,
    sync_cursor: {},
    initial_sync_done: false,
    consecutive_failures: 0,
    last_error: null,
    last_error_at: null,
  });
  return json({ ok: true, revoked, account: updated ? publicAccount(updated) : null });
}

export const emailRoutes: Route[] = [
  { method: "POST", path: "/api/email/oauth/start", handler: (req) => startOAuth(req) },
  { method: "GET", path: "/api/email/oauth/google/callback", handler: (req) => oauthCallback(req, "google") },
  { method: "GET", path: "/api/email/oauth/microsoft/callback", handler: (req) => oauthCallback(req, "microsoft") },
  { method: "GET", path: "/api/email/accounts", handler: (req) => listAccounts(req) },
  { method: "POST", path: "/api/email/accounts/:id/sync", handler: (req, ctx) => syncNow(req, ctx.params.id) },
  { method: "POST", path: "/api/email/accounts/:id/disconnect", handler: (req, ctx) => disconnect(req, ctx.params.id) },
  { method: "POST", path: "/api/email/send", handler: (req) => sendEmail(req) },
];
