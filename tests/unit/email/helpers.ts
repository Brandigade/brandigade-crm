import { randomBytes, randomUUID } from "node:crypto";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { createRouter } from "../../../lib/server/router.js";
import { emailRoutes } from "../../../lib/server/email/routes.js";
import { __setEmailRepoForTests, type AccountRow } from "../../../lib/server/email/repo.js";
import { __setEmailFetchForTests } from "../../../lib/server/email/provider-http.js";
import { storeTokens } from "../../../lib/server/email/tokens.js";
import { fakeSupabase } from "../core/fake-supabase.js";
import { memoryRepo, newAccount } from "../../fakes/email/memory-repo.js";
import { FakeGoogle } from "../../fakes/email/fake-google.js";
import { FakeMicrosoft } from "../../fakes/email/fake-microsoft.js";

export const WS = "11111111-1111-4111-8111-111111111111";
export const USERS = {
  owner: { id: "aaaaaaaa-0000-4000-8000-000000000001", token: "tok-owner", role: "owner" },
  editor: { id: "aaaaaaaa-0000-4000-8000-000000000002", token: "tok-editor", role: "editor" },
  editor2: { id: "aaaaaaaa-0000-4000-8000-000000000003", token: "tok-editor2", role: "editor" },
  viewer: { id: "aaaaaaaa-0000-4000-8000-000000000004", token: "tok-viewer", role: "viewer" },
} as const;
export type Who = keyof typeof USERS;

const ENV_KEYS = [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_URL", "TOKEN_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_AUTH_URL", "GOOGLE_TOKEN_URL", "GOOGLE_REVOKE_URL", "GMAIL_API_BASE",
  "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID", "MICROSOFT_LOGIN_BASE", "GRAPH_API_BASE",
];

export function setEmailEnv(google: FakeGoogle, microsoft: FakeMicrosoft, appUrl = "https://crm.example") {
  Object.assign(process.env, {
    SUPABASE_URL: "http://sb.test",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    APP_URL: appUrl,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    GOOGLE_CLIENT_ID: google.clientId,
    GOOGLE_CLIENT_SECRET: google.clientSecret,
    GOOGLE_AUTH_URL: "http://google.test/auth",
    GOOGLE_TOKEN_URL: "http://google.test/token",
    GOOGLE_REVOKE_URL: "http://google.test/revoke",
    GMAIL_API_BASE: "http://google.test/gmail/v1",
    MICROSOFT_CLIENT_ID: microsoft.clientId,
    MICROSOFT_CLIENT_SECRET: microsoft.clientSecret,
    MICROSOFT_TENANT_ID: "common",
    MICROSOFT_LOGIN_BASE: "http://ms.test/login",
    GRAPH_API_BASE: "http://ms.test/graph/v1.0",
  });
}

/** One fetch that sends Google URLs to the Google fake and the rest to the Microsoft fake. */
export function providerRouter(google: FakeGoogle, microsoft: FakeMicrosoft) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const host = new URL(req.url).host;
    return host.startsWith("google") ? google.handle(req) : microsoft.handle(req);
  };
}

export function authClient() {
  type U = (typeof USERS)[Who];
  const byToken = new Map<string, U>(Object.values(USERS).map((u) => [u.token, u]));
  const byId = new Map<string, U>(Object.values(USERS).map((u) => [u.id, u]));
  return fakeSupabase(
    {
      "from:workspace_members": (call) => {
        const id = call.filters.find((f) => f[1] === "user_id")?.[2] as string;
        const u = byId.get(id);
        return { data: u ? { workspace_id: WS, role: u.role } : null };
      },
      "from:profiles": () => ({ data: { is_platform_admin: false } }),
    },
    {
      getUser: (t: string) => {
        const u = byToken.get(t);
        return u ? { data: { user: { id: u.id, email: `${u.role}@crm.test` } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } };
      },
    },
  ).client;
}

export function setupEmail(opts: { appUrl?: string } = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const google = new FakeGoogle();
  const microsoft = new FakeMicrosoft();
  setEmailEnv(google, microsoft, opts.appUrl);
  const { repo, db } = memoryRepo();
  db.members = Object.values(USERS).map((u) => ({ workspace_id: WS, user_id: u.id, role: u.role }));
  db.profiles = Object.values(USERS).map((u) => ({ id: u.id, display_name: u.role === "editor" ? "Eddie Editor" : null }));
  __setEmailRepoForTests(repo);
  __setEmailFetchForTests(providerRouter(google, microsoft), { sleep: async () => {} });
  __setAdminClientForTests(authClient());
  const handle = createRouter(emailRoutes);

  async function call(path: string, o: { method?: string; body?: unknown; who?: Who; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (o.who) headers.authorization = `Bearer ${USERS[o.who].token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await handle(
      new Request(`http://crm.local${path}`, { method: o.method || (o.body !== undefined ? "POST" : "GET"), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }),
    );
    const text = await res.text();
    const parse = () => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    };
    return { res, status: res.status, json: parse() as any };
  }

  /** A mailbox that is already connected, with real (fake-issued) encrypted tokens. */
  async function connected(provider: "google" | "microsoft", email: string, who: Who = "editor", fields: Partial<AccountRow> = {}) {
    const account = newAccount({ workspace_id: WS, user_id: USERS[who].id, provider, email_address: email.toLowerCase(), ...fields });
    db.accounts.push(account);
    const t = provider === "google" ? google.issueTokens(email) : microsoft.issueTokens(email);
    await storeTokens(account.id, t);
    return structuredClone(account); // like a row read from the database
  }

  function contact(email: string | null) {
    const c = { id: randomUUID(), workspace_id: WS, email_normalized: email ? email.trim().toLowerCase() : null };
    db.contacts.push(c);
    return c;
  }

  function teardown() {
    __setEmailRepoForTests(null);
    __setEmailFetchForTests(null);
    __setAdminClientForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  return { google, microsoft, db, repo, handle, call, connected, contact, teardown };
}

export type EmailTest = ReturnType<typeof setupEmail>;
