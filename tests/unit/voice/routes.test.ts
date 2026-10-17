import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";

// The user-scoped Supabase client (row level security) comes from the in-memory db too.
const h = vi.hoisted(() => ({ userClient: (_token: string): any => null }));
vi.mock("../../../lib/server/supabase.js", async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, userClient: (token: string) => h.userClient(token) };
});

import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { createRouter } from "../../../lib/server/router.js";
import { voiceRoutes } from "../../../lib/server/voice/routes.js";
import { authed, clientOf, crmDb, ids, setEnv, sid, tokens, TWILIO, twilioRequest } from "./helpers.js";
import type { MemoryDb } from "./memory-db.js";

const env = { ...process.env };
const handle = createRouter(voiceRoutes);
let db: MemoryDb;

function use(settings: Record<string, unknown> = {}) {
  db = crmDb(settings);
  __setAdminClientForTests(db.client);
  const byToken: Record<string, string> = Object.fromEntries(Object.entries(tokens).map(([who, t]) => [t, (ids as any)[who]]));
  h.userClient = (token: string) => db.asUser(byToken[token]);
  return db;
}

beforeEach(() => {
  setEnv();
  use();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

/** Verifies an HS256 JWT (the Twilio access token) and returns its claims. */
function verifyJwt(token: string, secret: string): any {
  const [h, p, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error("bad signature");
  return JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
}
const decodeJwt = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

const calls = () => db.tables.calls;
const call = (params: Record<string, string>) => handle(twilioRequest("/api/voice/outbound", params));
const text = (r: Response) => r.text();
const say = (xml: string) => /<Say>([^<]*)<\/Say>/.exec(xml)?.[1] ?? "";

// ---------------------------------------------------------------------------
describe("POST /api/voice/token", () => {
  const token = (t?: string) => handle(new Request("https://crm.example/api/voice/token", { method: "POST", headers: t ? { authorization: `Bearer ${t}` } : {} }));

  it("gives owners and editors a short-lived token for their own identity", async () => {
    const res = await token(tokens.editor);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.identity).toBe("crm_" + ids.editor.replace(/-/g, ""));
    const claims = verifyJwt(body.token, TWILIO.TWILIO_API_KEY_SECRET);
    expect(claims.iss).toBe(TWILIO.TWILIO_API_KEY_SID);
    expect(claims.sub).toBe(TWILIO.TWILIO_ACCOUNT_SID);
    expect(claims.grants.identity).toBe(body.identity);
    expect(claims.grants.voice).toEqual({ incoming: { allow: true }, outgoing: { application_sid: TWILIO.TWILIO_TWIML_APP_SID } });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
    expect((await token(tokens.owner)).status).toBe(200);
  });

  it("doesn't let the browser ring for people who turned incoming calls off", async () => {
    const body: any = await (await token(tokens.editor2)).json();
    expect(body.incoming).toBe(false);
    const voice = decodeJwt(body.token).grants.voice;
    expect(voice.incoming).toBeUndefined(); // no incoming grant at all
    expect(voice.outgoing).toEqual({ application_sid: TWILIO.TWILIO_TWIML_APP_SID });
  });

  it("refuses viewers, outsiders and anonymous callers", async () => {
    expect((await token(tokens.viewer)).status).toBe(403);
    expect((await token(tokens.outsider)).status).toBe(403);
    expect((await token("forged")).status).toBe(401);
    expect((await token()).status).toBe(401);
  });

  it("answers 503 not_configured until every Twilio value is set", async () => {
    setEnv({ TWILIO_TWIML_APP_SID: undefined });
    const res = await token(tokens.editor);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_configured" });
  });
});

describe("GET /api/voice/setup", () => {
  it("is for the owner and lists only the names of missing settings", async () => {
    setEnv({ TWILIO_API_KEY_SECRET: undefined });
    const res = await handle(authed("/api/voice/setup", tokens.owner));
    const body: any = await res.json();
    expect(body).toMatchObject({ configured: false, missing: ["TWILIO_API_KEY_SECRET"], callerId: TWILIO.TWILIO_CALLER_ID });
    expect(JSON.stringify(body)).not.toContain(TWILIO.TWILIO_AUTH_TOKEN);
    expect((await handle(authed("/api/voice/setup", tokens.editor))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/voice/outbound", () => {
  const base = (over: Record<string, string> = {}) => ({ CallSid: sid("CA", 10), AccountSid: TWILIO.TWILIO_ACCOUNT_SID, From: clientOf(ids.editor), Caller: clientOf(ids.editor), ...over });

  it("dials the lead's saved number and records the call", async () => {
    const xml = await text(await call(base({ contactId: ids.maya })));
    expect(xml).toMatch(/<Number[^>]*>\+14155550143<\/Number>/);
    expect(xml).toContain(`callerId="${TWILIO.TWILIO_CALLER_ID}"`);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({
      provider_call_sid: sid("CA", 10), direction: "outbound", status: "initiated", user_id: ids.editor, contact_id: ids.maya,
      to_number: "+14155550143", from_number: TWILIO.TWILIO_CALLER_ID, recording_enabled: false, workspace_id: ids.ws,
    });
  });

  it("links the task and the task's deal", async () => {
    await call(base({ taskId: ids.task }));
    expect(calls()[0]).toMatchObject({ contact_id: ids.maya, task_id: ids.task, deal_id: ids.deal });
  });

  it("uses the company's number for a lead without one, and the company record's own number", async () => {
    const xml = await text(await call(base({ contactId: ids.noPhone })));
    expect(xml).toMatch(/>\+14155550142<\/Number>/);
    const xml2 = await text(await call(base({ CallSid: sid("CA", 11), companyId: ids.company })));
    expect(xml2).toMatch(/>\+14155550142<\/Number>/);
    expect(calls()[1]).toMatchObject({ contact_id: null, to_number: "+14155550142" });
  });

  it("is idempotent: a retried webhook returns the same TwiML and creates no second call", async () => {
    const first = await text(await call(base({ contactId: ids.maya })));
    const again = await text(await call(base({ contactId: ids.maya })));
    expect(again).toBe(first);
    expect(calls()).toHaveLength(1);
  });

  it("records only when the owner turned recording on", async () => {
    use({ callRecording: "on" });
    const xml = await text(await call(base({ contactId: ids.maya })));
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('url="https://crm.example/api/voice/announce"');
    expect(calls()[0].recording_enabled).toBe(true);
  });

  describe("authorization", () => {
    it.each([
      ["a viewer", clientOf(ids.viewer)],
      ["someone not on the team", clientOf(ids.outsider)],
      ["an unknown identity", "client:alice"],
      ["a phone number instead of a browser", "+14155550199"],
      ["nothing", ""],
    ])("refuses %s", async (_who, from) => {
      const xml = await text(await call(base({ From: from, Caller: from, contactId: ids.maya })));
      expect(say(xml)).toContain("isn't allowed");
      expect(xml).toContain("<Hangup/>");
      expect(xml).not.toContain("<Dial");
      expect(calls()).toHaveLength(0);
    });
  });

  describe("only numbers saved on CRM records", () => {
    it("ignores a number the browser sends as To", async () => {
      const xml = await text(await call(base({ contactId: ids.maya, To: "+19005550199" })));
      expect(xml).toMatch(/>\+14155550143<\/Number>/);
      expect(xml).not.toContain("9005550199");
    });
    it("refuses a 'number' that isn't on the record", async () => {
      const xml = await text(await call(base({ contactId: ids.maya, number: "+447700900123" })));
      expect(say(xml)).toContain("only calls numbers that are saved");
      expect(xml).not.toContain("<Dial");
      expect(calls()).toHaveLength(0);
    });
    it("accepts a 'number' that is one of the record's own numbers", async () => {
      const xml = await text(await call(base({ contactId: ids.maya, number: "(415) 555-0142" })));
      expect(xml).toMatch(/>\+14155550142<\/Number>/);
    });
    it("refuses with no record, a record in another workspace, or bad ids", async () => {
      for (const p of [{}, { contactId: ids.otherWsContact }, { contactId: "not-a-uuid" }, { contactId: "00000000-0000-4000-8000-00000000abcd" }, { taskId: ids.maya }] as Record<string, string>[]) {
        const xml = await text(await call(base(p)));
        expect(xml).not.toContain("<Dial");
      }
      expect(calls()).toHaveLength(0);
    });
    it("refuses records without a usable number and premium-rate numbers", async () => {
      db.tables.companies[0].phone = null;
      expect(say(await text(await call(base({ contactId: ids.noPhone }))))).toContain("no valid phone number");
      db.tables.contacts[0].phone = "+1 900 555 0199";
      expect(say(await text(await call(base({ contactId: ids.maya }))))).toContain("premium");
      expect(calls()).toHaveLength(0);
    });
    it("never calls its own number", async () => {
      db.tables.contacts[0].phone = TWILIO.TWILIO_CALLER_ID;
      expect(say(await text(await call(base({ contactId: ids.maya }))))).toContain("own number");
    });
  });

  it("a database failure ends the call politely instead of an application error", async () => {
    db.client.from = () => { throw new Error("db down"); };
    const res = await call(base({ contactId: ids.maya }));
    expect(res.status).toBe(200);
    expect(say(await text(res))).toContain("something went wrong");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/voice/incoming", () => {
  const ring = (from: string, n = 20) => handle(twilioRequest("/api/voice/incoming", { CallSid: sid("CA", n), From: from, To: TWILIO.TWILIO_CALLER_ID, AccountSid: TWILIO.TWILIO_ACCOUNT_SID, Direction: "inbound" }));

  it("rings every owner and editor who takes calls, with the call and matched lead", async () => {
    const xml = await text(await ring("+14155550143"));
    const row = calls()[0];
    expect(row).toMatchObject({ direction: "inbound", status: "ringing", contact_id: ids.maya, from_number: "+14155550143", user_id: null });
    const identities = [...xml.matchAll(/<Identity>([^<]+)<\/Identity>/g)].map((m) => m[1]).sort();
    expect(identities).toEqual([ids.owner, ids.editor].map((u) => "crm_" + u.replace(/-/g, "")).sort()); // not the viewer, not editor2 (turned off)
    expect(xml).toContain(`<Parameter name="callId" value="${row.id}"/>`);
    expect(xml).toContain(`<Parameter name="contactId" value="${ids.maya}"/>`);
    expect(xml).toContain('timeout="25"');
    expect(xml).toContain('action="https://crm.example/api/voice/dial-complete"');
    expect(xml).not.toContain("<Say>");
  });

  it("announces recording to the caller first when recording is on", async () => {
    use({ callRecording: "on", recordingAnnouncement: "Calls with Brandigade are recorded." });
    const xml = await text(await ring("+14155550143"));
    expect(xml.indexOf("<Say>Calls with Brandigade are recorded.</Say>")).toBeLessThan(xml.indexOf("<Dial"));
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('<Parameter name="recording" value="on"/>');
  });

  it("matches leads saved in another format; unknown and ambiguous callers get no lead", async () => {
    await ring("+13125550119", 21);
    await ring("+16465550187", 22);
    await ring("+12025550173", 23);
    await ring("anonymous", 24);
    const bySid = (n: number) => calls().find((c) => c.provider_call_sid === sid("CA", n))!;
    expect(bySid(21).contact_id).toBe(ids.national);
    expect(bySid(22).contact_id).toBeNull();
    expect(bySid(23).contact_id).toBeNull();
    expect(bySid(24)).toMatchObject({ contact_id: null, from_number: "anonymous" });
  });

  it("is idempotent", async () => {
    const a = await text(await ring("+14155550143"));
    const b = await text(await ring("+14155550143"));
    expect(b).toBe(a);
    expect(calls()).toHaveLength(1);
  });

  it("goes straight to voicemail when nobody takes calls in the browser", async () => {
    db.tables.user_preferences.push({ user_id: ids.owner, calls_receive_inbound: false }, { user_id: ids.editor, calls_receive_inbound: false });
    const xml = await text(await ring("+14155550143"));
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("<Record");
    expect(calls()[0].is_voicemail).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("call progress callbacks", () => {
  const PARENT = sid("CA", 30);
  const status = (p: Record<string, string>) => handle(twilioRequest("/api/voice/status", { AccountSid: TWILIO.TWILIO_ACCOUNT_SID, ...p }));
  const dial = (p: Record<string, string>) => handle(twilioRequest("/api/voice/dial-complete", { AccountSid: TWILIO.TWILIO_ACCOUNT_SID, CallSid: PARENT, ...p }));
  async function outgoing() {
    await call({ CallSid: PARENT, From: clientOf(ids.editor), contactId: ids.maya });
    return calls()[0];
  }

  it("outgoing: forward-only through out-of-order and duplicate callbacks", async () => {
    await outgoing();
    const CHILD = sid("CA", 31);
    const leg = (CallStatus: string, extra: Record<string, string> = {}) => status({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus, ...extra });
    await leg("ringing");
    await leg("completed", { CallDuration: "42" });
    await leg("in-progress"); // late
    await leg("ringing"); // late duplicate
    await leg("completed", { CallDuration: "42" }); // retry
    const xml = await text(await dial({ DialCallStatus: "completed", DialCallSid: CHILD, DialCallDuration: "42" }));
    expect(xml).toContain("<Hangup/>");
    expect(calls()[0]).toMatchObject({ status: "completed", duration_seconds: 42, provider_child_call_sid: CHILD });
    expect(calls()[0].ended_at).toBeTruthy();
  });

  it("outgoing: the browser's own status callback ends an unanswered call as cancelled", async () => {
    await outgoing();
    await status({ CallSid: sid("CA", 31), ParentCallSid: PARENT, CallStatus: "ringing" });
    await status({ CallSid: PARENT, CallStatus: "completed", CallDuration: "9" });
    expect(calls()[0]).toMatchObject({ status: "canceled", duration_seconds: 0 });
  });

  it("concurrent callbacks don't overwrite each other (optimistic concurrency)", async () => {
    await outgoing();
    let raced = false;
    db.beforeUpdate = (table, rows) => {
      // Another callback lands between our read and our write.
      if (table === "calls" && !raced) {
        raced = true;
        Object.assign(rows[0], { status: "in-progress", answered_at: "2026-10-17T10:00:08.000Z", updated_at: "2026-10-17T10:00:08.500Z" });
      }
    };
    await status({ CallSid: sid("CA", 31), ParentCallSid: PARENT, CallStatus: "ringing" });
    expect(calls()[0].status).toBe("in-progress"); // "ringing" was recomputed against the newer row and dropped
    expect(calls()[0].provider_child_call_sid).toBe(sid("CA", 31));
  });

  it("incoming: the browser that answers becomes the call's owner", async () => {
    await handle(twilioRequest("/api/voice/incoming", { CallSid: PARENT, From: "+14155550143", To: TWILIO.TWILIO_CALLER_ID }));
    const legA = sid("CA", 41), legB = sid("CA", 42);
    await status({ CallSid: legA, ParentCallSid: PARENT, CallStatus: "ringing", To: clientOf(ids.owner) });
    await status({ CallSid: legB, ParentCallSid: PARENT, CallStatus: "ringing", To: clientOf(ids.editor) });
    await status({ CallSid: legB, ParentCallSid: PARENT, CallStatus: "in-progress", To: clientOf(ids.editor) });
    await status({ CallSid: legA, ParentCallSid: PARENT, CallStatus: "canceled", To: clientOf(ids.owner) });
    await status({ CallSid: legB, ParentCallSid: PARENT, CallStatus: "completed", To: clientOf(ids.editor), CallDuration: "75" });
    await dial({ DialCallStatus: "completed", DialCallSid: legB, DialCallDuration: "75" });
    expect(calls()[0]).toMatchObject({ status: "completed", user_id: ids.editor, provider_child_call_sid: legB, duration_seconds: 75, is_voicemail: false });
  });

  it("incoming: an answer from someone who isn't an editor doesn't assign the call to them", async () => {
    await handle(twilioRequest("/api/voice/incoming", { CallSid: PARENT, From: "+14155550143", To: TWILIO.TWILIO_CALLER_ID }));
    await status({ CallSid: sid("CA", 43), ParentCallSid: PARENT, CallStatus: "in-progress", To: clientOf(ids.viewer) });
    expect(calls()[0].user_id).toBeNull();
  });

  it("incoming: nobody answers -> voicemail", async () => {
    await handle(twilioRequest("/api/voice/incoming", { CallSid: PARENT, From: "+14155550143", To: TWILIO.TWILIO_CALLER_ID }));
    await status({ CallSid: sid("CA", 41), ParentCallSid: PARENT, CallStatus: "no-answer", To: clientOf(ids.owner) });
    const xml = await text(await dial({ DialCallStatus: "no-answer" }));
    expect(xml).toContain("<Say>Sorry, nobody can take your call right now.");
    expect(xml).toMatch(/<Record [^>]*maxLength="120"/);
    expect(xml).toContain('recordingStatusCallback="https://crm.example/api/voice/recording-status"');
    expect(calls()[0]).toMatchObject({ status: "no-answer", is_voicemail: true, user_id: null });
    // A retried Dial action gives the same answer.
    expect(await text(await dial({ DialCallStatus: "no-answer" }))).toBe(xml);
    const thanks = await text(await handle(twilioRequest("/api/voice/voicemail-done", { CallSid: PARENT, RecordingDuration: "12" })));
    expect(thanks).toContain("<Hangup/>");
  });

  it("incoming: the caller hanging up while it rings doesn't go to voicemail", async () => {
    await handle(twilioRequest("/api/voice/incoming", { CallSid: PARENT, From: "+14155550143", To: TWILIO.TWILIO_CALLER_ID }));
    const xml = await text(await dial({ DialCallStatus: "canceled" }));
    expect(xml).not.toContain("<Record");
    expect(calls()[0]).toMatchObject({ status: "canceled", is_voicemail: false });
  });

  it("callbacks for calls the CRM doesn't know are acknowledged and ignored", async () => {
    const res = await status({ CallSid: sid("CA", 99), CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(0);
  });

  it("the announcement is the owner's text", async () => {
    use({ recordingAnnouncement: "Hello & welcome <3" });
    const xml = await text(await handle(twilioRequest("/api/voice/announce", { CallSid: sid("CA", 50), ParentCallSid: PARENT })));
    expect(xml).toContain("<Say>Hello &amp; welcome &lt;3</Say>");
    use();
    expect(await text(await handle(twilioRequest("/api/voice/announce", { CallSid: sid("CA", 50) })))).toContain("This call may be recorded for quality and training purposes.");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/voice/recording-status", () => {
  const PARENT = sid("CA", 60);
  const REC = sid("RE", 61);
  const rec = (p: Record<string, string>) => handle(twilioRequest("/api/voice/recording-status", { AccountSid: TWILIO.TWILIO_ACCOUNT_SID, CallSid: PARENT, RecordingSid: REC, ...p }));
  beforeEach(async () => {
    use({ callRecording: "on" });
    await call({ CallSid: PARENT, From: clientOf(ids.editor), contactId: ids.maya });
  });

  it("stores the recording and queues one copy job, however often Twilio retries", async () => {
    await rec({ RecordingStatus: "in-progress" });
    expect(calls()[0]).toMatchObject({ recording_sid: REC, recording_status: "in-progress" });
    await rec({ RecordingStatus: "completed", RecordingDuration: "61", RecordingSource: "DialVerb" });
    await rec({ RecordingStatus: "completed", RecordingDuration: "61", RecordingSource: "DialVerb" });
    expect(calls()[0]).toMatchObject({ recording_status: "completed", recording_duration_seconds: 61, is_voicemail: false });
    expect(db.tables.job_queue).toHaveLength(1);
    expect(db.tables.job_queue[0]).toMatchObject({ kind: "voice.copy_recording", dedupe_key: `voice_recording:${REC}`, payload: { call_id: calls()[0].id, recording_sid: REC }, workspace_id: ids.ws });
  });

  it("a late callback never undoes a recording that was already copied", async () => {
    await rec({ RecordingStatus: "completed", RecordingDuration: "61" });
    Object.assign(calls()[0], { recording_status: "available", recording_storage_path: `${ids.ws}/${calls()[0].id}.mp3` });
    db.tables.job_queue.length = 0;
    await rec({ RecordingStatus: "completed", RecordingDuration: "61" });
    await rec({ RecordingStatus: "in-progress" });
    expect(calls()[0].recording_status).toBe("available");
    expect(db.tables.job_queue).toHaveLength(0);
  });

  it("finds the call when Twilio reports the dialled leg's sid", async () => {
    calls()[0].provider_child_call_sid = sid("CA", 62);
    await handle(twilioRequest("/api/voice/recording-status", { CallSid: sid("CA", 62), RecordingSid: REC, RecordingStatus: "completed", RecordingDuration: "5" }));
    expect(calls()[0].recording_status).toBe("completed");
  });

  it("voicemail: a message marks the call, an empty one unmarks it", async () => {
    Object.assign(calls()[0], { direction: "inbound", is_voicemail: true });
    await rec({ RecordingStatus: "absent", RecordingSource: "RecordVerb" });
    expect(calls()[0]).toMatchObject({ is_voicemail: false, recording_status: "absent" });
    expect(db.tables.job_queue).toHaveLength(0);
  });

  it("ignores malformed recording sids and unknown calls", async () => {
    await rec({ RecordingSid: "RE-bogus", RecordingStatus: "completed" });
    await handle(twilioRequest("/api/voice/recording-status", { CallSid: sid("CA", 98), RecordingSid: REC, RecordingStatus: "completed" }));
    expect(calls()[0].recording_sid).toBeNull();
    expect(db.tables.job_queue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/voice/recordings/:callId", () => {
  let callId: string;
  const get = (who: keyof typeof tokens, id = callId) => handle(authed(`/api/voice/recordings/${id}`, tokens[who]));
  function seed(settings: Record<string, unknown>) {
    use(settings);
    callId = "abababab-abab-4bab-8bab-abababababab";
    db.tables.calls.push({
      id: callId, workspace_id: ids.ws, direction: "outbound", status: "completed", provider_call_sid: sid("CA", 70), user_id: ids.editor2,
      recording_sid: sid("RE", 70), recording_status: "available", recording_storage_path: `${ids.ws}/${callId}.mp3`, updated_at: "x",
    });
    db.storage.set(`call-recordings/${ids.ws}/${callId}.mp3`, { bytes: Buffer.from("ID3"), contentType: "audio/mpeg" });
  }

  it("signs a 5-minute link for people allowed to listen (default: owner and editors)", async () => {
    seed({});
    const res = await get("editor");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ url: expect.stringContaining(`call-recordings/${ids.ws}/${callId}.mp3`), expiresIn: 300 });
    expect(body.url).toContain("expires=300");
    expect((await get("owner")).status).toBe(200);
    expect((await get("viewer")).status).toBe(403);
    expect((await get("outsider")).status).toBe(403);
  });

  it("follows the owner's choice of who can listen", async () => {
    seed({ recordingAccess: "owner" });
    expect((await get("owner")).status).toBe(200);
    expect((await get("editor2")).status).toBe(200); // the person on the call
    expect((await get("editor")).status).toBe(403);
    seed({ recordingAccess: "all" });
    expect((await get("viewer")).status).toBe(200);
  });

  it("asks the database as the signed-in person, never with the service role", async () => {
    seed({});
    await get("viewer");
    const rpc = db.log.filter((l) => l.table === "rpc:can_play_recording");
    expect(rpc).toHaveLength(1);
    expect(rpc[0].args).toEqual({ p_call: callId });
  });

  it("404 when there is no recording (yet); 401 without a session", async () => {
    seed({});
    db.tables.calls[0].recording_status = "completed";
    expect((await get("editor")).status).toBe(404);
    expect((await get("editor", "not-a-uuid")).status).toBe(404);
    expect((await handle(new Request(`https://crm.example/api/voice/recordings/${callId}`))).status).toBe(401);
  });

  it("refuses a storage path outside the call's workspace", async () => {
    seed({});
    db.tables.calls[0].recording_storage_path = "other-workspace/x.mp3";
    expect((await get("editor")).status).toBe(404);
  });
});
