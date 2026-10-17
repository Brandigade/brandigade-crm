import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTwilioWebhook } from "../../../lib/server/voice/signature.js";
import { voiceRoutes } from "../../../lib/server/voice/routes.js";
import { createRouter } from "../../../lib/server/router.js";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { APP_URL, clientOf, crmDb, ids, setEnv, sid, twilioRequest, TWILIO } from "./helpers.js";

const env = { ...process.env };
beforeEach(() => setEnv());
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

const params = { CallSid: sid("CA", 1), From: clientOf(ids.editor), contactId: ids.maya, AccountSid: TWILIO.TWILIO_ACCOUNT_SID };

describe("X-Twilio-Signature", () => {
  it("accepts a correctly signed webhook (URL rebuilt from APP_URL, not the internal host)", async () => {
    await expect(readTwilioWebhook(twilioRequest("/api/voice/outbound", params))).resolves.toMatchObject({ contactId: ids.maya });
  });

  it("accepts the dev server's direct URL too", async () => {
    const req = twilioRequest("/api/voice/outbound", params, { requestUrl: "http://localhost:3103/api/voice/outbound" });
    await expect(readTwilioWebhook(req)).resolves.toMatchObject({ CallSid: params.CallSid });
  });

  it("rejects a tampered parameter", async () => {
    const req = twilioRequest("/api/voice/outbound", { ...params, contactId: ids.twinA }, { signedParams: params });
    await expect(readTwilioWebhook(req)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an extra parameter that wasn't signed", async () => {
    const req = twilioRequest("/api/voice/outbound", { ...params, number: "+19005550199" }, { signedParams: params });
    await expect(readTwilioWebhook(req)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a signature made for another URL", async () => {
    const req = twilioRequest("/api/voice/outbound", params, { signedUrl: APP_URL + "/api/voice/status" });
    await expect(readTwilioWebhook(req)).rejects.toMatchObject({ status: 403 });
    const otherHost = twilioRequest("/api/voice/outbound", params, { signedUrl: "https://evil.example/api/voice/outbound" });
    await expect(readTwilioWebhook(otherHost)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a signature made with another auth token", async () => {
    const req = twilioRequest("/api/voice/outbound", params, { signWith: "someone-elses-token" });
    await expect(readTwilioWebhook(req)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a correctly signed webhook for another Twilio account", async () => {
    const req = twilioRequest("/api/voice/outbound", { ...params, AccountSid: "AC" + "f".repeat(32) });
    await expect(readTwilioWebhook(req)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a missing header", async () => {
    await expect(readTwilioWebhook(twilioRequest("/api/voice/outbound", params, { noSignature: true }))).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when no auth token is configured", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: undefined });
    await expect(readTwilioWebhook(twilioRequest("/api/voice/outbound", params))).rejects.toMatchObject({ status: 503 });
  });

  it("every webhook route checks the signature before touching the database", async () => {
    const db = crmDb();
    __setAdminClientForTests(db.client);
    const handle = createRouter(voiceRoutes);
    for (const path of ["outbound", "incoming", "status", "dial-complete", "recording-status", "announce", "voicemail-done"]) {
      const res = await handle(twilioRequest(`/api/voice/${path}`, params, { signWith: "forged" }));
      expect(res.status, path).toBe(403);
      const unsigned = await handle(twilioRequest(`/api/voice/${path}`, params, { noSignature: true }));
      expect(unsigned.status, path).toBe(403);
    }
    expect(db.log).toEqual([]);
  });
});
