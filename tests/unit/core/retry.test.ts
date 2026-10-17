import { describe, expect, it, vi } from "vitest";
import { expectJson, fetchWithRetry, parseRetryAfter, ProviderError, RateLimitError } from "../../../lib/server/retry.js";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const noSleep = async () => {};

describe("fetchWithRetry", () => {
  it("returns a successful response straight away", async () => {
    const f = vi.fn(async () => res(200, { ok: 1 }));
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry client errors", async () => {
    const f = vi.fn(async () => res(400, { error: "bad" }));
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep });
    expect(r.status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const sleeps: number[] = [];
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps.length).toBe(2);
  });

  it("honours a short Retry-After on 429", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, {}, { "retry-after": "2" })).mockResolvedValueOnce(res(200));
    const sleeps: number[] = [];
    await fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("throws RateLimitError when the provider asks to wait longer than allowed", async () => {
    const f = vi.fn(async () => res(429, {}, { "retry-after": "3600" }));
    await expect(fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep, maxDelayMs: 20_000 })).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfterMs: 3_600_000,
    });
  });

  it("throws RateLimitError when 429 persists", async () => {
    const f = vi.fn(async () => res(429));
    await expect(fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep, retries: 2 })).rejects.toBeInstanceOf(RateLimitError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives back the last 5xx so the caller can read it", async () => {
    const f = vi.fn(async () => res(502, "bad gateway"));
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep, retries: 1 });
    expect(r.status).toBe(502);
  });

  it("rethrows the network error after the last attempt", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(fetchWithRetry("https://x", {}, { fetchImpl: f as any, sleep: noSleep, retries: 1 })).rejects.toThrow("offline");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(parseRetryAfter("Sat, 17 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("expectJson", () => {
  it("returns the body for 2xx", async () => {
    await expect(expectJson(res(200, { a: 1 }), "x")).resolves.toEqual({ a: 1 });
  });
  it("throws ProviderError with the provider's message", async () => {
    await expect(expectJson(res(401, { error: { message: "Invalid Credentials" } }), "Gmail")).rejects.toMatchObject({
      name: "ProviderError",
      status: 401,
      message: "Gmail: Invalid Credentials",
    });
    await expect(expectJson(res(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }), "Google token")).rejects.toBeInstanceOf(ProviderError);
  });
});
