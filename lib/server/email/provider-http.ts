import { fetchWithRetry, type RetryOptions } from "../retry.js";

// Every call to Google / Microsoft goes through here, so tests can swap the
// network for an in-process fake and the retry waits for an instant sleep.

let testFetch: typeof fetch | undefined;
let testSleep: ((ms: number) => Promise<void>) | undefined;

export function __setEmailFetchForTests(f: typeof fetch | null, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  testFetch = f ?? undefined;
  testSleep = f ? opts.sleep : undefined;
}

export function providerFetch(url: string | URL, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  return fetchWithRetry(url, init, { fetchImpl: testFetch, sleep: testSleep, ...opts });
}

/** The mailbox's access was revoked or expired: the person has to reconnect it. */
export class ReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/** Reads the OAuth error code from a token endpoint response body. */
export function oauthErrorCode(body: unknown): string {
  if (body && typeof body === "object") {
    const e = (body as any).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof e.code === "string") return e.code;
  }
  return "";
}

/**
 * Token endpoint errors that mean the grant is gone and only a new consent
 * helps. (invalid_client is deliberately not here: that is the CRM's own app
 * credentials being wrong, which reconnecting can't fix.)
 */
export function isRevokedGrant(body: unknown): boolean {
  const code = oauthErrorCode(body).toLowerCase();
  return ["invalid_grant", "interaction_required", "consent_required"].includes(code);
}
