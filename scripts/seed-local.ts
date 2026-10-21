// Creates the local test accounts (tests/fixtures/local-users.json) in the
// LOCAL Supabase stack: an owner (the first account becomes owner), an
// editor, a viewer, and an outsider who is never invited.
//
//   npm run seed:local            create the accounts if missing
//   npm run seed:local -- --reset also delete every CRM record first
//
// Refuses to run against anything but a local Supabase URL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS helper
import { loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const url = process.env.SUPABASE_URL || "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error(`Refusing to seed ${url || "(no SUPABASE_URL)"}: only the local stack may be seeded.`);
  process.exit(1);
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const users = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/local-users.json"), "utf8"));

async function ensureUser(u: { email: string; password: string; name: string }) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const found = list?.users.find((x) => x.email === u.email);
  if (found) return found.id;
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error || !data.user) throw error || new Error("createUser failed");
  await admin.from("profiles").update({ display_name: u.name }).eq("id", data.user.id);
  return data.user.id;
}

async function main() {
  if (process.argv.includes("--reset")) {
    for (const t of ["activities", "email_messages", "calls", "tasks", "deals", "contacts", "companies", "job_queue"]) {
      await admin.from(t).delete().not("id", "is", null);
    }
    console.log("Cleared CRM records.");
  }
  const ownerId = await ensureUser(users.owner); // first account -> owner of the CRM
  const { data: ws, error: wsErr } = await admin.from("workspaces").select("id").limit(1).single();
  if (!ws) throw new Error("The CRM workspace wasn't created for the first account: " + (wsErr?.message || "none found"));
  const editorId = await ensureUser(users.editor);
  const viewerId = await ensureUser(users.viewer);
  await ensureUser(users.outsider);
  for (const [id, role] of [[editorId, "editor"], [viewerId, "viewer"]] as const) {
    await admin.from("workspace_members").upsert({ workspace_id: ws.id, user_id: id, role, invited: false }, { onConflict: "workspace_id,user_id" });
  }
  const { data: members } = await admin.from("workspace_members").select("role, profiles(email)").eq("workspace_id", ws.id);
  console.log("Workspace", ws.id, "owner", ownerId);
  console.table((members || []).map((m: any) => ({ email: m.profiles?.email, role: m.role })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
