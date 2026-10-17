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
 * The path the client asked for. Vercel rewrites /api/* to the single
 * function at /api; the original path is kept in request.url, and also passed
 * as ?__path= by the rewrite in vercel.json as a fallback.
 */
export function requestPath(url: URL): string {
  const fromRewrite = url.searchParams.get("__path");
  if (url.pathname !== "/api" && url.pathname !== "/api/") return url.pathname;
  if (fromRewrite) return "/api/" + fromRewrite.replace(/^\/+/, "");
  return url.pathname;
}

/**
 * The public URL a caller (e.g. Twilio) used for this request, rebuilt from
 * APP_URL rather than the Host header so it can't be spoofed. Webhook
 * signatures are computed over exactly this URL.
 */
export function publicUrl(req: Request, base: string): string {
  const url = new URL(req.url);
  const path = requestPath(url);
  const params = new URLSearchParams(url.search);
  params.delete("__path");
  const qs = params.toString();
  return base.replace(/\/+$/, "") + path + (qs ? "?" + qs : "");
}

export function createRouter(routes: Route[]) {
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
