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
  const server = (process.env.SERVER_URL || "").replace(/\/+$/, "");
  return {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    // Where the server's /api/* routes are, when they aren't on the site's own
    // address (production: the Supabase Edge Function).
    ...(server ? { apiBase: server + "/api" } : {}),
  };
}

// The pinned outside scripts the page may load (index.html, js/dialer.js).
const SCRIPT_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/",
  "https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/",
];

/**
 * The Content-Security-Policy for the site. GitHub Pages can't send headers,
 * so the build puts it in a <meta> tag (where frame-ancestors isn't allowed;
 * js/frame-guard.js covers framing instead). The dev server sends it as a
 * header with frame-ancestors added.
 */
export function contentSecurityPolicy({ header = false } = {}) {
  const origins = new Set();
  for (const u of [process.env.SUPABASE_URL, process.env.SERVER_URL]) {
    if (!u) continue;
    try {
      origins.add(new URL(u).origin);
    } catch {
      /* ignore a malformed value */
    }
  }
  const http = [...origins];
  const ws = http.map((o) => o.replace(/^http/, "ws"));
  const parts = [
    "default-src 'self'",
    `script-src 'self' ${SCRIPT_SOURCES.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    ["media-src 'self' blob:", ...http, "https://sdk.twilio.com https://media.twiliocdn.com"].join(" "),
    ["connect-src 'self'", ...http, ...ws, "https://*.twilio.com wss://*.twilio.com"].join(" "),
    "frame-src 'self' blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  if (header) parts.push("frame-ancestors 'none'");
  return parts.join("; ");
}

/** Headers the dev server sends (GitHub Pages can't; see contentSecurityPolicy). */
export function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=()",
    "Content-Security-Policy": contentSecurityPolicy({ header: true }),
  };
}

export function configJs() {
  return "window.BRANDIGADE_CONFIG = " + JSON.stringify(browserConfig(), null, 2) + ";\n";
}
