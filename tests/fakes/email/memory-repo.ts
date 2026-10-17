import { randomUUID } from "node:crypto";
import type { AccountRow, ContactMatch, EmailRepo, MessageRow, OAuthStateRow, SendRow, StoredMessage, TokenRow } from "../../../lib/server/email/repo.js";

// An in-memory stand-in for the email tables, with the same semantics the
// Supabase repo relies on (unique keys, conditional updates, claim leases).

export interface MemoryDb {
  oauth_states: OAuthStateRow[];
  members: { workspace_id: string; user_id: string; role: string }[];
  profiles: { id: string; display_name: string | null }[];
  accounts: AccountRow[];
  tokens: TokenRow[];
  contacts: { id: string; workspace_id: string; email_normalized: string | null }[];
  messages: (MessageRow & { id: string })[];
  sends: SendRow[];
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function emptyDb(): MemoryDb {
  return { oauth_states: [], members: [], profiles: [], accounts: [], tokens: [], contacts: [], messages: [], sends: [] };
}

export function newAccount(fields: Partial<AccountRow> & Pick<AccountRow, "workspace_id" | "user_id" | "provider" | "email_address">): AccountRow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    display_name: null,
    status: "active",
    sharing: "team",
    sync_enabled: true,
    sync_cursor: {},
    initial_sync_done: false,
    last_synced_at: null,
    last_sync_started_at: null,
    last_error: null,
    last_error_at: null,
    consecutive_failures: 0,
    next_sync_at: now,
    sync_lock_until: null,
    connected_at: now,
    ...fields,
  };
}

export function memoryRepo(db: MemoryDb = emptyDb()): { repo: EmailRepo; db: MemoryDb } {
  const now = () => Date.now();
  const repo: EmailRepo = {
    async insertOAuthState(row) {
      if (db.oauth_states.some((s) => s.state_hash === row.state_hash)) throw new Error("duplicate state");
      db.oauth_states.push(clone({ ...row, created_at: new Date().toISOString() }));
    },
    async takeOAuthState(hash) {
      const i = db.oauth_states.findIndex((s) => s.state_hash === hash);
      if (i < 0) return null;
      return clone(db.oauth_states.splice(i, 1)[0]);
    },
    async deleteExpiredOAuthStates(userId) {
      db.oauth_states = db.oauth_states.filter((s) => !(s.user_id === userId && Date.parse(s.expires_at) < now()));
    },
    async memberRole(ws, user) {
      return db.members.find((m) => m.workspace_id === ws && m.user_id === user)?.role ?? null;
    },
    async userDisplayName(userId) {
      return db.profiles.find((p) => p.id === userId)?.display_name ?? null;
    },

    async upsertAccount(row) {
      const existing = db.accounts.find(
        (a) => a.workspace_id === row.workspace_id && a.user_id === row.user_id && a.provider === row.provider && a.email_address === row.email_address,
      );
      if (existing) {
        Object.assign(existing, clone(row));
        return clone(existing);
      }
      const a = newAccount(clone(row) as any);
      db.accounts.push(a);
      return clone(a);
    },
    async getAccount(id) {
      return clone(db.accounts.find((a) => a.id === id) ?? null);
    },
    async listAccounts({ workspaceId, userId, statuses }) {
      return clone(
        db.accounts
          .filter((a) => a.workspace_id === workspaceId && (!userId || a.user_id === userId) && (!statuses || statuses.includes(a.status)))
          .sort((x, y) => x.connected_at.localeCompare(y.connected_at)),
      );
    },
    async updateAccount(id, patch, opts = {}) {
      const a = db.accounts.find((x) => x.id === id && (!opts.onlyIfStatus || x.status === opts.onlyIfStatus));
      if (!a) return null;
      Object.assign(a, clone(patch));
      return clone(a);
    },
    async claimAccounts(limit, lease) {
      const due = db.accounts
        .filter((a) => {
          const role = db.members.find((m) => m.workspace_id === a.workspace_id && m.user_id === a.user_id)?.role;
          return (
            a.status === "active" &&
            a.sync_enabled &&
            Date.parse(a.next_sync_at) <= now() &&
            (!a.sync_lock_until || Date.parse(a.sync_lock_until) < now()) &&
            (role === "owner" || role === "editor")
          );
        })
        .sort((x, y) => x.next_sync_at.localeCompare(y.next_sync_at))
        .slice(0, limit);
      for (const a of due) {
        a.sync_lock_until = new Date(now() + lease * 1000).toISOString();
        a.last_sync_started_at = new Date().toISOString();
      }
      return clone(due);
    },
    async lockAccount(id, lease) {
      const a = db.accounts.find((x) => x.id === id);
      if (!a || a.status !== "active" || !a.sync_enabled || (a.sync_lock_until && Date.parse(a.sync_lock_until) >= now())) return null;
      a.sync_lock_until = new Date(now() + lease * 1000).toISOString();
      a.last_sync_started_at = new Date().toISOString();
      return clone(a);
    },

    async getTokens(accountId) {
      return clone(db.tokens.find((t) => t.account_id === accountId) ?? null);
    },
    async upsertTokens(row) {
      const t = db.tokens.find((x) => x.account_id === row.account_id);
      if (t) Object.assign(t, clone(row));
      else db.tokens.push(clone(row));
    },
    async updateTokens(accountId, patch) {
      const t = db.tokens.find((x) => x.account_id === accountId);
      if (t) Object.assign(t, clone(patch));
    },
    async deleteTokens(accountId) {
      db.tokens = db.tokens.filter((t) => t.account_id !== accountId);
    },

    async contactsByEmails(ws, emails) {
      const set = new Set(emails.map((e) => e.toLowerCase()));
      return clone(
        db.contacts.filter((c) => c.workspace_id === ws && c.email_normalized && set.has(c.email_normalized)).map((c) => ({ id: c.id, email_normalized: c.email_normalized! })),
      ) as ContactMatch[];
    },
    async getContact(id) {
      return clone(db.contacts.find((c) => c.id === id) ?? null);
    },

    async storedMessages(accountId, ids) {
      const set = new Set(ids);
      return clone(
        db.messages
          .filter((m) => m.account_id === accountId && set.has(m.provider_message_id))
          .map((m) => ({
            id: m.id,
            provider_message_id: m.provider_message_id,
            internet_message_id: m.internet_message_id,
            matched_contact_ids: m.matched_contact_ids,
            from_address: m.from_address,
            to_addresses: m.to_addresses,
            cc_addresses: m.cc_addresses,
            bcc_addresses: m.bcc_addresses,
          })),
      ) as StoredMessage[];
    },
    async insertMessages(rows) {
      for (const r of rows) {
        if (db.messages.some((m) => m.account_id === r.account_id && m.provider_message_id === r.provider_message_id)) continue;
        db.messages.push({ ...clone(r), id: randomUUID() });
      }
    },
    async updateMessage(id, patch) {
      const m = db.messages.find((x) => x.id === id);
      if (m) Object.assign(m, clone(patch));
    },
    async getMessage(id) {
      return clone(db.messages.find((m) => m.id === id) ?? null);
    },
    async findAccountMessage(accountId, internetId) {
      return clone(db.messages.find((m) => m.account_id === accountId && m.internet_message_id === internetId) ?? null);
    },

    async getSend(userId, crid) {
      return clone(db.sends.find((s) => s.user_id === userId && s.client_request_id === crid) ?? null);
    },
    async insertSend(row) {
      if (db.sends.some((s) => s.user_id === row.user_id && s.client_request_id === row.client_request_id)) return null;
      const s: SendRow = {
        ...clone(row),
        id: randomUUID(),
        created_at: new Date().toISOString(),
        sent_at: null,
        provider_message_id: null,
        email_message_id: null,
        error: null,
      };
      db.sends.push(s);
      return clone(s);
    },
    async updateSend(id, patch, opts = {}) {
      const s = db.sends.find((x) => x.id === id && (!opts.onlyIfStatus || x.status === opts.onlyIfStatus));
      if (!s) return null;
      Object.assign(s, clone(patch));
      return clone(s);
    },
    async countSendsSince(userId, since) {
      return db.sends.filter((s) => s.user_id === userId && s.created_at >= since).length;
    },
  };
  return { repo, db };
}
