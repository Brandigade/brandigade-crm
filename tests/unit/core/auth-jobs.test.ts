import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { EDITORS, OWNER, requireAuth } from "../../../lib/server/auth.js";
import { backoffMs, PermanentJobError, RetryJobLater, runJobs } from "../../../lib/server/jobs.js";
import { requireCronSecret } from "../../../lib/server/cron.js";
import { __resetAutoConfirmCache, coreRoutes } from "../../../lib/server/core-routes.js";
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
  function fake(existing: { id: string; confirmed: boolean; memberships?: number } | null) {
    const seen: string[] = [];
    const f = fakeSupabase(
      {
        "from:workspace_members:select": (c) => {
          if (c.filters.some((x) => x[1] === "user_id" && x[2] === "u1")) return { data: { workspace_id: "ws1", role: "owner" } };
          return { data: null, count: existing?.memberships ?? 0 };
        },
        "from:profiles": (c) => {
          const e = c.filters.find((x) => x[1] === "email");
          if (e) { seen.push(e[0] + ":" + String(e[2])); return { data: existing ? { id: existing.id } : null }; }
          return { data: { is_platform_admin: false } };
        },
        "from:workspaces": () => ({ data: { id: "ws1", status: "active" } }),
        "from:workspace_members:insert": () => ({ data: null }),
      },
      {
        getUser: () => ({ data: { user: { id: "u1", email: "o@x.co" } }, error: null }),
        users: existing ? { [existing.id]: { email_confirmed_at: existing.confirmed ? "2026-10-01T00:00:00Z" : null } } : {},
      },
    );
    __setAdminClientForTests(f.client);
    return { ...f, seen };
  }
  const invite = (email: string) =>
    route.handler(
      new Request("http://x/api/team-admin", { method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify({ action: "invite", email, role: "editor" }) }),
      { url: new URL("http://x/api/team-admin"), params: {} },
    );

  it("matches the address exactly, never as a pattern", async () => {
    __resetAutoConfirmCache(false);
    const f = fake(null);
    await invite("A_b*c%@X.co");
    expect(f.seen).toEqual(["eq:a_b*c%@x.co"]);
  });
  it("replaces a never-confirmed sign-up with a real invite (no seat squatting)", async () => {
    __resetAutoConfirmCache(false);
    const f = fake({ id: "squatter", confirmed: false });
    const res = await (await invite("newhire@x.co")).json();
    expect(f.calls.some((c) => c.name === "deleteUser" && c.args === "squatter")).toBe(true);
    expect(f.calls.some((c) => c.name === "invite")).toBe(true);
    expect(res).toMatchObject({ success: true, emailed: true, userId: "new-user" });
  });
  it("adds a confirmed existing account directly", async () => {
    __resetAutoConfirmCache(false);
    const f = fake({ id: "real", confirmed: true });
    const res = await (await invite("colleague@x.co")).json();
    expect(f.calls.some((c) => c.name === "invite" || c.name === "deleteUser")).toBe(false);
    expect(res).toMatchObject({ emailed: false, userId: "real" });
  });
  it("refuses existing accounts when sign-ups are auto-confirmed (confirmation proves nothing)", async () => {
    __resetAutoConfirmCache(true);
    fake({ id: "maybe", confirmed: true });
    await expect(invite("someone@x.co")).rejects.toMatchObject({ status: 400, code: "unverified_account" });
  });
});
