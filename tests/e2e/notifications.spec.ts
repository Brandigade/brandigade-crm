import { expect, test } from "@playwright/test";
import { admin, gotoTab, loginToCrm, users } from "./helpers.js";

// Task notification settings and sender status against the real database and
// Mailpit (local SMTP catcher, used when SMTP_HOST points at it). Leaves the
// shared database as it found it.
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:57324";

async function userId(email: string) {
  const { data } = await admin().from("profiles").select("id").eq("email", email).single();
  return data!.id as string;
}

test.describe("task notification emails", () => {
  test("an editor's choices save straight away and survive a reload", async ({ page }) => {
    const id = await userId(users.editor.email);
    const db = admin();
    const { data: before } = await db.from("user_preferences").select("*").eq("user_id", id).maybeSingle();
    try {
      await loginToCrm(page, "editor");
      await gotoTab(page, "profile");
      const panel = page.locator("#notif-prefs-panel");
      await expect(panel.getByRole("heading", { name: "Email notifications" })).toBeVisible();
      const overdue = page.locator("#np-task_overdue");
      const was = await overdue.isChecked();
      await panel.locator("label.switch:has(#np-task_overdue)").click();
      await expect(page.locator("#notif-save-state")).toHaveText("Saved");
      await page.locator("#np-digest-hour").selectOption("7");
      await expect(page.locator("#notif-save-state")).toHaveText("Saved");
      const { data: row } = await db.from("user_preferences").select("*").eq("user_id", id).single();
      expect(row).toMatchObject({ notify_task_overdue: !was, digest_hour: 7 });

      await page.reload();
      await expect(page.locator("#auth-screen")).toBeHidden({ timeout: 20_000 });
      await gotoTab(page, "profile");
      await expect(page.locator("#np-task_overdue")).toBeChecked({ checked: !was });
      await expect(page.locator("#np-digest-hour")).toHaveValue("7");
    } finally {
      if (before) await db.from("user_preferences").update(before).eq("user_id", id);
      else await db.from("user_preferences").delete().eq("user_id", id);
    }
  });

  test("the owner sees the sender and can send a test email (once a minute)", async ({ page }) => {
    const id = await userId(users.owner.email);
    await loginToCrm(page, "owner");
    await gotoTab(page, "team");
    const status = page.locator("#notif-team-panel");
    await expect(status.getByRole("heading", { name: "Notification emails" })).toBeVisible();
    await expect(status.locator(".setting-label", { hasText: "Sender" })).toBeVisible();

    const features = await (await page.request.get("/api/config")).json();
    test.skip(!features.features?.notifications, "No email sender is configured for this server");
    await gotoTab(page, "profile");
    const startedAt = new Date().toISOString();
    try {
      await page.getByRole("button", { name: "Send me a test email" }).click();
      await expect(page.locator(".notif-test-result")).toContainText(`Sent to ${users.owner.email}`, { timeout: 20_000 });
      await page.getByRole("button", { name: "Send me a test email" }).click();
      await expect(page.locator(".notif-test-result")).toContainText("one test email a minute");
    } finally {
      await admin().from("job_queue").delete().eq("kind", "notify.test_email").like("dedupe_key", `test_email:${id}:%`).gte("created_at", startedAt);
      const found: any = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${users.owner.email} subject:"Test email from"`)}`)
        .then((r) => r.json())
        .catch(() => ({ messages: [] }));
      const ids = (found.messages || []).filter((m: { Created: string }) => m.Created >= startedAt.slice(0, 19)).map((m: { ID: string }) => m.ID);
      if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
    }
  });

  test("viewers manage their own notifications @mobile", async ({ page }) => {
    await loginToCrm(page, "viewer");
    await gotoTab(page, "profile");
    await expect(page.locator("#np-task_reminders")).toBeEnabled();
    await expect(page.locator("#np-timezone")).toBeEnabled();
    await gotoTab(page, "team");
    await expect(page.locator("#notif-team-panel")).toHaveCount(0);
  });
});
