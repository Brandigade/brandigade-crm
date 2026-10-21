// fetch with timeouts, retries and rate-limit handling for provider APIs
// (Google, Microsoft Graph, Twilio, Resend).

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number, message = "Rate limited by the provider") {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number;
  baseDelayMs?: number;
  /** Longest wait between attempts; a longer Retry-After throws RateLimitError (default 20 s). */
  maxDelayMs?: number;
  /** Per-attempt timeout (default 30 s). */
  timeoutMs?: number;
  /** Decide whether a response should be retried (default: 429 and 5xx). */
  retryOn?: (res: Response) => boolean;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses Retry-After (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export async function fetchWithRetry(url: string | URL, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  const timeout = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retryOn = opts.retryOn ?? ((res: Response) => res.status === 429 || (res.status >= 500 && res.status <= 599));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response | null = null;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      lastErr = err;
    }
    if (res && !retryOn(res)) return res;

    const backoff = Math.min(maxDelay, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    let wait = backoff;
    if (res) {
      const ra = parseRetryAfter(res.headers.get("retry-after"));
      if (ra !== null) {
        if (ra > maxDelay) {
          await res.body?.cancel().catch(() => {});
          throw new RateLimitError(ra);
        }
        wait = Math.max(wait, ra);
      }
      if (attempt === retries) {
        if (res.status === 429) {
          await res.body?.cancel().catch(() => {});
          throw new RateLimitError(ra ?? 60_000);
        }
        return res; // let the caller read the 5xx body
      }
      await res.body?.cancel().catch(() => {});
    } else if (attempt === retries) {
      throw lastErr;
    }
    await sleep(wait);
  }
  throw lastErr ?? new Error("fetchWithRetry: exhausted retries");
}

/** Reads a JSON response or throws ProviderError with the provider's message. */
export async function expectJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && (
        (body as any).error?.message ||
        (body as any).error_description ||
        (typeof (body as any).error === "string" ? (body as any).error : undefined) ||
        (body as any).message
      )) || `HTTP ${res.status}`;
    throw new ProviderError(res.status, `${what}: ${msg}`, body);
  }
  return body as T;
}
