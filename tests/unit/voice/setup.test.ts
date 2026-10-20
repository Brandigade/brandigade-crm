import { describe, expect, it } from "vitest";
import { checkAppUrl, setupTwilio, TWIML_APP_NAME } from "../../../lib/server/voice/twilio-setup.js";

// scripts/setup-twilio.ts against a fake Twilio REST API (never a real account).
const AC = "AC" + "a".repeat(32);

function fakeTwilio(state: { apps: { sid: string; friendly_name: string }[]; numbers: { sid: string; phone_number: string }[] }) {
  const requests: { method: string; path: string; form: Record<string, string>; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(`/2010-04-01/Accounts/${AC}`, "");
    const form = Object.fromEntries(new URLSearchParams(String(init.body || "")));
    requests.push({ method: init.method || "GET", path: path + u.search, form, auth: (init.headers as Record<string, string>).Authorization });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/Applications.json" && init.method === "GET") return json({ applications: state.apps.filter((a) => a.friendly_name === u.searchParams.get("FriendlyName")) });
    if (path === "/Applications.json" && init.method === "POST") { const app = { sid: "AP" + "9".repeat(32), friendly_name: form.FriendlyName }; state.apps.push(app); return json(app, 201); }
    const appMatch = /^\/Applications\/(AP\w+)\.json$/.exec(path);
    if (appMatch) { const app = state.apps.find((a) => a.sid === appMatch[1]); return app ? json(app) : json({ message: "not found" }, 404); }
    if (path === "/IncomingPhoneNumbers.json") return json({ incoming_phone_numbers: state.numbers.filter((n) => n.phone_number === u.searchParams.get("PhoneNumber")) });
    if (/^\/IncomingPhoneNumbers\/PN\w+\.json$/.test(path)) return json({ sid: path.slice(22, 56) });
    return json({ message: "unexpected " + path }, 400);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const base = { accountSid: AC, username: "SKkey", password: "secret", appUrl: "https://crm.example", apiBase: "http://twilio.test" };

describe("setup-twilio", () => {
  it("creates the TwiML App and points the number at the CRM", async () => {
    const t = fakeTwilio({ apps: [], numbers: [{ sid: "PN" + "1".repeat(32), phone_number: "+14155550100" }] });
    const r = await setupTwilio({ ...base, callerId: "+14155550100", fetchImpl: t.fetchImpl });
    expect(r).toMatchObject({ twimlAppSid: "AP" + "9".repeat(32), twimlAppAction: "created", phoneNumberSid: "PN" + "1".repeat(32), phoneNumberAction: "updated" });
    const create = t.requests.find((q) => q.method === "POST" && q.path === "/Applications.json")!;
    expect(create.form).toEqual({
      FriendlyName: TWIML_APP_NAME, VoiceUrl: "https://crm.example/api/voice/outbound", VoiceMethod: "POST",
      StatusCallback: "https://crm.example/api/voice/status", StatusCallbackMethod: "POST",
    });
    const num = t.requests.find((q) => q.method === "POST" && q.path.startsWith("/IncomingPhoneNumbers/"))!;
    expect(num.form).toMatchObject({ VoiceUrl: "https://crm.example/api/voice/incoming", VoiceMethod: "POST" });
    expect(Buffer.from(create.auth.replace("Basic ", ""), "base64").toString()).toBe("SKkey:secret");
  });

  it("updates the existing app instead of creating another one", async () => {
    const t = fakeTwilio({ apps: [{ sid: "AP" + "5".repeat(32), friendly_name: TWIML_APP_NAME }], numbers: [] });
    const r = await setupTwilio({ ...base, appUrl: "https://new.example/", fetchImpl: t.fetchImpl });
    expect(r).toMatchObject({ twimlAppSid: "AP" + "5".repeat(32), twimlAppAction: "updated", phoneNumberAction: "skipped" });
    expect(t.requests.filter((q) => q.method === "POST")).toHaveLength(1);
    expect(t.requests.find((q) => q.method === "POST")!.form.VoiceUrl).toBe("https://new.example/api/voice/outbound");
  });

  it("dry run changes nothing", async () => {
    const t = fakeTwilio({ apps: [], numbers: [{ sid: "PN" + "1".repeat(32), phone_number: "+14155550100" }] });
    const r = await setupTwilio({ ...base, callerId: "+14155550100", dryRun: true, fetchImpl: t.fetchImpl });
    expect(r).toMatchObject({ twimlAppAction: "would-create", phoneNumberAction: "would-update" });
    expect(t.requests.every((q) => q.method === "GET")).toBe(true);
  });

  it("says when the caller ID isn't a number on the account", async () => {
    const t = fakeTwilio({ apps: [], numbers: [] });
    const lines: string[] = [];
    const r = await setupTwilio({ ...base, callerId: "+14155550100", fetchImpl: t.fetchImpl, log: (l) => lines.push(l) });
    expect(r.phoneNumberAction).toBe("not-found");
    expect(lines.join("\n")).toContain("isn't a phone number on this Twilio account");
  });

  it("a given TwiML App SID must exist", async () => {
    const t = fakeTwilio({ apps: [], numbers: [] });
    await expect(setupTwilio({ ...base, twimlAppSid: "AP" + "7".repeat(32), fetchImpl: t.fetchImpl })).rejects.toThrow(/404/);
  });

  it("only public https addresses can be webhook targets", () => {
    expect(checkAppUrl("https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1")).toBeNull();
    expect(checkAppUrl("http://wqdysxpormmxxaakfgtu.supabase.co/functions/v1")).toMatch(/https/);
    expect(checkAppUrl("https://localhost:3000")).toMatch(/internet/);
    expect(checkAppUrl("nope")).toMatch(/valid/);
  });
});
