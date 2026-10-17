// Creates or updates the Twilio side of calling (used by scripts/setup-twilio.ts):
//   * a TwiML App "Brandigade CRM" whose Voice URL is APP_URL/api/voice/outbound
//     (browser calls) and whose status callback is APP_URL/api/voice/status
//   * the TWILIO_CALLER_ID phone number's Voice URL -> APP_URL/api/voice/incoming
// Plain REST calls (form-encoded, basic auth) so the base URL can be a fake in tests.

export const TWIML_APP_NAME = "Brandigade CRM";

export interface SetupOptions {
  accountSid: string;
  /** API key SID + secret, or the Account SID + auth token. */
  username: string;
  password: string;
  appUrl: string;
  callerId?: string;
  /** Update this TwiML App instead of looking one up by name. */
  twimlAppSid?: string;
  apiBase?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface SetupResult {
  twimlAppSid: string | null;
  twimlAppAction: "created" | "updated" | "would-create" | "would-update";
  phoneNumberSid: string | null;
  phoneNumberAction: "updated" | "would-update" | "not-found" | "skipped";
  urls: { voice: string; status: string; incoming: string };
}

export function setupUrls(appUrl: string) {
  const base = appUrl.replace(/\/+$/, "");
  return { voice: `${base}/api/voice/outbound`, status: `${base}/api/voice/status`, incoming: `${base}/api/voice/incoming` };
}

export function checkAppUrl(appUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(appUrl);
  } catch {
    return "APP_URL isn't a valid URL.";
  }
  if (u.protocol !== "https:") return "APP_URL must be the public https:// address of the CRM (Twilio can't reach localhost).";
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) return "APP_URL must be reachable from the internet.";
  return null;
}

export async function setupTwilio(o: SetupOptions): Promise<SetupResult> {
  const base = (o.apiBase || "https://api.twilio.com").replace(/\/+$/, "");
  const doFetch = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});
  const auth = "Basic " + Buffer.from(`${o.username}:${o.password}`).toString("base64");
  const account = `${base}/2010-04-01/Accounts/${encodeURIComponent(o.accountSid)}`;
  const urls = setupUrls(o.appUrl);

  async function call(method: "GET" | "POST", path: string, form?: Record<string, string>) {
    const res = await doFetch(account + path, {
      method,
      headers: { Authorization: auth, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    if (!res.ok) throw new Error(`Twilio ${method} ${path.split("?")[0]} failed (${res.status}): ${body?.message || "no details"}`);
    return body;
  }

  const appForm = {
    FriendlyName: TWIML_APP_NAME,
    VoiceUrl: urls.voice,
    VoiceMethod: "POST",
    StatusCallback: urls.status,
    StatusCallbackMethod: "POST",
  };

  // 1. The TwiML App.
  let appSid: string | null = o.twimlAppSid || null;
  if (!appSid) {
    const list = await call("GET", `/Applications.json?FriendlyName=${encodeURIComponent(TWIML_APP_NAME)}&PageSize=20`);
    const apps = (list.applications || []) as { sid: string; friendly_name: string }[];
    const same = apps.filter((a) => a.friendly_name === TWIML_APP_NAME);
    if (same.length > 1) log(`Found ${same.length} TwiML Apps named "${TWIML_APP_NAME}"; updating the first (${same[0].sid}).`);
    appSid = same[0]?.sid || null;
  } else {
    await call("GET", `/Applications/${encodeURIComponent(appSid)}.json`); // must exist on this account
  }
  let appAction: SetupResult["twimlAppAction"];
  if (appSid) {
    appAction = o.dryRun ? "would-update" : "updated";
    if (!o.dryRun) await call("POST", `/Applications/${encodeURIComponent(appSid)}.json`, appForm);
  } else if (o.dryRun) {
    appAction = "would-create";
  } else {
    const created = await call("POST", "/Applications.json", appForm);
    appSid = created.sid as string;
    appAction = "created";
  }
  log(`TwiML App ${appSid || "(new)"}: ${appAction} (Voice URL ${urls.voice}, status callback ${urls.status})`);

  // 2. The phone number that receives calls.
  let numberSid: string | null = null;
  let numberAction: SetupResult["phoneNumberAction"] = "skipped";
  if (o.callerId) {
    const list = await call("GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(o.callerId)}`);
    const found = (list.incoming_phone_numbers || [])[0] as { sid: string } | undefined;
    if (!found) {
      numberAction = "not-found";
      log(`${o.callerId} isn't a phone number on this Twilio account, so incoming calls can't be set up (a verified caller ID can only be used for outgoing calls).`);
    } else {
      numberSid = found.sid;
      numberAction = o.dryRun ? "would-update" : "updated";
      if (!o.dryRun) {
        await call("POST", `/IncomingPhoneNumbers/${encodeURIComponent(found.sid)}.json`, {
          VoiceUrl: urls.incoming,
          VoiceMethod: "POST",
          StatusCallback: urls.status,
          StatusCallbackMethod: "POST",
        });
      }
      log(`Phone number ${o.callerId} (${found.sid}): ${numberAction} (Voice URL ${urls.incoming})`);
    }
  }
  return { twimlAppSid: appSid, twimlAppAction: appAction, phoneNumberSid: numberSid, phoneNumberAction: numberAction, urls };
}
