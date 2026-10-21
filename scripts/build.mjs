// Builds the site for GitHub Pages: copies the static app into dist/, writes
// dist/config.js (public values only: SUPABASE_URL, SUPABASE_ANON_KEY and the
// server's address) and puts the Content-Security-Policy into index.html as a
// <meta> tag, because GitHub Pages can't send headers. The server is built
// separately (npm run build:edge) and keeps every secret.
import fs from "node:fs";
import path from "node:path";
import { browserConfig, configJs, contentSecurityPolicy, loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
if (!process.env.GITHUB_ACTIONS) loadLocalEnv(root);

const out = path.join(root, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const entry of ["index.html", "assets", "css", "js"]) {
  fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
}

const cfg = browserConfig();
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  console.warn("SUPABASE_URL / SUPABASE_ANON_KEY are not set: the site will open in demo mode.");
}
fs.writeFileSync(path.join(out, "config.js"), configJs());

const indexFile = path.join(out, "index.html");
const csp = contentSecurityPolicy().replace(/"/g, "&quot;");
const html = fs.readFileSync(indexFile, "utf8").replace("<head>", `<head>
<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
fs.writeFileSync(indexFile, html);

const files = fs.readdirSync(out, { recursive: true }).length;
console.log(`Built dist/ (${files} entries) for ${cfg.supabaseUrl || "demo mode"}`);
