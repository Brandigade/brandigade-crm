import { features, getEnv, serverUrl } from "../env.js";
import { countryOf, normalizeCountry } from "./phone.js";
import type { CountryCode } from "libphonenumber-js/max";

// Calling configuration: which Twilio values are set, the webhook URLs Twilio
// is told to call, how a CRM user maps to a Twilio Client identity, and the
// owner's calling settings (workspaces.settings).

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  callerId: string;
}

export const TWILIO_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_CALLER_ID",
] as const;

/** Every Twilio value, or null when calling isn't fully set up. */
export function twilioConfig(): TwilioConfig | null {
  if (!features.calling()) return null;
  return {
    accountSid: getEnv("TWILIO_ACCOUNT_SID")!,
    authToken: getEnv("TWILIO_AUTH_TOKEN")!,
    apiKeySid: getEnv("TWILIO_API_KEY_SID")!,
    apiKeySecret: getEnv("TWILIO_API_KEY_SECRET")!,
    twimlAppSid: getEnv("TWILIO_TWIML_APP_SID")!,
    callerId: getEnv("TWILIO_CALLER_ID")!,
  };
}

export function missingTwilioEnv(): string[] {
  return TWILIO_ENV.filter((k) => !getEnv(k));
}

/** Twilio's REST API. Overridable so tests can point it at a local fake. */
export function twilioApiBase(): string {
  return (getEnv("TWILIO_API_BASE") || "https://api.twilio.com").replace(/\/+$/, "");
}

/** Browser access tokens are short-lived; the browser refreshes them before they expire. */
export const TOKEN_TTL_SECONDS = 15 * 60;
/** Recording links handed to the browser. */
export const RECORDING_URL_TTL_SECONDS = 5 * 60;
export const RECORDINGS_BUCKET = "call-recordings";
/** How long incoming calls ring the team before going to voicemail. */
export const INBOUND_RING_SECONDS = 25;
export const VOICEMAIL_MAX_SECONDS = 120;
/** Longest call Twilio will keep up (stops a forgotten call from running for hours). */
export const MAX_CALL_SECONDS = 60 * 60;
/** Per person: limits how much a compromised or careless account can dial. */
export const MAX_CALLS_PER_HOUR = 60;
export const MAX_CALLS_PER_DAY = 300;

export const voiceUrls = () => {
  const base = serverUrl();
  return {
    outbound: `${base}/api/voice/outbound`,
    incoming: `${base}/api/voice/incoming`,
    status: `${base}/api/voice/status`,
    dialComplete: `${base}/api/voice/dial-complete`,
    recordingStatus: `${base}/api/voice/recording-status`,
    announce: `${base}/api/voice/announce`,
    voicemailDone: `${base}/api/voice/voicemail-done`,
  };
};
export type VoiceUrls = ReturnType<typeof voiceUrls>;

// ---------------------------------------------------------------------------
// Identities. A Twilio Client identity may only contain letters, digits and
// underscores, so the user's UUID is written without dashes: crm_<32 hex>.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function identityForUser(userId: string): string {
  if (!isUuid(userId)) throw new Error("Not a user id");
  return "crm_" + userId.toLowerCase().replace(/-/g, "");
}

export function userIdFromIdentity(identity: unknown): string | null {
  const m = /^crm_([0-9a-f]{32})$/.exec(String(identity ?? ""));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "client:crm_..." (the From of a browser call / the To of a client leg) -> user id. */
export function userIdFromClientAddress(address: unknown): string | null {
  const m = /^client:(.+)$/.exec(String(address ?? ""));
  return m ? userIdFromIdentity(m[1]) : null;
}

// ---------------------------------------------------------------------------
// The owner's calling settings (workspaces.settings)
// ---------------------------------------------------------------------------
export const DEFAULT_ANNOUNCEMENT = "This call may be recorded for quality and training purposes.";
export const MAX_ANNOUNCEMENT_CHARS = 300;

export interface CallSettings {
  recording: boolean;
  announcement: string;
  recordingAccess: "owner" | "editors" | "all";
  defaultCountry: CountryCode | undefined;
  /** Countries outgoing calls may go to (empty = none; see allowedCountries). */
  allowedCallCountries: CountryCode[];
}

// settings.allowedCallCountries (ISO codes), defaulting to the default country,
// then to the country of the CRM's own number. Never "anywhere".
function allowedCountries(s: Record<string, unknown>): CountryCode[] {
  const list = Array.isArray(s.allowedCallCountries) ? s.allowedCallCountries : [];
  const out = [...new Set(list.map(normalizeCountry).filter((x): x is CountryCode => !!x))];
  if (out.length) return out;
  const d = normalizeCountry(s.defaultCountry) || countryOf(getEnv("TWILIO_CALLER_ID"));
  return d ? [d] : [];
}

export function callSettings(settings: unknown): CallSettings {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const text = typeof s.recordingAnnouncement === "string" ? s.recordingAnnouncement.replace(/\s+/g, " ").trim() : "";
  const access = s.recordingAccess === "owner" || s.recordingAccess === "all" ? s.recordingAccess : "editors";
  return {
    recording: s.callRecording === "on",
    announcement: (text || DEFAULT_ANNOUNCEMENT).slice(0, MAX_ANNOUNCEMENT_CHARS),
    recordingAccess: access,
    defaultCountry: normalizeCountry(s.defaultCountry),
    allowedCallCountries: allowedCountries(s),
  };
}
