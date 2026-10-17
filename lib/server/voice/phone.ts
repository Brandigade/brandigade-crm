import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

// Phone numbers: E.164 normalization (the format Twilio dials) and matching an
// incoming caller to a CRM lead. The "max" metadata is used so number types
// (premium rate) can be recognised.

/** "us" / "US" -> "US" when libphonenumber knows the country. */
export function normalizeCountry(value: unknown): CountryCode | undefined {
  const c = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && isSupportedCountry(c) ? (c as CountryCode) : undefined;
}

function parse(raw: unknown, defaultCountry?: CountryCode) {
  const text = String(raw ?? "").trim().replace(/^tel:/i, "");
  if (!text || text.length > 50) return undefined;
  try {
    return parsePhoneNumberFromString(text, defaultCountry);
  } catch {
    return undefined;
  }
}

/** A number in E.164 (+14155550143), or null when it can't be a phone number. */
export function toE164(raw: unknown, defaultCountry?: CountryCode): string | null {
  const pn = parse(raw, defaultCountry);
  return pn && pn.isPossible() ? pn.number : null;
}

export const digitsOf = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");

// Number types the CRM never dials (toll fraud): premium rate, shared cost,
// universal access, personal numbers, and numbers whose type is unknown.
const REFUSED_TYPES = new Set(["PREMIUM_RATE", "SHARED_COST", "UAN", "PERSONAL_NUMBER", "PAGER", "VOICEMAIL"]);

/**
 * Whether the CRM may place a call to this number. Numbers must be valid for
 * their country, of an ordinary type, and in an allowed country (toll fraud).
 */
export function dialableNumber(raw: unknown, defaultCountry?: CountryCode, allowedCountries: CountryCode[] = []): { ok: true; e164: string } | { ok: false; reason: string } {
  const pn = parse(raw, defaultCountry);
  if (!pn || !pn.isPossible() || !pn.isValid()) {
    return { ok: false, reason: "The phone number on this record isn't a valid number. Check it includes the country code." };
  }
  const type = pn.getType();
  if (!type || REFUSED_TYPES.has(type)) return { ok: false, reason: "The CRM doesn't call premium rate, shared cost or special numbers." };
  if (allowedCountries.length && (!pn.country || !allowedCountries.includes(pn.country))) {
    return { ok: false, reason: "Calls to that country aren't allowed. The CRM owner can allow more countries on the Team page." };
  }
  return { ok: true, e164: pn.number };
}

/**
 * The part of a caller's number used to find leads saved in another format:
 * the last 9 digits of the national number (all of it when it is shorter).
 * Null when too short to match safely.
 */
export function matchSuffix(callerE164: string | null): string | null {
  if (!callerE164) return null;
  const pn = parse(callerE164);
  const national = pn ? String(pn.nationalNumber) : digitsOf(callerE164);
  const suffix = national.length >= 9 ? national.slice(-9) : national;
  return suffix.length >= 7 ? suffix : null;
}

export interface PhoneCandidate {
  id: string;
  phone: string | null;
  phone_digits: string | null;
}

export type CallerMatch =
  | { contactId: string; how: "exact" | "suffix" }
  | { contactId: null; how: "ambiguous" | "none" };

/**
 * Which lead is calling. Candidates are the leads whose phone_digits end with
 * matchSuffix(caller). A lead whose number normalizes to exactly the caller's
 * E.164 wins; otherwise a single suffix match is used. When several leads
 * share the number the call isn't linked to anyone (better no link than the
 * wrong person's timeline).
 */
export function pickCaller(callerE164: string | null, candidates: PhoneCandidate[], defaultCountry?: CountryCode): CallerMatch {
  const suffix = matchSuffix(callerE164);
  if (!callerE164 || !suffix) return { contactId: null, how: "none" };
  const unique = (list: PhoneCandidate[]) => [...new Set(list.map((c) => c.id))];
  const exact = unique(candidates.filter((c) => toE164(c.phone, defaultCountry) === callerE164));
  if (exact.length === 1) return { contactId: exact[0], how: "exact" };
  if (exact.length > 1) return { contactId: null, how: "ambiguous" };
  const bySuffix = unique(candidates.filter((c) => digitsOf(c.phone_digits ?? c.phone).endsWith(suffix)));
  if (bySuffix.length === 1) return { contactId: bySuffix[0], how: "suffix" };
  return { contactId: null, how: bySuffix.length > 1 ? "ambiguous" : "none" };
}
