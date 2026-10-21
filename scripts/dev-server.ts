// Local development server: `npm run dev` (http://localhost:3000).
//
// Serves the static app, generates /config.js from the environment, and sends
// /api/* to the server code (lib/server, the same code the Supabase Edge
// Function "api" runs in production). It sends the site's security headers
// too (production gets the same policy as a <meta> tag), so CSP problems show
// up locally. With SERVER_URL set, the page calls that server instead (for
// example the local Supabase Edge Function).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS helper shared with the build script
import { configJs, loadLocalEnv, securityHeaders as siteHeaders } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const port = Number(process.env.PORT || 3000);
if (!process.env.APP_URL) process.env.APP_URL = `http://localhost:${port}`;

const { handleRequest } = await import("../lib/server/routes.js");

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
  return siteHeaders();
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
      const response = await handleRequest(await toRequest(req));
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
