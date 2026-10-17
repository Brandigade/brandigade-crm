// Local development server: `npm run dev` (http://localhost:3000).
//
// Serves the static app, generates /config.js from the environment, and sends
// /api/* to the same handler Vercel runs (api/index.ts). It applies the
// security headers from vercel.json too, with the local Supabase address
// added to the Content-Security-Policy, so CSP problems show up locally.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS helper shared with the build script
import { configJs, loadLocalEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const port = Number(process.env.PORT || 3000);
if (!process.env.APP_URL) process.env.APP_URL = `http://localhost:${port}`;

const { default: api } = await import("../api/index.js");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
const STATIC_DIRS = ["assets", "css", "js"];

function securityHeaders(): Record<string, string> {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const all = (cfg.headers || []).find((h: { source: string }) => h.source === "/(.*)");
  const out: Record<string, string> = {};
  for (const h of all?.headers || []) out[h.key] = h.value;
  delete out["Strict-Transport-Security"];
  const sb = process.env.SUPABASE_URL || "";
  if (sb && out["Content-Security-Policy"]) {
    const origin = new URL(sb).origin;
    const ws = origin.replace(/^http/, "ws");
    out["Content-Security-Policy"] = out["Content-Security-Policy"]
      .replace("connect-src 'self'", `connect-src 'self' ${origin} ${ws}`)
      .replace("media-src 'self'", `media-src 'self' ${origin}`);
  }
  return out;
}

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method || "GET";
  return new Request(`http://localhost:${port}${req.url}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const sec = securityHeaders();
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const response = await api.fetch(await toRequest(req));
      const headers: Record<string, string> = { ...sec };
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (url.pathname === "/config.js") {
      res.writeHead(200, { ...sec, "Content-Type": TYPES[".js"], "Cache-Control": "no-cache" });
      res.end(configJs());
      return;
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!rel) rel = "index.html";
    const file = path.resolve(root, rel);
    const allowed = rel === "index.html" || STATIC_DIRS.some((d) => file.startsWith(path.join(root, d) + path.sep));
    if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { ...sec, "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { ...sec, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Dev server error");
  }
});

server.listen(port, () => {
  console.log(`Brandigade CRM dev server on http://localhost:${port} (Supabase: ${process.env.SUPABASE_URL || "not set, demo mode"})`);
});
