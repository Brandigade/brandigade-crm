// Loads .env and then .env.local (which wins) into process.env for local
// scripts. Variables already set in the shell win over both files.
import fs from "node:fs";
import path from "node:path";

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

export function loadLocalEnv(root = process.cwd()) {
  const shell = new Set(Object.keys(process.env));
  const merged = {};
  for (const file of [".env", ".env.local"]) {
    const p = path.join(root, file);
    if (fs.existsSync(p)) Object.assign(merged, parseEnv(fs.readFileSync(p, "utf8")));
  }
  for (const [k, v] of Object.entries(merged)) if (!shell.has(k)) process.env[k] = v;
}

/** The browser-safe config (public values only). */
export function browserConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  };
}

export function configJs() {
  return "window.BRANDIGADE_CONFIG = " + JSON.stringify(browserConfig(), null, 2) + ";\n";
}
