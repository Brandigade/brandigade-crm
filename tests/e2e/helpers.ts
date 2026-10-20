import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS helper
import { loadLocalEnv } from "../../scripts/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv(path.resolve(here, "../.."));
export const users = JSON.parse(fs.readFileSync(path.resolve(here, "../fixtures/local-users.json"), "utf8")) as Record<
  "owner" | "editor" | "viewer" | "outsider",
  { email: string; password: string; name: string }
>;
export type Who = keyof typeof users;

/**
 * A server route. By default the dev server's own /api; with E2E_API_URL set
 * (e.g. http://127.0.0.1:57321/functions/v1/api) the local Supabase Edge
 * Function, the way production runs it.
 */
export const api = (path: string) => (process.env.E2E_API_URL || "/api").replace(/\/+$/, "") + path;

/** A unique prefix so tests can share the local database and clean up after themselves. */
export const tag = (label: string) => `E2E ${label} ${Date.now().toString(36)}`;

/** Service-role client for test setup/cleanup only (local stack). */
export function admin() {
  const url = process.env.SUPABASE_URL!;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("E2E tests only run against the local Supabase stack");
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export async function login(page: Page, who: Who) {
  const u = users[who];
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).first().fill(u.email);
  await page.getByLabel("Password", { exact: true }).first().fill(u.password);
  await page.getByRole("button", { name: "Log in" }).click();
}

export async function loginToCrm(page: Page, who: Who) {
  await login(page, who);
  await expect(page.locator("#auth-screen")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#tab-dashboard")).toBeVisible();
}

export async function newPage(browser: Browser, who: Who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginToCrm(page, who);
  return page;
}

export async function gotoTab(page: Page, tab: string) {
  await page.locator(`.nav-item[data-tab="${tab}"]`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** Deletes every CRM row whose name/title/subject starts with the prefix. */
export async function cleanup(prefix: string) {
  const db = admin();
  await db.from("activities").delete().like("subject", `${prefix}%`);
  await db.from("tasks").delete().like("title", `${prefix}%`);
  await db.from("deals").delete().like("title", `${prefix}%`);
  await db.from("contacts").delete().like("first_name", `${prefix}%`);
  await db.from("companies").delete().like("name", `${prefix}%`);
}

/**
 * A Supabase client signed in as one of the test people: exactly what anyone
 * could do with their own session and the public anon key, bypassing the UI.
 */
export async function userDb(who: Who) {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await db.auth.signInWithPassword({ email: users[who].email, password: users[who].password });
  if (error || !data.session) throw error || new Error("sign-in failed");
  return { db, token: data.session.access_token };
}
