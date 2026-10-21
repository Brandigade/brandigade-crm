import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAdminClientForTests, __setAnonClientForTests } from "../../../lib/server/supabase.js";
import { EDITORS, OWNER, requireAuth } from "../../../lib/server/auth.js";
import { backoffMs, PermanentJobError, RetryJobLater, runJobs } from "../../../lib/server/jobs.js";
import { requireCronSecret } from "../../../lib/server/cron.js";
import { __setInviteMailerForTests, coreRoutes } from "../../../lib/server/core-routes.js";
import { sha256Hex } from "../../../lib/server/crypto.js";
import { fakeSupabase } from "./fake-supabase.js";

const env = { ...process.env };
beforeEach(() => {
  process.env.SUPABASE_URL = "http://sb.test";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.APP_URL = "https://crm.example";
});
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

const withToken = (t?: string) => new Request("http://x/api/x", { headers: t ? { authorization: `Bearer ${t}` } : {} });

function authFake(role: string | null) {
  return fakeSupabase(
    {
      "from:workspace_members": () => ({ data: role ? { workspace_id: "ws1", role } : null }),
      "from:profiles": () => ({ data: { is_platform_admin: false } }),
    },
    { getUser: (t: string) => (t === "good" ? { data: { user: { id: "u1", email: "u@x.co" } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }) },
  );
}

describe("requireAuth", () => {
  it("rejects missing and invalid tokens", async () => {
    __setAdminClientForTests(authFake("owner").client);
    await expect(requireAuth(withToken())).rejects.toMatchObject({ status: 401 });
    await expect(requireAuth(withToken("forged"))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects people who aren't in the CRM", async () => {
    __setAdminClientForTests(authFake(null).client);
    await expect(requireAuth(withToken("good"))).rejects.toMatchObject({ status: 403 });
  });
  it("enforces roles", async () => {
    __setAdminClientForTests(authFake("viewer").client);
    await expect(requireAuth(withToken("good"), { roles: EDITORS })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Viewers") });
    __setAdminClientForTests(authFake("editor").client);
    await expect(requireAuth(withToken("good"), { roles: OWNER })).rejects.toMatchObject({ status: 403 });
    const ctx = await requireAuth(withToken("good"), { roles: EDITORS });
    expect(ctx).toMatchObject({ userId: "u1", workspaceId: "ws1", role: "editor", token: "good" });
  });
});

describe("cron secret", () => {
  it("accepts only the configured secret", () => {
    process.env.CRON_SECRET = "s3cret-s3cret-s3cret-s3cret";
    expect(() => requireCronSecret(withToken("s3cret-s3cret-s3cret-s3cret"))).not.toThrow();
    expect(() => requireCronSecret(withToken("wrong"))).toThrow();
    expect(() => requireCronSecret(withToken())).toThrow();
  });
  it("fails closed when no secret is configured", () => {
    delete process.env.CRON_SECRET;
    expect(() => requireCronSecret(withToken("anything"))).toThrow();
  });
});

describe("runJobs", () => {
  it("records done, skipped, retry with backoff and dead outcomes", async () => {
    const jobs = [
      { id: 1, kind: "k.ok", payload: {}, attempts: 1, max_attempts: 6 },
      { id: 2, kind: "k.skip", payload: {}, attempts: 1, max_attempts: 6 },
      { id: 3, kind: "k.flaky", payload: {}, attempts: 2, max_attempts: 6 },
      { id: 4, kind: "k.flaky", payload: {}, attempts: 6, max_attempts: 6 },
      { id: 5, kind: "k.bad", payload: {}, attempts: 1, max_attempts: 6 },
      { id: 6, kind: "k.later", payload: {}, attempts: 1, max_attempts: 6 },
    ];
    let served = false;
    const { client, calls } = fakeSupabase({
      "rpc:claim_jobs": () => { const out = served ? [] : jobs; served = true; return { data: out }; },
    });
    __setAdminClientForTests(client);
    const summary = await runJobs(
      {
        "k.ok": async () => {},
        "k.skip": async () => ({ status: "skipped", result: { reason: "task gone" } }),
        "k.flaky": async () => { throw new Error("timeout"); },
        "k.bad": async () => { throw new PermanentJobError("no such address"); },
        "k.later": async () => { throw new RetryJobLater(90_000, "rate limited"); },
      },
      { deadline: Date.now() + 60_000 },
    );
    expect(summary).toEqual({ claimed: 6, done: 1, skipped: 1, retried: 2, dead: 2 });
    const updates = Object.fromEntries(calls.filter((c) => c.op === "update").map((c) => [c.filters.find((f) => f[1] === "id")![2], c.args as any]));
    expect(updates[1].status).toBe("done");
    expect(updates[2]).toMatchObject({ status: "skipped", result: { reason: "task gone" } });
    expect(updates[3].status).toBe("retry");
    expect(updates[4].status).toBe("dead");
    expect(updates[5]).toMatchObject({ status: "dead", last_error: "no such address" });
    const later = Date.parse(updates[6].run_after) - Date.now();
    expect(later).toBeGreaterThan(80_000);
    expect(later).toBeLessThan(100_000);
  });
  it("backoff grows and is capped", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});

describe("team-admin", () => {
  const route = coreRoutes.find((r) => r.path === "/api/team-admin")!;
  function teamFake(role = "owner") {
    return fakeSupabase(
      {
        "from:workspace_members:select": (c) => (c.filters.some((f) => f[1] === "user_id" && f[2] === "u1") ? { data: { workspace_id: "ws1", role } } : { data: null }),
        "from:profiles": (c) => (c.filters.some((f) => f[1] === "email") ? { data: null } : { data: { is_platform_admin: false } }),
        "from:workspaces": () => ({ data: { id: "ws1", status: "active" } }),
        "from:workspace_members:insert": () => ({ data: null }),
      },
      { getUser: () => ({ data: { user: { id: "u1", email: "o@x.co" } }, error: null }) },
    );
  }
  const call = (body: unknown) =>
    route.handler(new Request("http://x/api/team-admin", { method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify(body) }), {
      url: new URL("http://x/api/team-admin"),
      params: {},
    });

  it("only the owner may invite", async () => {
    __setAdminClientForTests(teamFake("editor").client);
    await expect(call({ action: "invite", email: "a@b.co", role: "editor" })).rejects.toMatchObject({ status: 403 });
  });
  it("invite links can only lead back into the app", async () => {
    const f = teamFake();
    __setAdminClientForTests(f.client);
    await call({ action: "invite", email: "A@B.co", role: "editor", redirectTo: "https://evil.example/phish" });
    const invite = f.calls.find((c) => c.name === "invite")!.args as any;
    expect(invite.email).toBe("a@b.co");
    expect(invite.opts.redirectTo).toBe("https://crm.example/");
    const f2 = teamFake();
    __setAdminClientForTests(f2.client);
    await call({ action: "invite", email: "c@d.co", role: "viewer", redirectTo: "https://crm.example/?x=1" });
    expect((f2.calls.find((c) => c.name === "invite")!.args as any).opts.redirectTo).toBe("https://crm.example/?x=1");
  });
  it("rejects other workspaces and bad emails", async () => {
    __setAdminClientForTests(teamFake().client);
    await expect(call({ action: "invite", email: "a@b.co", workspaceId: "other" })).rejects.toMatchObject({ status: 400 });
    await expect(call({ action: "invite", email: "not-an-email" })).rejects.toMatchObject({ status: 400 });
    await expect(call({ action: "remove", userId: "u1" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("team-admin invites and existing accounts", () => {
  const route = coreRoutes.find((r) => r.path === "/api/team-admin")!;
  let mailed: { to: string; subject: string; text: string; html: string }[] = [];
  beforeEach(() => {
    mailed = [];
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.NOTIFICATION_FROM_EMAIL = "CRM <crm@x.co>";
    __setInviteMailerForTests(async (msg) => { mailed.push(msg as any); });
  });
  afterEach(() => {
    __setInviteMailerForTests(null);
    __setAnonClientForTests(null);
  });

  function fake(existing: { id: string; confirmed: boolean; memberships?: number; onTeam?: boolean } | null) {
    const seen: string[] = [];
    const f = fakeSupabase(
      {
        "from:workspace_members:select": (c) => {
          if (c.filters.some((x) => x[1] === "user_id" && x[2] === "u1")) return { data: { workspace_id: "ws1", role: "owner" } };
          if (c.filters.some((x) => x[1] === "workspace_id")) return { data: existing?.onTeam ? { user_id: existing.id } : null };
          return { data: null, count: existing?.memberships ?? 0 };
        },
        "from:profiles": (c) => {
          const e = c.filters.find((x) => x[1] === "email");
          if (e) { seen.push(e[0] + ":" + String(e[2])); return { data: existing ? { id: existing.id } : null }; }
          if (c.filters.some((x) => x[1] === "id" && x[2] === "u1")) return { data: { is_platform_admin: false, display_name: "Olivia Owner", email: "o@x.co" } };
          return { data: { is_platform_admin: false } };
        },
        "from:workspaces": () => ({ data: { id: "ws1", status: "active" } }),
        "from:workspace_members:insert": () => ({ data: null }),
        "from:workspace_invites:insert": () => ({ data: { id: "11111111-1111-4111-8111-111111111111" } }),
      },
      {
        getUser: () => ({ data: { user: { id: "u1", email: "o@x.co" } }, error: null }),
        users: existing ? { [existing.id]: { email_confirmed_at: existing.confirmed ? "2026-10-01T00:00:00Z" : null } } : {},
      },
    );
    __setAdminClientForTests(f.client);
    return { ...f, seen };
  }
  const invite = (email: string, role = "editor") =>
    route.handler(
      new Request("http://x/api/team-admin", { method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify({ action: "invite", email, role }) }),
      { url: new URL("http://x/api/team-admin"), params: {} },
    );

  it("matches the address exactly, never as a pattern", async () => {
    const f = fake(null);
    await invite("A_b*c%@X.co");
    expect(f.seen).toEqual(["eq:a_b*c%@x.co"]);
  });
  it("replaces a never-confirmed sign-up with a real invite (no seat squatting)", async () => {
    const f = fake({ id: "squatter", confirmed: false });
    const res = await (await invite("newhire@x.co")).json();
    expect(f.calls.some((c) => c.name === "deleteUser" && c.args === "squatter")).toBe(true);
    expect(f.calls.some((c) => c.name === "invite")).toBe(true);
    expect(res).toMatchObject({ success: true, emailed: true, userId: "new-user" });
  });
  it("never adds an existing account directly: it gets a pending invite and a join link by email", async () => {
    const f = fake({ id: "real", confirmed: true });
    const res = await (await invite("colleague@x.co", "viewer")).json();
    expect(res).toMatchObject({ success: true, pending: true, emailed: true, via: "crm" });
    expect(f.calls.some((c) => c.name === "workspace_members" && c.op === "insert")).toBe(false);
    expect(f.calls.some((c) => c.name === "invite" || c.name === "deleteUser")).toBe(false);
    const row = f.calls.find((c) => c.name === "workspace_invites" && c.op === "insert")!.args as any;
    expect(row).toMatchObject({ workspace_id: "ws1", email: "colleague@x.co", role: "viewer", invited_by: "u1" });
    const days = (Date.parse(row.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // Inviting again replaces the open invite.
    expect(f.calls.some((c) => c.name === "workspace_invites" && c.op === "delete" && c.filters.some((x) => x[1] === "email"))).toBe(true);

    expect(mailed).toHaveLength(1);
    expect(mailed[0]).toMatchObject({ to: "colleague@x.co", subject: "Olivia Owner invited you to Brandigade CRM" });
    const token = /\/api\/team\/join\?token=([A-Za-z0-9_-]+)/.exec(mailed[0].text)![1];
    expect(row.token_hash).toBe(sha256Hex(token)); // only the hash is stored
    expect(mailed[0].html).toContain(`href="https://crm.example/api/team/join?token=${token}"`);
    expect(mailed[0].text).not.toContain("notification settings");
  });
  it("without an email sender, uses Supabase's sign-in email, landing on the join step", async () => {
    delete process.env.SMTP_HOST;
    const otp: any[] = [];
    __setAnonClientForTests({ auth: { signInWithOtp: async (p: unknown) => { otp.push(p); return { data: {}, error: null }; } } } as any);
    const f = fake({ id: "real", confirmed: true });
    const res = await (await invite("colleague@x.co")).json();
    expect(res).toMatchObject({ pending: true, via: "supabase" });
    expect(mailed).toHaveLength(0);
    expect(otp[0].email).toBe("colleague@x.co");
    expect(otp[0].options.shouldCreateUser).toBe(false);
    const token = /^https:\/\/crm\.example\/\?join=([A-Za-z0-9_-]+)$/.exec(otp[0].options.emailRedirectTo)![1];
    expect((f.calls.find((c) => c.name === "workspace_invites" && c.op === "insert")!.args as any).token_hash).toBe(sha256Hex(token));
  });
  it("removes the invite again when the email can't be sent", async () => {
    __setInviteMailerForTests(async () => { throw new Error("The mail server rejected the login"); });
    const f = fake({ id: "real", confirmed: true });
    await expect(invite("colleague@x.co")).rejects.toMatchObject({ status: 400, code: "invite_not_sent" });
    expect(f.calls.some((c) => c.name === "workspace_invites" && c.op === "delete" && c.filters.some((x) => x[1] === "id" && x[2] === "11111111-1111-4111-8111-111111111111"))).toBe(true);
  });
  it("refuses people who are already on the team", async () => {
    fake({ id: "real", confirmed: true, memberships: 1, onTeam: true });
    await expect(invite("colleague@x.co")).rejects.toMatchObject({ status: 400 });
  });
});

describe("joining from an invite link", () => {
  const getRoute = coreRoutes.find((r) => r.path === "/api/team/join" && r.method === "GET")!;
  const postRoute = coreRoutes.find((r) => r.path === "/api/team/join" && r.method === "POST")!;
  const TOKEN = "t".repeat(43);
  const INVITE = { id: "22222222-2222-4222-8222-222222222222", workspace_id: "ws1", email: "colleague@x.co", role: "editor" };

  function fake(opts: { invite?: typeof INVITE | null; email?: string; claimed?: boolean; signOutError?: boolean } = {}) {
    const invite = opts.invite === undefined ? INVITE : opts.invite;
    return fakeSupabase(
      {
        "from:workspace_invites:select": (c) =>
          c.filters.some((x) => x[1] === "token_hash" && x[2] === sha256Hex(TOKEN)) && c.filters.some((x) => x[0] === "is" && x[1] === "accepted_at") ? { data: invite } : { data: null },
        "from:workspace_invites:update": (c) => ((c.args as any).accepted_at && opts.claimed !== false ? { data: [{ id: INVITE.id }] } : { data: [] }),
        "from:workspace_members:insert": () => ({ data: null }),
      },
      {
        getUser: (t: string) => (t === "jwt" ? { data: { user: { id: "u9", email: opts.email ?? "Colleague@X.co" } }, error: null } : { data: { user: null }, error: { message: "bad" } }),
        admin: opts.signOutError ? { signOut: () => ({ error: { message: "boom" } }) } : {},
      },
    );
  }
  const open = (token: string) => getRoute.handler(new Request(`http://x/api/team/join?token=${token}`), { url: new URL(`http://x/api/team/join?token=${token}`), params: {} });
  const NEW_PASSWORD = "correct horse battery";
  const accept = (token: string, jwt = "jwt", password: unknown = NEW_PASSWORD) =>
    postRoute.handler(new Request("http://x/api/team/join", { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify({ token, password }) }), {
      url: new URL("http://x/api/team/join"),
      params: {},
    });

  it("the emailed link signs the person in with a fresh one-time link, landing on the join step", async () => {
    const f = fake();
    __setAdminClientForTests(f.client);
    const res = await open(TOKEN);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://sb.test/auth/v1/verify?token=otp");
    expect(f.calls.find((c) => c.name === "generateLink")!.args).toEqual({ type: "magiclink", email: "colleague@x.co", options: { redirectTo: `https://crm.example/?join=${TOKEN}` } });
    // Opening the link doesn't use the invite up (mail scanners open links too).
    expect(f.calls.some((c) => c.name === "workspace_invites" && c.op === "update")).toBe(false);
  });
  it("expired, used or made-up links go back to the CRM with an explanation", async () => {
    __setAdminClientForTests(fake({ invite: null }).client);
    expect((await open(TOKEN)).headers.get("location")).toBe("https://crm.example/?join_error=expired");
    expect((await open("short")).headers.get("location")).toBe("https://crm.example/?join_error=expired");
  });
  it("joining needs the invited address: anyone else is refused and nothing changes", async () => {
    const f = fake({ email: "attacker@evil.example" });
    __setAdminClientForTests(f.client);
    await expect(accept(TOKEN)).rejects.toMatchObject({ status: 403 });
    await expect(accept(TOKEN, "not-a-jwt")).rejects.toMatchObject({ status: 401 });
    expect(f.calls.some((c) => c.op === "update" || c.op === "insert" || c.name === "updateUserById" || c.name === "signOut")).toBe(false);
  });
  it("joining signs out every other session, replaces the password with the chosen one, then adds the membership", async () => {
    const f = fake();
    __setAdminClientForTests(f.client);
    const res = await (await accept(TOKEN)).json();
    expect(res).toEqual({ joined: true, workspaceId: "ws1", role: "editor", email: "colleague@x.co" });
    const names = f.calls.filter((c) => c.kind === "auth" || c.op === "update" || c.op === "insert").map((c) => c.op && c.kind === "from" ? `${c.name}:${c.op}` : c.name);
    expect(names).toEqual(["workspace_invites:update", "signOut", "updateUserById", "workspace_members:insert"]);
    expect((f.calls.find((c) => c.name === "updateUserById")!.args as any)).toEqual({ id: "u9", attrs: { password: NEW_PASSWORD } });
    expect(f.calls.find((c) => c.name === "signOut")!.args).toEqual({ jwt: "jwt", scope: "others" });
    expect(f.calls.find((c) => c.name === "workspace_members" && c.op === "insert")!.args).toEqual({ workspace_id: "ws1", user_id: "u9", role: "editor", invited: false });
  });
  it("needs a real password before anything changes", async () => {
    const f = fake();
    __setAdminClientForTests(f.client);
    for (const pw of ["", "short", 12345678, "x".repeat(73)]) await expect(accept(TOKEN, "jwt", pw)).rejects.toMatchObject({ status: 400, code: "weak_password" });
    expect(f.calls.some((c) => c.op === "update" || c.name === "updateUserById" || c.name === "signOut")).toBe(false);
  });
  it("an invite works once", async () => {
    const f = fake({ claimed: false });
    __setAdminClientForTests(f.client);
    await expect(accept(TOKEN)).rejects.toMatchObject({ status: 400, code: "invite_expired" });
    expect(f.calls.some((c) => c.name === "updateUserById" || (c.name === "workspace_members" && c.op === "insert"))).toBe(false);
    __setAdminClientForTests(fake({ invite: null }).client);
    await expect(accept(TOKEN)).rejects.toMatchObject({ status: 400, code: "invite_expired" });
  });
  it("if securing the account fails, the invite stays open to try again", async () => {
    const f = fake({ signOutError: true });
    __setAdminClientForTests(f.client);
    await expect(accept(TOKEN)).rejects.toBeTruthy();
    const updates = f.calls.filter((c) => c.name === "workspace_invites" && c.op === "update").map((c) => c.args as any);
    expect(updates[1]).toEqual({ accepted_at: null, accepted_by: null });
    expect(f.calls.some((c) => c.name === "workspace_members" && c.op === "insert")).toBe(false);
  });
});
