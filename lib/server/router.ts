import { appUrl } from "./env.js";
import { errorResponse, json } from "./http.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext {
  url: URL;
  /** Values of :named segments in the route path. */
  params: Record<string, string>;
}

export type Handler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: Method;
  /** e.g. "/api/email/accounts/:id/sync" */
  path: string;
  handler: Handler;
}

interface Compiled extends Route {
  re: RegExp;
  keys: string[];
}

function compile(route: Route): Compiled {
  const keys: string[] = [];
  const pattern = route.path
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...route, keys, re: new RegExp(`^${pattern}/?$`) };
}

/**
 * The path the client asked for: /api/... both on the dev server and in the
 * Supabase Edge Function "api" (which sees its own name as the first segment).
 */
export function requestPath(url: URL): string {
  return url.pathname;
}

/**
 * The public URL a caller (e.g. Twilio) used for this request, rebuilt from
 * SERVER_URL rather than the Host header so it can't be spoofed. Webhook
 * signatures are computed over exactly this URL.
 */
export function publicUrl(req: Request, base: string): string {
  const url = new URL(req.url);
  return base.replace(/\/+$/, "") + requestPath(url) + url.search;
}

// The site (GitHub Pages) and the server (a Supabase Edge Function) are on
// different addresses, so the browser asks before each API call (CORS). Only
// the CRM's own site may call it; sign-in uses bearer tokens, never cookies.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  let allowed: string | null;
  try {
    allowed = new URL(appUrl()).origin;
  } catch {
    allowed = null;
  }
  if (!origin || origin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (!Object.keys(extra).length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function createRouter(routes: Route[]) {
  const route = createRoutes(routes);
  return async function handle(req: Request): Promise<Response> {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors });
    return withHeaders(await route(req), cors);
  };
}

function createRoutes(routes: Route[]) {
  const compiled = routes.map(compile);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = requestPath(url);
    let pathMatched = false;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method && !(req.method === "HEAD" && r.method === "GET")) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        return await r.handler(req, { url, params });
      } catch (err) {
        return errorResponse(err);
      }
    }
    if (pathMatched) return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);
    return json({ error: "Not found", code: "not_found" }, 404);
  };
}
