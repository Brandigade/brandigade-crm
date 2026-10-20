import { ON_EDGE, features, getEnv, requireEnv, serverUrl } from "../env.js";

// Provider settings for Gmail and Outlook. Every base URL can be overridden
// with an environment variable so tests (and local fakes) never talk to the
// real providers. Nothing here is ever sent to the browser.

export type Provider = "google" | "microsoft";
export const PROVIDERS: Provider[] = ["google", "microsoft"];

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
export const MICROSOFT_SCOPES = ["openid", "email", "offline_access", "User.Read", "Mail.Read", "Mail.Send"];

/** Scopes without which the integration can't work (checked after consent). */
export const REQUIRED_SCOPES: Record<Provider, string[]> = {
  google: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
  microsoft: ["mail.read", "mail.send"],
};

const trim = (u: string) => u.replace(/\/+$/, "");

export const urls = {
  googleAuth: () => getEnv("GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: () => getEnv("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token",
  googleRevoke: () => getEnv("GOOGLE_REVOKE_URL") || "https://oauth2.googleapis.com/revoke",
  gmailApi: () => trim(getEnv("GMAIL_API_BASE") || "https://gmail.googleapis.com/gmail/v1"),
  /** e.g. https://login.microsoftonline.com/common/oauth2/v2.0 */
  microsoftLogin: () =>
    `${trim(getEnv("MICROSOFT_LOGIN_BASE") || "https://login.microsoftonline.com")}/${encodeURIComponent(
      getEnv("MICROSOFT_TENANT_ID") || "common",
    )}/oauth2/v2.0`,
  graphApi: () => trim(getEnv("GRAPH_API_BASE") || "https://graph.microsoft.com/v1.0"),
};

export function providerLabel(p: Provider): string {
  return p === "google" ? "Gmail" : "Outlook";
}

export function providerConfigured(p: Provider): boolean {
  return p === "google" ? features.gmail() : features.outlook();
}

export function clientCredentials(p: Provider): { clientId: string; clientSecret: string } {
  return p === "google"
    ? { clientId: requireEnv("GOOGLE_CLIENT_ID"), clientSecret: requireEnv("GOOGLE_CLIENT_SECRET") }
    : { clientId: requireEnv("MICROSOFT_CLIENT_ID"), clientSecret: requireEnv("MICROSOFT_CLIENT_SECRET") };
}

/** Fixed from APP_URL; must be registered exactly like this at the provider. */
export function redirectUri(p: Provider): string {
  return `${serverUrl()}/api/email/oauth/${p}/callback`;
}

export function tokenUrl(p: Provider): string {
  return p === "google" ? urls.googleToken() : `${urls.microsoftLogin()}/token`;
}

export function isProvider(v: unknown): v is Provider {
  return v === "google" || v === "microsoft";
}

// Sync limits (see docs/ARCHITECTURE.md and the email worker). Inside the
// Supabase Edge Function a run handles fewer messages (CPU limit per request);
// scans and history resume where they stopped on the next tick.
export const LIMITS = {
  initialWindowDays: 30,
  rescanWindowDays: 7,
  backfillWindowDays: 90,
  initialMaxMessages: 500,
  /** Messages a single run looks at while scanning (the scan resumes). */
  scanMessagesPerRun: ON_EDGE ? 100 : 500,
  backfillMaxMessages: ON_EDGE ? 50 : 200,
  incrementalMaxMessages: ON_EDGE ? 100 : 500,
  /** Mailboxes one scheduler tick syncs. */
  mailboxesPerTick: ON_EDGE ? 2 : 50,
  // Graph delta pages already carry the metadata, so a run can look at more.
  graphMessagesPerRun: ON_EDGE ? 200 : 2000,
  syncIntervalMs: 2 * 60 * 1000,
  maxBackoffMs: 60 * 60 * 1000,
  bodyTextMax: 100_000,
  bodyHtmlMax: 400_000,
  snippetMax: 300,
  subjectMax: 998,
  sendsPerWindow: 30,
  sendWindowMs: 10 * 60 * 1000,
  maxRecipients: 50,
  sendBodyMax: 100_000,
};
