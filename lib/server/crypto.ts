import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env.js";

// Secrets at rest (OAuth refresh/access tokens, PKCE verifiers) are encrypted
// with AES-256-GCM. The key comes from TOKEN_ENCRYPTION_KEY and never leaves
// the server, so a copy of the database alone can't be used to read mail.
//
// Format: "v1." + base64url(iv[12] | authTag[16] | ciphertext)
// `aad` binds a ciphertext to its row (e.g. the account id), so tokens can't be
// swapped between rows.

const VERSION = "v1";

function key(): Buffer {
  const raw = requireEnv("TOKEN_ENCRYPTION_KEY");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptSecret(plaintext: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

export function decryptSecret(token: string, aad = ""): string {
  const [version, payload] = token.split(".", 2);
  if (version !== VERSION || !payload) throw new Error("Unsupported secret format");
  const buf = Buffer.from(payload, "base64url");
  if (buf.length < 29) throw new Error("Secret is too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE (RFC 7636) verifier and S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The S256 code challenge for a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
