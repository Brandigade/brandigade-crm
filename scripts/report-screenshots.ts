// Real screenshots of the CRM for docs/screenshots, taken against the LOCAL stack
// (npm run dev + local Supabase + Mailpit). It creates a small sample lead
// through the UI, photographs the screens, then deletes what it created.
//
//   npx tsx scripts/report-screenshots.ts [http://localhost:3000]
//
// Nothing here talks to production: it refuses to run unless SUPABASE_URL is local.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS helper
import { loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const BASE = process.argv[2] || "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:57324";
const OUT = path.join(root, "docs", "screenshots");
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(process.env.SUPABASE_URL || "")) throw new Error("Only for the local Supabase stack");
fs.mkdirSync(OUT, { recursive: true });

const users = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/local-users.json"), "utf8"));
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const tomorrow = new Date(Date.now() + 86_400_000);
const due = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
const created = { company: "", contact: "", deal: "", task: "", inviteUser: "" };
let ownerName: { id: string; before: string | null } | null = null;

async function shot(page: Page, name: string, opts: { fullPage?: boolean; keepToasts?: boolean } = {}) {
  const file = path.join(OUT, `${name}.png`);
  // Pop-up notices fade after a few seconds anyway; close them like a person would.
  if (!opts.keepToasts) await page.evaluate(() => (globalThis as any).document.querySelectorAll("#toast-container .toast").forEach((t: { remove(): void }) => t.remove()));
  if (opts.fullPage) {
    // A viewport as tall as the page, so the full-height sidebar fills it too.
    const size = page.viewportSize()!;
    const height = await page.evaluate(() => (globalThis as any).document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height });
    await page.waitForTimeout(300);
    await page.screenshot({ path: file });
    await page.setViewportSize(size);
  } else await page.screenshot({ path: file });
  console.log("shot", name);
}

// The CRM saves in the background: wait until a row is in the database.
async function saved(query: () => PromiseLike<{ data: any }>) {
  for (let i = 0; i < 40; i++) {
    const { data } = await query();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The record never reached the database");
}

async function login(page: Page, who: string) {
  await page.goto(BASE + "/");
  await page.getByLabel("Email", { exact: true }).first().fill(users[who].email);
  await page.getByLabel("Password", { exact: true }).first().fill(users[who].password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.locator("#auth-screen").waitFor({ state: "hidden", timeout: 20_000 });
}
async function tab(page: Page, id: string) {
  await page.locator(`.nav-item[data-tab="${id}"]`).click();
  await page.locator(`#tab-${id}`).waitFor();
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();

  await page.goto(BASE + "/");
  await page.locator("#auth-login-view").waitFor();
  await page.waitForTimeout(400);

  // The local owner account has no display name; give it one for the pictures.
  const { data: ownerProfile } = await db.from("profiles").select("id,display_name").eq("email", users.owner.email).single();
  ownerName = { id: ownerProfile!.id, before: ownerProfile!.display_name };
  await db.from("profiles").update({ display_name: users.owner.name }).eq("id", ownerProfile!.id);
  await login(page, "owner");

  // A company, a lead and a deal, through the UI.
  await tab(page, "companies");
  await page.getByRole("button", { name: "+ New company" }).click();
  await page.locator("#rm-name").fill("Cedar & Crumb Bakery");
  await page.locator("#rm-industry").selectOption("Retail");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.locator("#rm-heading").filter({ hasText: "Cedar & Crumb Bakery" }).waitFor();
  await page.locator("#rm-close").click();

  await tab(page, "contacts");
  await page.getByRole("button", { name: "+ New contact" }).click();
  await page.locator("#rm-firstName").fill("Maya");
  await page.locator("#rm-lastName").fill("Rivera");
  await page.locator("#rm-email").fill("maya@cedarcrumb.example");
  await page.locator("#rm-phone").fill("+44 20 7946 0321");
  await page.locator("#rm-companyId").selectOption({ label: "Cedar & Crumb Bakery" });
  await page.getByRole("button", { name: "Create contact" }).click();
  await page.locator("#rm-related .tl-filters").waitFor();

  await page.locator("#act-type").selectOption("note");
  await page.locator("#act-subject").fill("Met at the packaging trade fair");
  await page.locator("#act-body").fill("Wants recyclable boxes for 3 shops. Decision by end of month.");
  await page.getByRole("button", { name: "Log activity" }).click();
  await page.locator("#rm-timeline .tl-item", { hasText: "Met at the packaging trade fair" }).waitFor();
  await page.locator("#act-type").selectOption("note");
  await page.locator("#act-subject").fill("Prefers WhatsApp for quick questions");
  await page.locator("#act-private").check();
  await page.getByRole("button", { name: "Log activity" }).click();
  await page.locator("#rm-timeline .tl-item", { hasText: "Prefers WhatsApp" }).waitFor();

  await page.locator("#rm-related .panel-link", { hasText: "Add deal" }).click();
  await page.locator("#rm-title").fill("Wholesale packaging");
  await page.locator("#rm-value").fill("18000");
  await page.locator("#rm-stage").selectOption("proposal");
  await page.getByRole("button", { name: "Create deal" }).click();
  await page.locator("#rm-heading").filter({ hasText: "Wholesale packaging" }).waitFor();
  await page.locator("#rm-close").click();

  const contact = await saved(() => db.from("contacts").select("id,company_id").eq("email_normalized", "maya@cedarcrumb.example").maybeSingle());
  created.contact = contact.id;
  created.company = contact.company_id;
  created.deal = (await saved(() => db.from("deals").select("id").eq("contact_id", created.contact).maybeSingle())).id;

  // A call logged by hand (no phone provider is connected locally).
  await tab(page, "contacts");
  await page.locator("#contacts-search").fill("Maya");
  await page.evaluate(() => (globalThis as any).document.addEventListener("click", (e: any) => { const a = e.target.closest?.('a[href^="tel:"]'); if (a) e.preventDefault(); }, true));
  await page.locator(`#contacts-tbody tr[data-id="${created.contact}"] .dialer-call-btn`).click();
  const prompt = page.locator("#dialer-log");
  await prompt.waitFor();
  await prompt.locator("#dialer-log-outcome").selectOption("connected");
  await prompt.locator("#dialer-log-notes").fill("Interested. Asked for a quote with two box sizes by Friday.");
  await page.waitForTimeout(300);
  await shot(page, "log-a-call");
  await prompt.getByRole("button", { name: "Log call" }).click();
  await prompt.waitFor({ state: "hidden" });

  // A task for Eddie, linked to the deal and the lead.
  await tab(page, "board");
  await page.getByRole("button", { name: "+ Add task" }).click();
  await page.locator("#tm-title").fill("Send samples and pricing");
  await page.locator("#tm-deal").selectOption({ label: "Wholesale packaging (Cedar & Crumb Bakery)" });
  await page.locator("#tm-assigned").selectOption({ label: "Eddie Editor" });
  await page.locator("#tm-due-date").fill(due);
  await page.locator("#tm-due-time").fill("10:00");
  await page.locator("#tm-priority").selectOption("high");
  await page.locator("#tm-reminder").selectOption("1_hour");
  await page.locator("#tm-notes").fill("Two box sizes, recycled card. Include the delivery schedule.");
  await page.getByRole("button", { name: "Save task" }).click();
  await page.locator("#board .card", { hasText: "Send samples and pricing" }).waitFor();
  created.task = (await saved(() => db.from("tasks").select("id").eq("title", "Send samples and pricing").eq("deal_id", created.deal).maybeSingle())).id;

  // The scheduler sends the "task assigned" email (Mailpit catches it locally).
  await fetch(BASE + "/api/cron/tick", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

  // Dashboard, lead timeline, task.
  await tab(page, "dashboard");
  await page.waitForTimeout(500);

  await tab(page, "contacts");
  await page.locator("#contacts-search").fill("Maya");
  await page.locator(`#contacts-tbody tr[data-id="${created.contact}"]`).click();
  await page.locator("#rm-timeline .tl-item", { hasText: "Task created" }).waitFor();
  await page.waitForTimeout(400);
  await shot(page, "lead-timeline");
  await page.locator("#rm-close").click();

  // The direct link from the email opens the task.
  await page.goto(`${BASE}/?task=${created.task}`);
  await page.locator("#task-view-modal-overlay").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");

  // Profile: mailbox, notifications, calling.
  await tab(page, "profile");
  await page.waitForTimeout(600);
  await shot(page, "profile", { fullPage: true });

  // Team: a pending invite to an address that already has a login.
  const inviteEmail = "jordan.lee@crm.test";
  const { data: u } = await db.auth.admin.createUser({ email: inviteEmail, password: crypto.randomUUID(), email_confirm: true });
  created.inviteUser = u.user!.id;
  await tab(page, "team");
  await page.locator("#new-invite-email").fill(inviteEmail);
  await page.locator("#new-invite-role").selectOption("viewer");
  await page.locator("#add-invite-btn").click();
  await page.locator("#team-tbody tr", { hasText: inviteEmail }).waitFor();
  await page.waitForTimeout(600);
  // Parts of the Team page, one panel each.
  await page.evaluate(() => (globalThis as any).document.querySelectorAll("#toast-container .toast").forEach((t: { remove(): void }) => t.remove()));
  const panels: [string, string][] = [
    ["system-status", "#system-status-panel"],
  ];
  for (const [name, sel] of panels) {
    await page.locator(sel).first().screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("shot", name);
  }

  // The assignment email as Eddie receives it.
  let mailId = "";
  for (let i = 0; i < 40 && !mailId; i++) {
    const found: any = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${users.editor.email} subject:"Send samples and pricing"`)}`).then((r) => r.json());
    mailId = found.messages?.[0]?.ID || "";
    if (!mailId) await new Promise((r) => setTimeout(r, 500));
  }
  if (mailId) {
    const mail = await context.newPage();
    await mail.setViewportSize({ width: 760, height: 300 });
    await mail.goto(`${MAILPIT}/view/${mailId}.html`);
    await mail.waitForTimeout(300);
    await shot(mail, "task-email", { fullPage: true });
    await mail.close();
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: [mailId] }) });
  } else console.warn("No assignment email arrived; is SMTP_HOST set to Mailpit?");

} finally {
  await browser.close();
  if (created.task) {
    await db.from("job_queue").delete().like("dedupe_key", `%${created.task}%`);
    await db.from("tasks").delete().eq("id", created.task);
  }
  if (created.contact) await db.from("activities").delete().eq("contact_id", created.contact);
  if (created.deal) await db.from("deals").delete().eq("id", created.deal);
  if (created.contact) await db.from("contacts").delete().eq("id", created.contact);
  if (created.company) await db.from("companies").delete().eq("id", created.company);
  // Anything left from an interrupted run.
  const { data: leftover } = await db.from("contacts").select("id").eq("email_normalized", "maya@cedarcrumb.example");
  for (const c of leftover || []) {
    await db.from("activities").delete().eq("contact_id", c.id);
    await db.from("tasks").delete().eq("contact_id", c.id);
    await db.from("deals").delete().eq("contact_id", c.id);
    await db.from("contacts").delete().eq("id", c.id);
  }
  await db.from("companies").delete().eq("name", "Cedar & Crumb Bakery");
  await db.from("workspace_invites").delete().eq("email", "jordan.lee@crm.test");
  if (created.inviteUser) await db.auth.admin.deleteUser(created.inviteUser);
  const found: any = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent("to:jordan.lee@crm.test")}`).then((r) => r.json()).catch(() => ({}));
  const ids = (found.messages || []).map((m: { ID: string }) => m.ID);
  if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
  if (ownerName) await db.from("profiles").update({ display_name: ownerName.before }).eq("id", ownerName.id);
  console.log("Cleaned up the sample records");
}
