import { describe, expect, it } from "vitest";
import { createRouter, publicUrl, requestPath } from "../../../lib/server/router.js";
import { badRequest, errorResponse, forbidden, json, readForm, readJson } from "../../../lib/server/http.js";

describe("router", () => {
  const handle = createRouter([
    { method: "GET", path: "/api/things/:id", handler: (_req, ctx) => json({ id: ctx.params.id }) },
    { method: "POST", path: "/api/things", handler: () => { throw badRequest("nope"); } },
    { method: "GET", path: "/api/boom", handler: () => { throw new Error("secret internals"); } },
    { method: "GET", path: "/api/forbidden", handler: () => { throw forbidden(); } },
  ]);

  it("matches params", async () => {
    const r = await handle(new Request("http://x/api/things/a%20b"));
    expect(await r.json()).toEqual({ id: "a b" });
  });
  it("works through Vercel's rewrite (?__path=)", async () => {
    const r = await handle(new Request("http://x/api?__path=things/42"));
    expect(await r.json()).toEqual({ id: "42" });
  });
  it("404 and 405", async () => {
    expect((await handle(new Request("http://x/api/nothing"))).status).toBe(404);
    expect((await handle(new Request("http://x/api/things/1", { method: "DELETE" }))).status).toBe(405);
  });
  it("maps HttpError to its status and JSON", async () => {
    const r = await handle(new Request("http://x/api/things", { method: "POST" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "nope", code: "bad_request" });
    expect((await handle(new Request("http://x/api/forbidden"))).status).toBe(403);
  });
  it("never leaks unexpected error details", async () => {
    const r = await handle(new Request("http://x/api/boom"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret internals");
  });
  it("responses are not cacheable", async () => {
    const r = await handle(new Request("http://x/api/things/1"));
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("request paths", () => {
  it("prefers the original path", () => {
    expect(requestPath(new URL("http://x/api/voice/status"))).toBe("/api/voice/status");
    expect(requestPath(new URL("http://x/api?__path=voice/status"))).toBe("/api/voice/status");
  });
  it("publicUrl uses APP_URL (not Host) and drops the rewrite parameter", () => {
    const req = new Request("http://evil.example/api?__path=voice/status&CallSid=CA1&b=2");
    expect(publicUrl(req, "https://crm.example/")).toBe("https://crm.example/api/voice/status?CallSid=CA1&b=2");
    expect(publicUrl(new Request("http://localhost/api/voice/status"), "https://crm.example")).toBe("https://crm.example/api/voice/status");
  });
});

describe("body parsing", () => {
  it("readJson parses, rejects bad JSON and oversized bodies", async () => {
    await expect(readJson(new Request("http://x", { method: "POST", body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
    await expect(readJson(new Request("http://x", { method: "POST", body: "{nope" }))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(new Request("http://x", { method: "POST", body: "x".repeat(2000) }), 1000)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request("http://x", { method: "POST" }))).resolves.toEqual({});
  });
  it("readForm parses Twilio-style bodies", async () => {
    const r = new Request("http://x", { method: "POST", body: "CallSid=CA1&From=%2B15550001&To=client%3Au_1" });
    await expect(readForm(r)).resolves.toEqual({ CallSid: "CA1", From: "+15550001", To: "client:u_1" });
  });
  it("errorResponse hides configuration details", async () => {
    const e = Object.assign(new Error("TWILIO_AUTH_TOKEN is not set"), { name: "ConfigError" });
    const r = errorResponse(e);
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("TWILIO");
  });
});
