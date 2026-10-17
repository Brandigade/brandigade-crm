// Signed fake Twilio webhooks sent to the real handlers, against the LOCAL
// Supabase stack (http://127.0.0.1:57321, keys in .env.local): calls rows,
// the calls_timeline trigger (get_timeline as the editor), set_call_disposition,
// the recording copy into Storage and the signed link. Skipped when the local
// stack isn't running (e.g. in CI). Every row it creates is named CALLTEST and
// removed afterwards.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { createRouter } from "../../../lib/server/router.js";
import { voiceRoutes } from "../../../lib/server/voice/routes.js";
import { copyRecording } from "../../../lib/server/voice/worker.js";
import type { Job } from "../../../lib/server/jobs.js";
import { APP_URL, clientOf, TWILIO, twilioRequest } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const local = readEnvFile(path.join(root, ".env.local"));
const users = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/local-users.json"), "utf8"));

async function reachable(): Promise<boolean> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(local.SUPABASE_URL || "") || !local.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const res = await fetch(`${local.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: local.SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
const available = await reachable();

const randomSid = (prefix: string) => prefix + randomBytes(16).toString("hex");
const MP3 = Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00"), randomBytes(2048)]);

describe.skipIf(!available)("voice webhooks against the local Supabase", () => {
  const envBefore = { ...process.env };
  const handle = createRouter(voiceRoutes);
  let admin: SupabaseClient;
  let twilioApi: http.Server;
  let ws: string;
  const people: Record<string, { id: string; token: string; db: SupabaseClient }> = {};
  let originalSettings: Record<string, unknown> | null = null;
  const created = { contact: "", deal: "", task: "", calls: [] as string[], recordings: [] as string[], storage: [] as string[] };
  const digits = String(100 + Math.floor(Math.random() * 899));
  const leadPhone = `+44 20 7946 0${digits}`; // Ofcom's range for fiction: never a real line
  const leadE164 = `+442079460${digits}`;

  beforeAll(async () => {
    Object.assign(process.env, {
      SUPABASE_URL: local.SUPABASE_URL,
      SUPABASE_ANON_KEY: local.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SUPABASE_SERVICE_ROLE_KEY,
      APP_URL,
      ...TWILIO,
    });
    __setAdminClientForTests(null);
    admin = createClient(local.SUPABASE_URL, local.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // A stand-in for Twilio's REST API that serves the recording's MP3.
    twilioApi = http.createServer((req, res) => {
      const auth = Buffer.from(String(req.headers.authorization || "").replace("Basic ", ""), "base64").toString();
      if (auth !== `${TWILIO.TWILIO_API_KEY_SID}:${TWILIO.TWILIO_API_KEY_SECRET}`) { res.writeHead(401).end(); return; }
      const m = /^\/2010-04-01\/Accounts\/AC\w+\/Recordings\/(RE\w+)\.mp3$/.exec(req.url || "");
      if (!m || !created.recordings.includes(m[1])) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": MP3.length }).end(MP3);
    });
    await new Promise<void>((r) => twilioApi.listen(0, "127.0.0.1", () => r()));
    process.env.TWILIO_API_BASE = `http://127.0.0.1:${(twilioApi.address() as { port: number }).port}`;

    const { data: w } = await admin.from("workspaces").select("id,settings").limit(1).single();
    ws = w!.id;
    // The lead's number is British and the CRM's number American: allow both.
    originalSettings = (w!.settings || {}) as Record<string, unknown>;
    const { error: sErr } = await admin.from("workspaces").update({ settings: { ...originalSettings, allowedCallCountries: ["GB", "US"] } }).eq("id", ws);
    if (sErr) throw sErr;
    for (const who of ["editor", "viewer"]) {
      const db = createClient(local.SUPABASE_URL, local.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data, error } = await db.auth.signInWithPassword({ email: users[who].email, password: users[who].password });
      if (error || !data.session) throw error || new Error("sign-in failed");
      people[who] = { id: data.user!.id, token: data.session.access_token, db };
    }
    const { data: c, error: cErr } = await admin.from("contacts").insert({ workspace_id: ws, first_name: "CALLTEST Lea", phone: leadPhone }).select("id").single();
    if (cErr) throw cErr;
    created.contact = c!.id;
    const { data: d } = await admin.from("deals").insert({ workspace_id: ws, title: "CALLTEST Deal", contact_id: created.contact, value: 1000 }).select("id").single();
    created.deal = d!.id;
    const { data: t } = await admin.from("tasks").insert({ workspace_id: ws, title: "CALLTEST Task", contact_id: created.contact, deal_id: created.deal }).select("id").single();
    created.task = t!.id;
  });

  afterAll(async () => {
    try {
      if (originalSettings) await admin.from("workspaces").update({ settings: originalSettings }).eq("id", ws);
      if (created.storage.length) await admin.storage.from("call-recordings").remove(created.storage);
      if (created.recordings.length) await admin.from("job_queue").delete().in("dedupe_key", created.recordings.map((r) => `voice_recording:${r}`));
      if (created.calls.length) {
        await admin.from("activities").delete().in("call_id", created.calls);
        await admin.from("calls").delete().in("id", created.calls);
      }
      if (created.task) await admin.from("tasks").delete().eq("id", created.task);
      if (created.deal) await admin.from("deals").delete().eq("id", created.deal);
      if (created.contact) await admin.from("contacts").delete().eq("id", created.contact);
      await admin.from("activities").delete().like("subject", "CALLTEST%");
    } finally {
      await new Promise<void>((r) => twilioApi?.close(() => r()));
      process.env = { ...envBefore };
      __setAdminClientForTests(null);
    }
  });

  const post = (p: string, params: Record<string, string>) => handle(twilioRequest(p, { AccountSid: TWILIO.TWILIO_ACCOUNT_SID, ...params }));
  const callBySid = async (sid: string) => (await admin.from("calls").select("*").eq("provider_call_sid", sid).maybeSingle()).data;
  const timeline = async (who: string) => {
    const { data, error } = await people[who].db.rpc("get_timeline", { p_kind: "contact", p_id: created.contact, p_limit: 50 });
    if (error) throw error;
    return data as any[];
  };

  it("an editor's outgoing call: row, forward-only status, one timeline item, outcome, recording, signed link", async () => {
    const parent = randomSid("CA");
    const childSid = randomSid("CA");
    const xml = await (await post("/api/voice/outbound", { CallSid: parent, From: clientOf(people.editor.id), taskId: created.task })).text();
    expect(xml).toContain(`>${leadE164}</Number>`);
    const row = await callBySid(parent);
    expect(row).toMatchObject({ direction: "outbound", status: "initiated", user_id: people.editor.id, contact_id: created.contact, task_id: created.task, deal_id: created.deal, to_number: leadE164 });
    created.calls.push(row.id);

    const leg = (CallStatus: string, extra: Record<string, string> = {}) => post("/api/voice/status", { CallSid: childSid, ParentCallSid: parent, CallStatus, ...extra });
    await leg("initiated");
    await leg("ringing");
    await leg("completed", { CallDuration: "37" }); // before "answered"
    await leg("in-progress"); // late
    await leg("completed", { CallDuration: "37" }); // retry
    await post("/api/voice/dial-complete", { CallSid: parent, DialCallSid: childSid, DialCallStatus: "completed", DialCallDuration: "37" });
    expect(await callBySid(parent)).toMatchObject({ status: "completed", duration_seconds: 37, provider_child_call_sid: childSid });

    let items = (await timeline("editor")).filter((a) => a.call_id === row.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "call", source: "call", event: "outbound", subject: "Outgoing call", deal_id: created.deal });
    expect(items[0].call).toMatchObject({ status: "completed", duration_seconds: 37, user_id: people.editor.id });

    const { error: dispErr } = await people.editor.db.rpc("set_call_disposition", { p_call: row.id, p_disposition: "connected", p_notes: "CALLTEST notes" });
    expect(dispErr).toBeNull();
    const { error: viewerErr } = await people.viewer.db.rpc("set_call_disposition", { p_call: row.id, p_disposition: "busy", p_notes: "" });
    expect(viewerErr).toBeTruthy();

    // Recording: callback -> one queued copy job -> MP3 in private storage -> signed link.
    const rec = randomSid("RE");
    created.recordings.push(rec);
    for (let i = 0; i < 2; i++) {
      await post("/api/voice/recording-status", { CallSid: parent, RecordingSid: rec, RecordingStatus: "completed", RecordingDuration: "36", RecordingSource: "DialVerb" });
    }
    const { data: jobs } = await admin.from("job_queue").select("*").eq("dedupe_key", `voice_recording:${rec}`);
    expect(jobs).toHaveLength(1);
    const job = { ...jobs![0], attempts: 1 } as Job;
    expect(await copyRecording(job, { deadline: Date.now() + 60_000 })).toMatchObject({ status: "done" });
    created.storage.push(`${ws}/${row.id}.mp3`);
    expect(await copyRecording(job, { deadline: Date.now() + 60_000 })).toMatchObject({ status: "skipped" });
    expect(await callBySid(parent)).toMatchObject({ recording_status: "available", recording_storage_path: `${ws}/${row.id}.mp3`, recording_duration_seconds: 36 });

    items = (await timeline("editor")).filter((a) => a.call_id === row.id);
    expect(items[0].call).toMatchObject({ disposition: "connected", notes: "CALLTEST notes", recording_available: true });
    expect(items[0].meta).toMatchObject({ recording_available: true, disposition: "connected" });

    const asEditor = await handle(new Request(`${APP_URL}/api/voice/recordings/${row.id}`, { headers: { authorization: `Bearer ${people.editor.token}` } }));
    expect(asEditor.status).toBe(200);
    const { url } = (await asEditor.json()) as { url: string };
    const audio = await fetch(url);
    expect(audio.ok).toBe(true);
    expect(Buffer.from(await audio.arrayBuffer()).equals(MP3)).toBe(true);
    const asViewer = await handle(new Request(`${APP_URL}/api/voice/recordings/${row.id}`, { headers: { authorization: `Bearer ${people.viewer.token}` } }));
    expect(asViewer.status).toBe(403); // default recordingAccess = owner and editors
  });

  it("refuses a viewer's browser and leaves no trace", async () => {
    const parent = randomSid("CA");
    const xml = await (await post("/api/voice/outbound", { CallSid: parent, From: clientOf(people.viewer.id), contactId: created.contact })).text();
    expect(xml).not.toContain("<Dial");
    expect(await callBySid(parent)).toBeNull();
  });

  it("issues browser tokens to editors only", async () => {
    const token = (t: string) => handle(new Request(`${APP_URL}/api/voice/token`, { method: "POST", headers: { authorization: `Bearer ${t}` } }));
    expect((await token(people.editor.token)).status).toBe(200);
    expect((await token(people.viewer.token)).status).toBe(403);
  });

  it("an incoming call from the lead that nobody answers becomes a voicemail on their timeline", async () => {
    const parent = randomSid("CA");
    const xml = await (await post("/api/voice/incoming", { CallSid: parent, From: leadE164, To: TWILIO.TWILIO_CALLER_ID, Direction: "inbound" })).text();
    const row = await callBySid(parent);
    created.calls.push(row.id);
    expect(row).toMatchObject({ direction: "inbound", contact_id: created.contact, from_number: leadE164 });
    expect(xml).toContain(`<Parameter name="callId" value="${row.id}"/>`);
    expect(xml).toContain(`<Identity>crm_${people.editor.id.replace(/-/g, "")}</Identity>`);

    const vm = await (await post("/api/voice/dial-complete", { CallSid: parent, DialCallStatus: "no-answer" })).text();
    expect(vm).toContain("<Record");
    const rec = randomSid("RE");
    created.recordings.push(rec);
    await post("/api/voice/recording-status", { CallSid: parent, RecordingSid: rec, RecordingStatus: "completed", RecordingDuration: "9", RecordingSource: "RecordVerb" });
    expect(await callBySid(parent)).toMatchObject({ status: "no-answer", is_voicemail: true, recording_status: "completed" });
    const item = (await timeline("editor")).find((a) => a.call_id === row.id);
    expect(item).toMatchObject({ event: "voicemail", subject: "Voicemail" });
    expect(item.call).toMatchObject({ direction: "inbound", is_voicemail: true });
  });
});
