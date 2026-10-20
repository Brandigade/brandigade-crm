// Shared fixtures for the voice tests: fake Twilio settings, a small CRM in
// memory and webhook requests signed exactly the way Twilio signs them.
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { memoryDb, type Row } from "./memory-db.js";

export const APP_URL = "https://crm.example";
export const TWILIO = {
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
  TWILIO_AUTH_TOKEN: "test-auth-token-0123456789abcdef",
  TWILIO_API_KEY_SID: "SK" + "b".repeat(32),
  TWILIO_API_KEY_SECRET: "test-api-key-secret",
  TWILIO_TWIML_APP_SID: "AP" + "c".repeat(32),
  TWILIO_CALLER_ID: "+14155550100",
};

export const ids = {
  ws: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  editor: "33333333-3333-4333-8333-333333333333",
  viewer: "44444444-4444-4444-8444-444444444444",
  outsider: "55555555-5555-4555-8555-555555555555",
  editor2: "66666666-6666-4666-8666-666666666666",
  company: "77777777-7777-4777-8777-777777777777",
  maya: "88888888-8888-4888-8888-888888888888",
  noPhone: "99999999-9999-4999-8999-999999999999",
  twinA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  twinB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  national: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  deal: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  task: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  otherWsContact: "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0",
};

export const tokens = { owner: "tok-owner", editor: "tok-editor", viewer: "tok-viewer", outsider: "tok-outsider", editor2: "tok-editor2" };

export const sid = (prefix: string, n: number) => prefix + n.toString(16).padStart(32, "0");

export function setEnv(extra: Record<string, string | undefined> = {}) {
  process.env.SUPABASE_URL = "http://sb.test";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.APP_URL = APP_URL;
  Object.assign(process.env, TWILIO);
  delete process.env.TWILIO_API_BASE;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export function crmData(settings: Record<string, unknown> = {}): Record<string, Row[]> {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return {
    workspaces: [{ id: ids.ws, name: "Brandigade", settings: { defaultCountry: "US", ...settings }, created_at: at(0) }],
    workspace_members: [
      { workspace_id: ids.ws, user_id: ids.owner, role: "owner", created_at: at(1) },
      { workspace_id: ids.ws, user_id: ids.editor, role: "editor", created_at: at(2) },
      { workspace_id: ids.ws, user_id: ids.viewer, role: "viewer", created_at: at(3) },
      { workspace_id: ids.ws, user_id: ids.editor2, role: "editor", created_at: at(4) },
    ],
    profiles: [ids.owner, ids.editor, ids.viewer, ids.outsider, ids.editor2].map((id) => ({ id, is_platform_admin: false })),
    companies: [{ id: ids.company, workspace_id: ids.ws, name: "Cedar & Crumb", phone: "+1 415 555 0142" }],
    contacts: [
      { id: ids.maya, workspace_id: ids.ws, first_name: "Maya", phone: "+1 (415) 555-0143", company_id: ids.company },
      { id: ids.noPhone, workspace_id: ids.ws, first_name: "Nophone", phone: null, company_id: ids.company },
      { id: ids.twinA, workspace_id: ids.ws, first_name: "Twin A", phone: "+1 646 555 0187" },
      { id: ids.twinB, workspace_id: ids.ws, first_name: "Twin B", phone: "646-555-0187" },
      { id: ids.national, workspace_id: ids.ws, first_name: "National", phone: "(312) 555-0119" },
      { id: ids.otherWsContact, workspace_id: "00000000-0000-4000-8000-000000000000", first_name: "Elsewhere", phone: "+1 212 555 0100" },
    ],
    deals: [{ id: ids.deal, workspace_id: ids.ws, title: "Rebrand", contact_id: ids.maya }],
    tasks: [{ id: ids.task, workspace_id: ids.ws, title: "Follow up", contact_id: ids.maya, deal_id: ids.deal }],
    user_preferences: [{ user_id: ids.editor2, calls_receive_inbound: false }],
    calls: [],
    job_queue: [],
  };
}

export function crmDb(settings: Record<string, unknown> = {}) {
  return memoryDb(crmData(settings), {
    users: {
      [tokens.owner]: { id: ids.owner },
      [tokens.editor]: { id: ids.editor },
      [tokens.viewer]: { id: ids.viewer },
      [tokens.outsider]: { id: ids.outsider },
      [tokens.editor2]: { id: ids.editor2 },
    },
  });
}

/** client:<identity> for a user, as the Voice SDK sends it in From. */
export const clientOf = (userId: string) => "client:crm_" + userId.replace(/-/g, "");

/** A webhook request exactly as Twilio would send it (form body + X-Twilio-Signature). */
export function twilioRequest(
  path: string,
  params: Record<string, string>,
  o: { signWith?: string; signedUrl?: string; signedParams?: Record<string, string>; noSignature?: boolean; requestUrl?: string } = {},
): Request {
  const url = o.signedUrl ?? APP_URL + path;
  const signature = getExpectedTwilioSignature(o.signWith ?? TWILIO.TWILIO_AUTH_TOKEN, url, o.signedParams ?? params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (!o.noSignature) headers["x-twilio-signature"] = signature;
  // The handler sees an internal address; the signature is over the public one.
  const reqUrl = o.requestUrl ?? `http://internal.example${path}`;
  return new Request(reqUrl, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}

export function authed(path: string, token: string, init: RequestInit = {}): Request {
  return new Request("https://crm.example" + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
}
