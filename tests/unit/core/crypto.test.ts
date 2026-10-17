import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, pkcePair, randomToken, safeEqual, sha256Hex } from "../../../lib/server/crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("token encryption", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  });

  it("round-trips and never contains the plaintext", () => {
    const ct = encryptSecret("1//refresh-token-value", "account-1");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(ct).not.toContain("refresh-token-value");
    expect(decryptSecret(ct, "account-1")).toBe("1//refresh-token-value");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", "a")).not.toBe(encryptSecret("same", "a"));
  });

  it("is bound to its row: a token moved to another account fails", () => {
    const ct = encryptSecret("secret", "account-1");
    expect(() => decryptSecret(ct, "account-2")).toThrow();
  });

  it("detects tampering", () => {
    const ct = encryptSecret("secret", "a");
    const raw = Buffer.from(ct.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret("v1." + raw.toString("base64url"), "a")).toThrow();
  });

  it("fails with a different key", () => {
    const ct = encryptSecret("secret", "a");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(ct, "a")).toThrow();
  });

  it("refuses a key of the wrong length or no key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret("v0.abc")).toThrow();
    expect(() => decryptSecret("v1.")).toThrow();
  });
});

describe("helpers", () => {
  it("PKCE challenge is the S256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
  it("random tokens are url-safe and unique", () => {
    const a = randomToken(), b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
  it("sha256Hex and safeEqual", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
