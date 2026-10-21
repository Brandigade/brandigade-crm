// Small helpers for Web-standard Request/Response handlers.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, message, code);
export const unauthorized = (message = "Your session has expired. Sign in again.") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "You don't have permission to do that.") => new HttpError(403, message, "forbidden");
export const notFound = (message = "Not found") => new HttpError(404, message, "not_found");
export const notConfigured = (what: string) =>
  new HttpError(503, `${what} isn't set up on the server yet.`, "not_configured");

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const base: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(base.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...base, headers });
}

export function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8", ...SECURITY_HEADERS } });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location, ...SECURITY_HEADERS } });
}

/** What to log about an error: never the whole object (it may carry request data). */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    const frames = err.stack ? err.stack.split("\n").slice(1, 6).join("\n") : "";
    return `${err.name}: ${err.message}${frames ? "\n" + frames : ""}`;
  }
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    return `${String(e.code ?? "error")}: ${String(e.message ?? "")}`.slice(0, 500);
  }
  return String(err).slice(0, 500);
}

/** Turns any thrown value into a JSON error response without leaking internals. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "ConfigError") {
    console.error(errorSummary(err));
    return json({ error: "The server is missing some configuration.", code: "not_configured" }, 503);
  }
  console.error("Unhandled error", errorSummary(err));
  return json({ error: "Something went wrong on the server. Please try again.", code: "server_error" }, 500);
}

async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "Request is too large", "too_large");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "Request is too large", "too_large");
  return text;
}

/** Parses a JSON body (max 1 MB by default). */
export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const text = await readBodyText(req, maxBytes);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest("The request body isn't valid JSON", "invalid_json");
  }
}

/** Parses an application/x-www-form-urlencoded body (Twilio webhooks). */
export async function readForm(req: Request, maxBytes = 200_000): Promise<Record<string, string>> {
  const text = await readBodyText(req, maxBytes);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function str(v: unknown, max = 10_000): string {
  if (v === null || v === undefined) return "";
  return String(v).slice(0, max);
}
