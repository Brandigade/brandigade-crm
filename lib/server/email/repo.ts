import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "../supabase.js";
import type { Provider } from "./config.js";
import type { Addr } from "./addresses.js";

// Everything the email integration reads or writes in the database, in one
// place. The server tables (tokens, OAuth state, sends) are only reachable
// with the service role, so every method here is called after the route or
// worker has checked who is asking. Tests swap in an in-memory version.

export type AccountStatus = "active" | "reconnect_required" | "error" | "disconnected";

export interface AccountRow {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: Provider;
  email_address: string;
  display_name: string | null;
  status: AccountStatus;
  sharing: "team" | "private";
  sync_enabled: boolean;
  sync_cursor: Record<string, any>;
  initial_sync_done: boolean;
  last_synced_at: string | null;
  last_sync_started_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_sync_at: string;
  sync_lock_until: string | null;
  connected_at: string;
}

export interface TokenRow {
  account_id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
}

export interface OAuthStateRow {
  state_hash: string;
  user_id: string;
  workspace_id: string;
  provider: Provider;
  code_verifier_enc: string;
  return_to: string | null;
  expires_at: string;
  created_at?: string;
}

export interface MessageRow {
  id?: string;
  workspace_id: string;
  account_id: string;
  owner_user_id: string;
  provider: Provider;
  provider_message_id: string;
  provider_thread_id: string | null;
  internet_message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  direction: "inbound" | "outbound";
  from_address: string | null;
  from_name: string | null;
  to_addresses: Addr[];
  cc_addresses: Addr[];
  bcc_addresses: Addr[];
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  has_attachments: boolean;
  sent_at: string;
  visibility: "team" | "private";
  matched_contact_ids: string[];
}

/** What sync needs to know about a copy it already stored. */
export type StoredMessage = Pick<
  MessageRow,
  "provider_message_id" | "internet_message_id" | "matched_contact_ids" | "from_address" | "to_addresses" | "cc_addresses" | "bcc_addresses"
> & { id: string };

export interface SendRow {
  id: string;
  workspace_id: string;
  account_id: string | null;
  user_id: string;
  client_request_id: string;
  contact_id: string | null;
  in_reply_to_message_id: string | null;
  to_addresses: Addr[];
  cc_addresses: Addr[];
  subject: string | null;
  body_text: string | null;
  status: "pending" | "sent" | "failed";
  provider_message_id: string | null;
  email_message_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface ContactMatch {
  id: string;
  email_normalized: string;
}

export interface EmailRepo {
  insertOAuthState(row: OAuthStateRow): Promise<void>;
  /** Returns the state without using it up (the /launch step). */
  peekOAuthState(stateHash: string): Promise<OAuthStateRow | null>;
  /** Deletes and returns the state (single use: a second call gets null). */
  takeOAuthState(stateHash: string): Promise<OAuthStateRow | null>;
  deleteExpiredOAuthStates(userId: string): Promise<void>;
  memberRole(workspaceId: string, userId: string): Promise<string | null>;
  userDisplayName(userId: string): Promise<string | null>;

  upsertAccount(row: Partial<AccountRow> & Pick<AccountRow, "workspace_id" | "user_id" | "provider" | "email_address">): Promise<AccountRow>;
  getAccount(id: string): Promise<AccountRow | null>;
  listAccounts(filter: { workspaceId: string; userId?: string; statuses?: AccountStatus[] }): Promise<AccountRow[]>;
  /** Updates the account; with `onlyIfStatus`, only when it still has that status. */
  updateAccount(id: string, patch: Partial<AccountRow>, opts?: { onlyIfStatus?: AccountStatus }): Promise<AccountRow | null>;
  claimAccounts(limit: number, leaseSeconds: number): Promise<AccountRow[]>;
  /** Locks one active mailbox for a sync, unless someone else holds the lock. */
  lockAccount(id: string, leaseSeconds: number): Promise<AccountRow | null>;

  getTokens(accountId: string): Promise<TokenRow | null>;
  upsertTokens(row: TokenRow): Promise<void>;
  /** Updates existing tokens only (a disconnected mailbox's tokens are never recreated). */
  updateTokens(accountId: string, patch: Partial<TokenRow>): Promise<void>;
  deleteTokens(accountId: string): Promise<void>;

  contactsByEmails(workspaceId: string, emails: string[]): Promise<ContactMatch[]>;
  /** The team's own addresses (members, connected mailboxes) and internal domains: never matched as leads. */
  internalAddresses?(workspaceId: string): Promise<{ emails: string[]; domains: string[] }>;
  getContact(id: string): Promise<{ id: string; workspace_id: string; email_normalized: string | null } | null>;

  storedMessages(accountId: string, providerIds: string[]): Promise<StoredMessage[]>;
  /** Inserts new copies; rows that already exist are left alone. */
  insertMessages(rows: MessageRow[]): Promise<void>;
  updateMessage(id: string, patch: Partial<MessageRow>): Promise<void>;
  getMessage(id: string): Promise<(MessageRow & { id: string }) | null>;
  findAccountMessage(accountId: string, internetMessageId: string): Promise<(MessageRow & { id: string }) | null>;

  getSend(userId: string, clientRequestId: string): Promise<SendRow | null>;
  /** Null when a send with this client request id already exists. */
  insertSend(row: Omit<SendRow, "id" | "created_at" | "sent_at" | "provider_message_id" | "email_message_id" | "error">): Promise<SendRow | null>;
  updateSend(id: string, patch: Partial<SendRow>, opts?: { onlyIfStatus?: SendRow["status"] }): Promise<SendRow | null>;
  countSendsSince(userId: string, sinceIso: string): Promise<number>;
}

function check<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) {
    const err = new Error(`${what}: ${res.error.message || res.error.code || "database error"}`);
    (err as any).code = res.error.code;
    throw err;
  }
  return res.data;
}

const chunks = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Values that are safe inside a PostgREST in.(...) list.
const SAFE_IN = /^[^\s"(),\\]+$/;

export function supabaseRepo(db: SupabaseClient): EmailRepo {
  return {
    async insertOAuthState(row) {
      check(await db.from("oauth_states").insert(row), "Saving the sign-in attempt");
    },
    async peekOAuthState(stateHash) {
      const res = await db.from("oauth_states").select("*").eq("state_hash", stateHash).maybeSingle();
      return (check(res, "Reading the sign-in attempt") as OAuthStateRow | null) ?? null;
    },
    async takeOAuthState(stateHash) {
      const res = await db.from("oauth_states").delete().eq("state_hash", stateHash).select();
      const rows = check(res, "Reading the sign-in attempt") as OAuthStateRow[] | null;
      return rows && rows.length ? rows[0] : null;
    },
    async deleteExpiredOAuthStates(userId) {
      check(await db.from("oauth_states").delete().eq("user_id", userId).lt("expires_at", new Date().toISOString()), "Pruning sign-in attempts");
    },
    async memberRole(workspaceId, userId) {
      const res = await db.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
      const row = check(res, "Reading the membership") as { role: string } | null;
      return row ? row.role : null;
    },
    async userDisplayName(userId) {
      const res = await db.from("profiles").select("display_name").eq("id", userId).maybeSingle();
      const row = check(res, "Reading the profile") as { display_name: string | null } | null;
      return row?.display_name || null;
    },

    async upsertAccount(row) {
      const res = await db.from("email_accounts").upsert(row, { onConflict: "workspace_id,user_id,provider,email_address" }).select().single();
      return check(res, "Saving the mailbox") as AccountRow;
    },
    async getAccount(id) {
      return check(await db.from("email_accounts").select("*").eq("id", id).maybeSingle(), "Reading the mailbox") as AccountRow | null;
    },
    async listAccounts({ workspaceId, userId, statuses }) {
      let q = db.from("email_accounts").select("*").eq("workspace_id", workspaceId);
      if (userId) q = q.eq("user_id", userId);
      if (statuses) q = q.in("status", statuses);
      return (check(await q.order("connected_at", { ascending: true }), "Reading mailboxes") as AccountRow[]) || [];
    },
    async updateAccount(id, patch, opts = {}) {
      let q = db.from("email_accounts").update(patch).eq("id", id);
      if (opts.onlyIfStatus) q = q.eq("status", opts.onlyIfStatus);
      const rows = check(await q.select(), "Updating the mailbox") as AccountRow[] | null;
      return rows && rows.length ? rows[0] : null;
    },
    async claimAccounts(limit, leaseSeconds) {
      const res = await db.rpc("claim_email_accounts", { p_limit: limit, p_lease_seconds: leaseSeconds });
      return (check(res, "Claiming mailboxes") as AccountRow[]) || [];
    },
    async lockAccount(id, leaseSeconds) {
      const now = new Date();
      const res = await db
        .from("email_accounts")
        .update({ sync_lock_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString(), last_sync_started_at: now.toISOString() })
        .eq("id", id)
        .eq("status", "active")
        .eq("sync_enabled", true)
        .or(`sync_lock_until.is.null,sync_lock_until.lt."${now.toISOString()}"`)
        .select();
      const rows = check(res, "Locking the mailbox") as AccountRow[] | null;
      return rows && rows.length ? rows[0] : null;
    },

    async getTokens(accountId) {
      return check(await db.from("email_account_tokens").select("*").eq("account_id", accountId).maybeSingle(), "Reading tokens") as TokenRow | null;
    },
    async upsertTokens(row) {
      check(await db.from("email_account_tokens").upsert(row, { onConflict: "account_id" }), "Saving tokens");
    },
    async updateTokens(accountId, patch) {
      check(await db.from("email_account_tokens").update(patch).eq("account_id", accountId), "Saving tokens");
    },
    async deleteTokens(accountId) {
      check(await db.from("email_account_tokens").delete().eq("account_id", accountId), "Deleting tokens");
    },

    async contactsByEmails(workspaceId, emails) {
      const list = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => SAFE_IN.test(e));
      const out: ContactMatch[] = [];
      for (const part of chunks(list, 100)) {
        const res = await db.from("contacts").select("id,email_normalized").eq("workspace_id", workspaceId).in("email_normalized", part);
        out.push(...((check(res, "Matching leads") as ContactMatch[]) || []));
      }
      return out;
    },
    async internalAddresses(workspaceId) {
      const [members, accounts, ws] = await Promise.all([
        db.from("workspace_members").select("profiles(email)").eq("workspace_id", workspaceId),
        db.from("email_accounts").select("email_address").eq("workspace_id", workspaceId),
        db.from("workspaces").select("settings").eq("id", workspaceId).maybeSingle(),
      ]);
      const emails = new Set<string>();
      for (const m of (check(members, "Reading the team") as { profiles: { email: string | null } | { email: string | null }[] | null }[]) || []) {
        const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
        if (p?.email) emails.add(p.email.trim().toLowerCase());
      }
      for (const a of (check(accounts, "Reading mailboxes") as { email_address: string }[]) || []) emails.add(a.email_address.trim().toLowerCase());
      const settings = ((check(ws, "Reading settings") as { settings?: Record<string, unknown> } | null)?.settings || {}) as Record<string, unknown>;
      const domains = Array.isArray(settings.internalDomains)
        ? settings.internalDomains
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
            .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d))
        : [];
      return { emails: [...emails], domains };
    },
    async getContact(id) {
      const res = await db.from("contacts").select("id,workspace_id,email_normalized").eq("id", id).maybeSingle();
      return check(res, "Reading the lead") as { id: string; workspace_id: string; email_normalized: string | null } | null;
    },

    async storedMessages(accountId, providerIds) {
      const out: StoredMessage[] = [];
      const ids = [...new Set(providerIds)].filter((i) => SAFE_IN.test(i));
      for (const part of chunks(ids, 100)) {
        const res = await db
          .from("email_messages")
          .select("id,provider_message_id,internet_message_id,matched_contact_ids,from_address,to_addresses,cc_addresses,bcc_addresses")
          .eq("account_id", accountId)
          .in("provider_message_id", part);
        out.push(...((check(res, "Reading stored emails") as StoredMessage[]) || []));
      }
      return out;
    },
    async insertMessages(rows) {
      for (const part of chunks(rows, 10)) {
        const res = await db.from("email_messages").upsert(part, { onConflict: "account_id,provider_message_id", ignoreDuplicates: true });
        check(res, "Storing emails");
      }
    },
    async updateMessage(id, patch) {
      check(await db.from("email_messages").update(patch).eq("id", id), "Updating the email");
    },
    async getMessage(id) {
      return check(await db.from("email_messages").select("*").eq("id", id).maybeSingle(), "Reading the email") as any;
    },
    async findAccountMessage(accountId, internetMessageId) {
      const res = await db
        .from("email_messages")
        .select("*")
        .eq("account_id", accountId)
        .eq("internet_message_id", internetMessageId)
        .order("sent_at", { ascending: true })
        .limit(1);
      const rows = check(res, "Reading the email") as any[] | null;
      return rows && rows.length ? rows[0] : null;
    },

    async getSend(userId, clientRequestId) {
      const res = await db.from("email_sends").select("*").eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle();
      return check(res, "Reading the send") as SendRow | null;
    },
    async insertSend(row) {
      const res = await db.from("email_sends").upsert(row, { onConflict: "user_id,client_request_id", ignoreDuplicates: true }).select();
      const rows = check(res, "Recording the send") as SendRow[] | null;
      return rows && rows.length ? rows[0] : null;
    },
    async updateSend(id, patch, opts = {}) {
      let q = db.from("email_sends").update(patch).eq("id", id);
      if (opts.onlyIfStatus) q = q.eq("status", opts.onlyIfStatus);
      const rows = check(await q.select(), "Updating the send") as SendRow[] | null;
      return rows && rows.length ? rows[0] : null;
    },
    async countSendsSince(userId, sinceIso) {
      const res = await db.from("email_sends").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", sinceIso);
      if (res.error) check(res, "Counting sends");
      return res.count || 0;
    },
  };
}

let override: EmailRepo | null = null;
let cached: { client: SupabaseClient; repo: EmailRepo } | null = null;

export function repo(): EmailRepo {
  if (override) return override;
  const client = adminClient();
  if (!cached || cached.client !== client) cached = { client, repo: supabaseRepo(client) };
  return cached.repo;
}

/** For tests: use an in-memory repo (null restores the Supabase one). */
export function __setEmailRepoForTests(r: EmailRepo | null) {
  override = r;
}
