// Production build (Vercel runs `npm run build`): copies the static app into
// dist/ and writes dist/config.js from SUPABASE_URL and SUPABASE_ANON_KEY.
// Only those two public values reach the browser. The server code in api/ is
// compiled by Vercel separately and keeps every secret.
import fs from "node:fs";
import path from "node:path";
import { browserConfig, configJs, loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
if (!process.env.VERCEL) loadLocalEnv(root);

const out = path.join(root, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const entry of ["index.html", "assets", "css", "js"]) {
  fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
}

const cfg = browserConfig();
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  if (process.env.VERCEL_ENV === "production") {
    console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set for a production build.");
    process.exit(1);
  }
  console.warn("SUPABASE_URL / SUPABASE_ANON_KEY are not set: the site will open in demo mode.");
}
fs.writeFileSync(path.join(out, "config.js"), configJs());

const files = fs.readdirSync(out, { recursive: true }).length;
console.log(`Built dist/ (${files} entries) for ${cfg.supabaseUrl || "demo mode"}`);
