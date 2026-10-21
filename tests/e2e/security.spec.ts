import { expect, test } from "@playwright/test";
import { admin, api, cleanup, gotoTab, login, loginToCrm, tag, userDb } from "./helpers.js";

// Permissions are enforced by the database and the server, not only by the UI:
// these tests go around the UI on purpose.

test.describe("roles and security", () => {
  const prefix = tag("sec");
  test.afterAll(async () => cleanup(prefix));

  test("a viewer reads everything but cannot change anything, even by calling the database directly", async ({ page }) => {
    const db = admin();
    const { data: ws } = await db.from("workspaces").select("id").single();
    await db.from("contacts").insert({ workspace_id: ws!.id, first_name: `${prefix} Seen by viewer` });

    await loginToCrm(page, "viewer");
    await gotoTab(page, "contacts");
    await expect(page.locator("#contacts-tbody tr", { hasText: `${prefix} Seen by viewer` })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New contact" })).toBeDisabled();
    await page.locator("#contacts-tbody tr", { hasText: `${prefix} Seen by viewer` }).click();
    await expect(page.locator("#log-form")).toBeHidden();

    const { db: sb } = await userDb("viewer");
    const wsId = ws!.id;
    const ins = await sb.from("contacts").insert({ workspace_id: wsId, first_name: prefix + " viewer insert" });
    const upd = await sb.from("contacts").update({ first_name: "hacked" }).like("first_name", prefix + "%").select();
    const del = await sb.from("contacts").delete().like("first_name", prefix + "%").select();
    const act = await sb.from("activities").insert({ workspace_id: wsId, type: "note", subject: prefix + " viewer note" });
    const result = { ins: ins.error?.code, upd: upd.data?.length, del: del.data?.length, act: act.error?.code };
    expect(result).toEqual({ ins: "42501", upd: 0, del: 0, act: "42501" });
    const { data } = await db.from("contacts").select("first_name").like("first_name", `${prefix}%`);
    expect(data!.map((r) => r.first_name)).toEqual([`${prefix} Seen by viewer`]);
  });

  test("an editor can't forge system timeline entries or read tokens", async () => {
    const { db: sb } = await userDb("editor");
    const { data: ws } = await sb.from("workspaces").select("id").single();
    const fakeEmail = await sb.from("activities").insert({ workspace_id: ws!.id, type: "email", source: "email", subject: prefix + " fake" });
    const tokens = await sb.from("email_account_tokens").select("*");
    const states = await sb.from("oauth_states").select("*");
    const queue = await sb.from("job_queue").select("*");
    const enqueue = await sb.rpc("enqueue_job", { p_kind: "notify.task_assigned", p_payload: {} });
    const call = await sb.from("calls").insert({ workspace_id: ws!.id, direction: "outbound" });
    const result = [fakeEmail, tokens, states, queue, enqueue, call].map((r: any) => r.error?.code || "allowed");
    expect(result).not.toContain("allowed");
  });

  test("someone who isn't invited sees nothing", async ({ page }) => {
    await login(page, "outsider");
    await expect(page.locator("#auth-noaccess-view")).toBeVisible({ timeout: 20_000 });
    const { db: sb } = await userDb("outsider");
    const tables = ["companies", "contacts", "deals", "tasks", "activities", "calls", "email_messages", "workspace_members"];
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = (await sb.from(t).select("*")).data?.length ?? -1;
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  test("server routes check who is calling", async ({ request }) => {
    expect((await request.post(api("/cron/tick"))).status()).toBe(401);
    expect((await request.post(api("/cron/tick"), { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
    expect((await request.get(api("/cron/daily"))).status()).toBe(401);
    expect((await request.post(api("/team-admin"), { data: { action: "invite", email: "x@y.co" } })).status()).toBe(401);
    expect((await request.post(api("/team-admin"), { headers: { authorization: "Bearer not-a-jwt" }, data: {} })).status()).toBe(401);

    const { token } = await userDb("editor");
    const asEditor = { authorization: `Bearer ${token}` };
    expect((await request.post(api("/team-admin"), { headers: asEditor, data: { action: "invite", email: "x@y.co", role: "editor" } })).status()).toBe(403);
    expect((await request.get(api("/system/status"), { headers: asEditor })).status()).toBe(403);
    const cfg = await (await request.get(api("/config"))).json();
    expect(Object.keys(cfg.features).sort()).toEqual(["calling", "gmail", "notifications", "outlook"]);
    expect(JSON.stringify(cfg)).not.toMatch(/key|secret|token/i);
  });

  test("the cron endpoint runs with the right secret", async ({ request }) => {
    const res = await request.post(api("/cron/tick"), { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("jobs");
    expect(body).toHaveProperty("emailSync");
  });

  test("pages are served with security headers", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).toContain("script-src 'self' https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/");
    // Only the two pinned packages, never the whole CDN.
    expect(h["content-security-policy"]).not.toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net[ ;]/);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    const cfg = await (await request.get("/config.js")).text();
    expect(cfg).toContain("supabaseAnonKey");
    expect(cfg).not.toMatch(/service_role|SERVICE_ROLE|sb_secret/);
    expect((await request.get("/.env.local")).status()).toBe(404);
    expect((await request.get("/scripts/seed-local.ts")).status()).toBe(404);
  });
});
