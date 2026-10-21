// Points Supabase's scheduler (pg_cron jobs "crm-tick" every minute and
// "crm-daily") at the CRM's server.
//
//   npm run setup:cron
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERVER_URL (or APP_URL when
// the site and server share an address, as locally) and CRON_SECRET from the
// environment (or .env / .env.local), and stores the address and the secret in
// Supabase Vault through the configure_cron() database function. The secret is
// never printed. The deploy workflow runs it; the server must have the same
// CRON_SECRET.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS helper
import { loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);

const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} is not set.`);
    process.exit(1);
  }
  return v;
};
const supabaseUrl = need("SUPABASE_URL");
const appUrl = (process.env.SERVER_URL || need("APP_URL")).replace(/\/+$/, "");
const secret = need("CRON_SECRET");
if (secret.length < 24) {
  console.error("CRON_SECRET must be at least 24 characters.");
  process.exit(1);
}
if (!/^https:\/\//.test(appUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(appUrl)) {
  console.error("SERVER_URL must be https:// (or a local address for development).");
  process.exit(1);
}

const db = createClient(supabaseUrl, need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { error } = await db.rpc("configure_cron", { p_app_url: appUrl, p_secret: secret });
if (error) {
  console.error("configure_cron failed:", error.message);
  process.exit(1);
}
const { data: status } = await db.rpc("scheduler_status");
console.log(`Scheduler for ${supabaseUrl} now calls ${appUrl}/api/cron/tick every minute.`);
console.log("Status:", JSON.stringify(status));
