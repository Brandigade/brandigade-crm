import { describe, expect, it } from "vitest";
import { dialableNumber, matchSuffix, normalizeCountry, pickCaller, toE164 } from "../../../lib/server/voice/phone.js";
import { callSettings, DEFAULT_ANNOUNCEMENT, identityForUser, userIdFromClientAddress, userIdFromIdentity } from "../../../lib/server/voice/config.js";

describe("E.164 normalization", () => {
  it("normalizes the ways people type numbers", () => {
    expect(toE164("+1 (415) 555-0143")).toBe("+14155550143");
    expect(toE164("(415) 555-0143", "US")).toBe("+14155550143");
    expect(toE164("415.555.0143", "US")).toBe("+14155550143");
    expect(toE164("tel:+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("0300 1234567", "PK")).toBe("+923001234567");
    expect(toE164("00971 50 123 4567", "GB")).toBe("+971501234567");
  });
  it("needs a country code or a default country", () => {
    expect(toE164("(415) 555-0143")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("anonymous")).toBeNull();
    expect(toE164("12345", "US")).toBeNull();
  });
  it("accepts only known countries as the default", () => {
    expect(normalizeCountry("us")).toBe("US");
    expect(normalizeCountry("XX")).toBeUndefined();
    expect(normalizeCountry("USA")).toBeUndefined();
    expect(normalizeCountry(undefined)).toBeUndefined();
  });
});

describe("numbers the CRM will dial", () => {
  it("allows valid numbers", () => {
    expect(dialableNumber("+1 415 555 0143", undefined, ["US"])).toEqual({ ok: true, e164: "+14155550143" });
    expect(dialableNumber("020 7946 0958", "GB", ["GB"])).toEqual({ ok: true, e164: "+442079460958" });
  });
  it("refuses invalid and premium-rate numbers", () => {
    expect(dialableNumber("+1 415 555")).toMatchObject({ ok: false });
    expect(dialableNumber("not a number")).toMatchObject({ ok: false });
    expect(dialableNumber("+1 900 555 0199")).toMatchObject({ ok: false, reason: expect.stringContaining("premium") });
    expect(dialableNumber("+44 909 879 0000")).toMatchObject({ ok: false, reason: expect.stringContaining("premium") });
  });
});

describe("matching an incoming caller to a lead", () => {
  const c = (id: string, phone: string | null) => ({ id, phone, phone_digits: phone ? phone.replace(/\D/g, "") : null });
  it("an exact E.164 match wins", () => {
    const r = pickCaller("+14155550143", [c("maya", "+1 (415) 555-0143"), c("other", "+44 415 555 0143")], "US");
    expect(r).toEqual({ contactId: "maya", how: "exact" });
  });
  it("matches numbers saved without a country code (default country)", () => {
    expect(pickCaller("+13125550119", [c("n", "(312) 555-0119")], "US")).toEqual({ contactId: "n", how: "exact" });
  });
  it("falls back to the last 9 digits when the number can't be normalized", () => {
    // No default country: "(312) 555-0119" can't become E.164, but its digits end the same.
    expect(pickCaller("+13125550119", [c("n", "(312) 555-0119")])).toEqual({ contactId: "n", how: "suffix" });
  });
  it("links nobody when several leads share the number", () => {
    expect(pickCaller("+16465550187", [c("a", "+1 646 555 0187"), c("b", "646-555-0187")], "US")).toEqual({ contactId: null, how: "ambiguous" });
    expect(pickCaller("+13125550119", [c("a", "312 555 0119"), c("b", "(312)5550119")])).toEqual({ contactId: null, how: "ambiguous" });
  });
  it("an exact match beats a suffix lookalike", () => {
    expect(pickCaller("+14155550143", [c("maya", "+14155550143"), c("lookalike", "+44 4155550143")], "US")).toEqual({ contactId: "maya", how: "exact" });
  });
  it("unknown, withheld and short numbers match nobody", () => {
    expect(pickCaller("+14155550143", [], "US")).toEqual({ contactId: null, how: "none" });
    expect(pickCaller(null, [c("x", "+14155550143")], "US")).toEqual({ contactId: null, how: "none" });
    expect(matchSuffix("+266696687")).toBeNull();
    expect(matchSuffix("+14155550143")).toBe("155550143");
    expect(matchSuffix("+6591234567")).toBe("91234567"); // 8-digit national numbers are used whole
  });
});

describe("identities and settings", () => {
  it("maps a user id to a Twilio identity and back", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const identity = identityForUser(id);
    expect(identity).toMatch(/^crm_[0-9a-f]{32}$/);
    expect(userIdFromIdentity(identity)).toBe(id);
    expect(userIdFromClientAddress("client:" + identity)).toBe(id);
  });
  it("rejects anything that isn't one of our identities", () => {
    for (const v of ["client:alice", "client:crm_123", "+14155550143", "", "crm_" + "g".repeat(32), "client:crm_" + "a".repeat(33)]) {
      expect(userIdFromClientAddress(v)).toBeNull();
    }
    expect(() => identityForUser("not-a-uuid")).toThrow();
  });
  it("reads the owner's calling settings with safe defaults", () => {
    expect(callSettings({})).toEqual({ recording: false, announcement: DEFAULT_ANNOUNCEMENT, recordingAccess: "editors", defaultCountry: undefined, allowedCallCountries: [] });
    const s = callSettings({ callRecording: "on", recordingAnnouncement: "  We record\ncalls.  ", recordingAccess: "all", defaultCountry: "gb" });
    expect(s).toEqual({ recording: true, announcement: "We record calls.", recordingAccess: "all", defaultCountry: "GB", allowedCallCountries: ["GB"] });
    expect(callSettings({ defaultCountry: "GB", allowedCallCountries: ["us", "ae", "nope", "US"] }).allowedCallCountries).toEqual(["US", "AE"]);
    expect(callSettings({ callRecording: true, recordingAccess: "anyone" })).toMatchObject({ recording: false, recordingAccess: "editors" });
    expect(callSettings({ recordingAnnouncement: "x".repeat(1000) }).announcement).toHaveLength(300);
  });
});

describe("toll-fraud rules", () => {
  it("only dials ordinary numbers in allowed countries", () => {
    expect(dialableNumber("+14155550143", undefined, ["US"])).toEqual({ ok: true, e164: "+14155550143" });
    expect(dialableNumber("+442071838750", undefined, ["US"]).ok).toBe(false);
    expect(dialableNumber("+442071838750", undefined, ["US", "GB"]).ok).toBe(true);
    // No allowed countries at all means no calls, never "anywhere".
    expect(dialableNumber("+442071838750").ok).toBe(false);
  });
  it("defaults to the country of the CRM's own number when nothing is set", () => {
    const before = process.env.TWILIO_CALLER_ID;
    try {
      process.env.TWILIO_CALLER_ID = "+14155550100";
      expect(callSettings({}).allowedCallCountries).toEqual(["US"]);
      expect(callSettings({ defaultCountry: "AE" }).allowedCallCountries).toEqual(["AE"]);
      delete process.env.TWILIO_CALLER_ID;
      expect(callSettings({}).allowedCallCountries).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TWILIO_CALLER_ID;
      else process.env.TWILIO_CALLER_ID = before;
    }
  });
  it("refuses premium-rate, shared-cost and personal numbers", () => {
    for (const n of ["+19005550123", "+448449040000", "+447012345678"]) expect(dialableNumber(n, undefined, ["US", "GB"]).ok).toBe(false);
  });
});
