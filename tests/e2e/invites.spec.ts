import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { admin, api, gotoTab, loginToCrm } from "./helpers.js";

// Inviting an address that already has a login: someone may have registered it
// beforehand to get into the CRM. The test plays that person: they keep a live
// session and know the password, and must lose both once the real owner of the
// mailbox joins from the emailed link. Needs the local SMTP catcher (Mailpit).
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:57324";

async function waitForMail(to: string, timeoutMs = 20_000): Promise<{ ID: string; Text: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found: any = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((r) => r.json());
    if (found.messages?.length) return (await fetch(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`).then((r) => r.json())) as { ID: string; Text: string };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No email to ${to}`);
}

test.describe("inviting someone who already has a login", () => {
  const email = `e2e-join-${Date.now().toString(36)}@crm.test`;
  const oldPassword = crypto.randomBytes(12).toString("base64url");
  let userId = "";

  test.beforeAll(async () => {
    const { data, error } = await admin().auth.admin.createUser({ email, password: oldPassword, email_confirm: true });
    if (error || !data.user) throw error || new Error("createUser failed");
    userId = data.user.id;
  });
  test.afterAll(async () => {
    const db = admin();
    await db.from("workspace_invites").delete().eq("email", email);
    await db.from("workspace_members").delete().eq("user_id", userId);
    await db.auth.admin.deleteUser(userId);
    const found: any = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then((r) => r.json()).catch(() => ({}));
    const ids = (found.messages || []).map((m: { ID: string }) => m.ID);
    if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
  });

  test("they join only from the emailed link, and the old password and sessions stop working", async ({ page, browser, request }) => {
    const features = await (await request.get(api("/config"))).json();
    test.skip(!features.features?.notifications, "No email sender is configured for this server");

    // Whoever registered the address has a live session the whole time.
    const squatter = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInErr } = await squatter.auth.signInWithPassword({ email, password: oldPassword });
    expect(signInErr).toBeNull();

    await loginToCrm(page, "owner");
    await gotoTab(page, "team");
    await page.locator("#new-invite-email").fill(email);
    await page.locator("#new-invite-role").selectOption("editor");
    await page.locator("#add-invite-btn").click();
    const row = page.locator("#team-tbody tr", { hasText: email });
    await expect(row).toContainText("Invite sent");
    await expect(row).toContainText("editor");

    // Inviting doesn't add the account: not a member until the link is opened.
    const db = admin();
    const members = async () => (await db.from("workspace_members").select("role").eq("user_id", userId)).data || [];
    expect(await members()).toEqual([]);

    const mail = await waitForMail(email);
    const link = /https?:\/\/\S+\/api\/team\/join\?token=[A-Za-z0-9_-]+/.exec(mail.Text)![0];
    // A mail scanner opening the link gets a sign-in redirect but doesn't use the invite up.
    const scanned = await request.get(link, { maxRedirects: 0 });
    expect(scanned.status()).toBe(302);
    expect(scanned.headers()["location"]).toContain("/auth/v1/verify");

    const joinerContext = await browser.newContext();
    const joiner = await joinerContext.newPage();
    await joiner.goto(link);
    await expect(joiner.locator("#auth-reset-view")).toBeVisible({ timeout: 20_000 });
    await expect(joiner.locator("#reset-view-note")).toContainText(`To join, choose a new password for ${email}`);
    expect(await members()).toEqual([]); // still not a member until they finish

    const newPassword = crypto.randomBytes(12).toString("base64url");
    await joiner.locator("#reset-password").fill(newPassword);
    await joiner.locator("#reset-password-confirm").fill(newPassword);
    await joiner.getByRole("button", { name: "Join the team" }).click();
    await expect(joiner.locator("#auth-screen")).toBeHidden({ timeout: 20_000 });
    await expect(joiner.locator("#tab-dashboard")).toBeVisible();
    await expect(joiner.locator("#who-am-i")).toContainText("editor");
    expect(await members()).toEqual([{ role: "editor" }]);

    // The squatter's password and session are gone.
    const fresh = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    expect((await fresh.auth.signInWithPassword({ email, password: oldPassword })).error).not.toBeNull();
    expect((await squatter.auth.refreshSession()).error).not.toBeNull();
    // The real owner's new password works.
    expect((await fresh.auth.signInWithPassword({ email, password: newPassword })).error).toBeNull();

    // The link works once; the owner's Team page shows them as a member now.
    const reused = await request.get(link, { maxRedirects: 0 });
    expect(reused.headers()["location"]).toMatch(/\?join_error=expired$/);
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden({ timeout: 20_000 });
    await gotoTab(page, "team");
    await expect(page.locator("#team-tbody tr", { hasText: email })).not.toContainText("Invite sent");
    await joinerContext.close();
  });

  test("the owner can cancel a pending invite, and its link stops working", async ({ page, request }) => {
    const features = await (await request.get(api("/config"))).json();
    test.skip(!features.features?.notifications, "No email sender is configured for this server");
    const other = `e2e-cancel-${Date.now().toString(36)}@crm.test`;
    const db = admin();
    const { data } = await db.auth.admin.createUser({ email: other, password: crypto.randomBytes(12).toString("base64url"), email_confirm: true });
    try {
      await loginToCrm(page, "owner");
      await gotoTab(page, "team");
      await page.locator("#new-invite-email").fill(other);
      await page.locator("#add-invite-btn").click();
      const row = page.locator("#team-tbody tr", { hasText: other });
      await expect(row).toContainText("Invite sent");
      const mail = await waitForMail(other);
      const link = /https?:\/\/\S+\/api\/team\/join\?token=[A-Za-z0-9_-]+/.exec(mail.Text)![0];
      await row.locator(".btn-del").click();
      await page.getByRole("button", { name: "Cancel invite" }).click();
      await expect(page.locator("#team-tbody tr", { hasText: other })).toHaveCount(0);
      const res = await request.get(link, { maxRedirects: 0 });
      expect(res.headers()["location"]).toMatch(/\?join_error=expired$/);
    } finally {
      await db.from("workspace_invites").delete().eq("email", other);
      if (data.user) await db.auth.admin.deleteUser(data.user.id);
    }
  });
});
