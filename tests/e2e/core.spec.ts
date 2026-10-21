import { expect, test } from "@playwright/test";
import { admin, cleanup, gotoTab, loginToCrm, newPage, tag, userDb } from "./helpers.js";

// The CRM's everyday flows against the real database: records, links, the
// unified timeline, persistence across reloads and live updates between people.

test.describe("core CRM", () => {
  const prefix = tag("core");
  test.afterAll(async () => cleanup(prefix));

  test("an editor builds a company, lead, deal and task; everything persists and shows on the timeline", async ({ page }) => {
    await loginToCrm(page, "editor");

    await gotoTab(page, "companies");
    await page.getByRole("button", { name: "+ New company" }).click();
    await page.locator("#rm-name").fill(`${prefix} Acme`);
    await page.locator("#rm-industry").selectOption("Retail");
    await page.getByRole("button", { name: "Create company" }).click();
    await expect(page.locator("#rm-heading")).toHaveText(`${prefix} Acme`);
    await page.locator("#rm-close").click();

    await gotoTab(page, "contacts");
    await page.getByRole("button", { name: "+ New contact" }).click();
    await page.locator("#rm-firstName").fill(`${prefix} Lea`);
    await page.locator("#rm-email").fill(`lea.${Date.now()}@acme.test`);
    await page.locator("#rm-phone").fill("+1 415 555 0143");
    await page.locator("#rm-companyId").selectOption({ label: `${prefix} Acme` });
    await page.getByRole("button", { name: "Create contact" }).click();
    await expect(page.locator("#rm-related .tl-filters")).toBeVisible();

    // A hand-logged call on the lead's timeline.
    await page.locator("#act-type").selectOption("call");
    await page.locator("#act-subject").fill(`${prefix} Discovery call`);
    await page.locator("#act-body").fill("Budget confirmed for Q4");
    await page.getByRole("button", { name: "Log activity" }).click();
    await expect(page.locator("#rm-timeline .tl-item", { hasText: `${prefix} Discovery call` })).toBeVisible();

    // A deal from the lead record.
    await page.locator("#rm-related .panel-link", { hasText: "Add deal" }).click();
    await page.locator("#rm-title").fill(`${prefix} Rebrand`);
    await page.locator("#rm-value").fill("25000");
    await page.locator("#rm-stage").selectOption("proposal");
    await page.getByRole("button", { name: "Create deal" }).click();
    await expect(page.locator("#rm-heading")).toHaveText(`${prefix} Rebrand`);
    await page.locator("#rm-close").click();

    // A task on the deal, assigned to the viewer.
    await gotoTab(page, "board");
    await page.getByRole("button", { name: "+ Add task" }).click();
    await page.locator("#tm-title").fill(`${prefix} Send proposal`);
    await page.locator("#tm-deal").selectOption({ label: `${prefix} Rebrand (${prefix} Acme)` });
    await page.locator("#tm-assigned").selectOption({ label: "Vera Viewer" });
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.locator("#board .card", { hasText: `${prefix} Send proposal` })).toBeVisible();

    // Saved in the database with every link and the automatic timeline entries.
    await expect.poll(async () => {
      const { data } = await admin().from("tasks").select("title, contact_id, deal_id, assigned_to, assignment_version").like("title", `${prefix}%`);
      return data?.[0];
    }).toMatchObject({ title: `${prefix} Send proposal`, assignment_version: 1 });
    const db = admin();
    const { data: contact } = await db.from("contacts").select("id, company_id, email_normalized").like("first_name", `${prefix}%`).single();
    const { data: task } = await db.from("tasks").select("id, contact_id").like("title", `${prefix}%`).single();
    expect(task!.contact_id).toBe(contact!.id);
    const { data: jobs } = await db.from("job_queue").select("kind, payload").eq("dedupe_key", `task_assigned:${task!.id}:1`);
    expect(jobs?.[0]?.kind).toBe("notify.task_assigned");

    // After a reload everything is still there, and the lead's timeline has the call and the task.
    await page.reload();
    await expect(page.locator("#auth-screen")).toBeHidden({ timeout: 20_000 });
    await gotoTab(page, "contacts");
    await page.locator("#contacts-tbody tr", { hasText: `${prefix} Lea` }).click();
    const timeline = page.locator("#rm-timeline");
    await expect(timeline.locator(".tl-item", { hasText: `${prefix} Discovery call` })).toBeVisible();
    await expect(timeline.locator(".tl-item", { hasText: `Task created: ${prefix} Send proposal` })).toBeVisible();
    await page.locator(".tl-chip", { hasText: "Tasks" }).click();
    await expect(timeline.locator(".tl-item", { hasText: `${prefix} Discovery call` })).toHaveCount(0);
    await expect(timeline.locator(".tl-item", { hasText: "Task created" })).toBeVisible();
  });

  test("changes reach a teammate's open CRM without reloading", async ({ browser }) => {
    const owner = await newPage(browser, "owner");
    const editor = await newPage(browser, "editor");
    await gotoTab(owner, "contacts");

    await gotoTab(editor, "contacts");
    await editor.getByRole("button", { name: "+ New contact" }).click();
    await editor.locator("#rm-firstName").fill(`${prefix} Live`);
    await editor.getByRole("button", { name: "Create contact" }).click();
    await expect(owner.locator("#contacts-tbody tr", { hasText: `${prefix} Live` })).toBeVisible({ timeout: 15_000 });

    // The owner opens the lead; the editor logs a note; it appears on the owner's open timeline.
    await owner.locator("#contacts-tbody tr", { hasText: `${prefix} Live` }).click();
    await editor.locator("#act-subject").fill(`${prefix} Live note`);
    await editor.getByRole("button", { name: "Log activity" }).click();
    await expect(owner.locator("#rm-timeline .tl-item", { hasText: `${prefix} Live note` })).toBeVisible({ timeout: 15_000 });
    await owner.context().close();
    await editor.context().close();
  });

  test("a private note stays with its author", async ({ browser }) => {
    const editor = await newPage(browser, "editor");
    await gotoTab(editor, "contacts");
    await editor.getByRole("button", { name: "+ New contact" }).click();
    await editor.locator("#rm-firstName").fill(`${prefix} Private`);
    await editor.getByRole("button", { name: "Create contact" }).click();
    await editor.locator("#act-subject").fill(`${prefix} Only mine`);
    await editor.locator("#act-private").check();
    await editor.getByRole("button", { name: "Log activity" }).click();
    await expect(editor.locator("#rm-timeline .tl-item", { hasText: `${prefix} Only mine` }).locator(".tl-pill-private")).toBeVisible();
    await expect.poll(async () => (await admin().from("activities").select("id").eq("subject", `${prefix} Only mine`)).data?.length).toBe(1);

    const owner = await newPage(browser, "owner");
    await gotoTab(owner, "contacts");
    await owner.locator("#contacts-tbody tr", { hasText: `${prefix} Private` }).click();
    await expect(owner.locator("#rm-timeline")).toBeVisible();
    await expect(owner.locator("#rm-timeline .tl-state")).toHaveCount(0, { timeout: 10_000 });
    await expect(owner.locator("#rm-timeline .tl-item", { hasText: `${prefix} Only mine` })).toHaveCount(0);
    // Not even by asking the database directly with the owner's session.
    const { db: ownerDb } = await userDb("owner");
    const { data: leaked } = await ownerDb.from("activities").select("id").eq("subject", `${prefix} Only mine`);
    expect(leaked).toEqual([]);
    await owner.context().close();
    await editor.context().close();
  });

  test("a half-typed note survives the timeline refreshing", async ({ page }) => {
    await loginToCrm(page, "editor");
    await gotoTab(page, "contacts");
    await page.getByRole("button", { name: "+ New contact" }).click();
    await page.locator("#rm-firstName").fill(`${prefix} Typist`);
    await page.getByRole("button", { name: "Create contact" }).click();
    // Log one note, then start the next straight away.
    await page.locator("#act-type").selectOption("note");
    await page.locator("#act-subject").fill(`${prefix} First note`);
    await page.getByRole("button", { name: "Log activity" }).click();
    await page.locator("#act-type").selectOption("note");
    await page.locator("#act-subject").fill(`${prefix} Half typed`);
    await page.locator("#act-private").check();
    await page.locator("#act-body").fill("still writing");
    // A teammate adds to the same lead meanwhile, so the timeline redraws.
    const db = admin();
    let lead: { id: string; workspace_id: string } | null = null;
    await expect.poll(async () => {
      lead = (await db.from("contacts").select("id,workspace_id").eq("first_name", `${prefix} Typist`).maybeSingle()).data;
      return !!lead;
    }).toBe(true);
    await db.from("activities").insert({ workspace_id: lead!.workspace_id, type: "note", subject: `${prefix} From a teammate`, contact_id: lead!.id });
    await expect(page.locator("#rm-timeline .tl-item", { hasText: `${prefix} From a teammate` })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#rm-timeline .tl-item", { hasText: `${prefix} First note` })).toBeVisible();
    // Nothing typed was lost, and typing carries on in the same field.
    await expect(page.locator("#act-type")).toHaveValue("note");
    await expect(page.locator("#act-subject")).toHaveValue(`${prefix} Half typed`);
    await expect(page.locator("#act-private")).toBeChecked();
    await expect(page.locator("#act-body")).toHaveValue("still writing");
    await expect(page.locator("#act-body")).toBeFocused();
  });

  test("@mobile the CRM works on a phone-sized screen", async ({ page }) => {
    await loginToCrm(page, "owner");
    await gotoTab(page, "contacts");
    await expect(page.locator("#tab-contacts .page-title")).toBeVisible();
    const overflow = await page.evaluate(() => { const g = globalThis as any; return g.document.documentElement.scrollWidth > g.innerWidth + 1; });
    expect(overflow).toBe(false);
  });
});
