import AccessToken from "twilio/lib/jwt/AccessToken.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Route } from "../router.js";
import { EDITORS, OWNER, requireAuth, type Role } from "../auth.js";
import { appUrl, features, getEnv } from "../env.js";
import { forbidden, json, notConfigured, notFound, str, xml } from "../http.js";
import { enqueueJob } from "../jobs.js";
import { adminClient } from "../supabase.js";
import {
  callSettings,
  identityForUser,
  isUuid,
  MAX_CALLS_PER_DAY,
  MAX_CALLS_PER_HOUR,
  missingTwilioEnv,
  RECORDING_URL_TTL_SECONDS,
  RECORDINGS_BUCKET,
  TOKEN_TTL_SECONDS,
  twilioConfig,
  userIdFromClientAddress,
  voiceUrls,
} from "./config.js";
import { applyLegEvent, applyRecordingEvent, eventTime, normalizeStatus, numberOrNull, type CallPatch, type CallRow, type CallStatus } from "./call-state.js";
import { dialableNumber, toE164 } from "./phone.js";
import { readTwilioWebhook } from "./signature.js";
import { findCallBySid, findCallForLeg, inboundClients, insertCallOnce, loadWorkspace, matchCaller, membershipOf, updateCall } from "./store.js";
import { announceTwiml, emptyTwiml, hangupTwiml, incomingTwiml, MESSAGES, outboundTwiml, sayAndHangup, voicemailTwiml } from "./twiml.js";

// Calling (Twilio). Browser routes need a signed-in owner/editor; Twilio's
// webhooks are verified by signature first (signature.ts). See
// docs/ARCHITECTURE.md §7: calls only go to numbers saved on CRM records, and
// recordings are only reachable through short-lived signed links.

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const RECORDING_SID = /^RE[0-9a-f]{32}$/i;
const twiml = (body: string) => xml(body);

// ---------------------------------------------------------------------------
// Browser: access token for the Twilio Voice SDK
// ---------------------------------------------------------------------------
async function issueToken(req: Request): Promise<Response> {
  const auth = await requireAuth(req, { roles: EDITORS });
  const cfg = twilioConfig();
  if (!cfg) throw notConfigured("Calling");
  const { data: pref, error } = await adminClient()
    .from("user_preferences")
    .select("calls_receive_inbound")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) throw error;
  const incoming = pref ? pref.calls_receive_inbound !== false : true;
  const identity = identityForUser(auth.userId);
  const token = new AccessToken(cfg.accountSid, cfg.apiKeySid, cfg.apiKeySecret, { identity, ttl: TOKEN_TTL_SECONDS });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: cfg.twimlAppSid, incomingAllow: incoming }));
  return json({
    token: token.toJwt(),
    identity,
    incoming,
    ttl: TOKEN_TTL_SECONDS,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
  });
}

/** Owner's Team page: what is set up (names of missing variables only, never values). */
async function setupStatus(req: Request): Promise<Response> {
  await requireAuth(req, { roles: OWNER });
  const urls = voiceUrls();
  return json({
    configured: features.calling(),
    missing: missingTwilioEnv(),
    callerId: getEnv("TWILIO_CALLER_ID") || null,
    appUrl: appUrl(),
    webhooks: { twimlAppVoiceUrl: urls.outbound, twimlAppStatusCallback: urls.status, phoneNumberVoiceUrl: urls.incoming },
  });
}

// ---------------------------------------------------------------------------
// Outgoing calls: the TwiML App's Voice URL. The browser only says which CRM
// record it wants to call; the number always comes from that record.
// ---------------------------------------------------------------------------
interface Target {
  contactId: string | null;
  /** The company whose number is called (or the contact's company). */
  companyId: string | null;
  taskId: string | null;
  dealId: string | null;
  toNumber: string;
}

async function resolveTarget(db: SupabaseClient, workspaceId: string, p: Record<string, string>, country: ReturnType<typeof callSettings>["defaultCountry"], allowed: ReturnType<typeof callSettings>["allowedCallCountries"] = []): Promise<Target | { error: string }> {
  const contactParam = str(p.contactId, 64).trim();
  const companyParam = str(p.companyId, 64).trim();
  const taskParam = str(p.taskId, 64).trim();
  const dealParam = str(p.dealId, 64).trim();
  for (const v of [contactParam, companyParam, taskParam, dealParam]) if (v && !isUuid(v)) return { error: MESSAGES.unknownRecord };

  type TaskRow = { id: string; deal_id: string | null; contact_id: string | null };
  type DealRow = { id: string; contact_id: string | null };
  let task: TaskRow | null = null;
  if (taskParam) {
    const { data, error } = await db.from("tasks").select("id, deal_id, contact_id").eq("id", taskParam).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return { error: MESSAGES.unknownRecord };
    task = data as TaskRow;
  }
  let deal: DealRow | null = null;
  const dealId = task?.deal_id || dealParam || null;
  if (dealId) {
    const { data, error } = await db.from("deals").select("id, contact_id").eq("id", dealId).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return { error: MESSAGES.unknownRecord };
    deal = data as DealRow;
  }

  const contactId = contactParam || task?.contact_id || deal?.contact_id || null;
  const numbers: string[] = [];
  let resolvedContact: string | null = null;
  let resolvedCompany: string | null;
  if (contactId) {
    const { data: c, error } = await db.from("contacts").select("id, phone, company_id").eq("id", contactId).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw error;
    if (!c) return { error: MESSAGES.unknownRecord };
    resolvedContact = c.id as string;
    resolvedCompany = (c.company_id as string | null) ?? null;
    if (c.phone) numbers.push(c.phone as string);
    if (c.company_id) {
      const { data: co, error: coErr } = await db.from("companies").select("phone").eq("id", c.company_id).eq("workspace_id", workspaceId).maybeSingle();
      if (coErr) throw coErr;
      if (co?.phone) numbers.push(co.phone as string);
    }
  } else if (companyParam) {
    const { data: co, error } = await db.from("companies").select("id, phone").eq("id", companyParam).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw error;
    if (!co) return { error: MESSAGES.unknownRecord };
    resolvedCompany = co.id as string;
    if (co.phone) numbers.push(co.phone as string);
  } else {
    return { error: MESSAGES.unknownRecord };
  }

  // The browser may say which of the record's numbers to use, never a new one.
  const wanted = p.number ? toE164(p.number, country) : null;
  if (p.number && (!wanted || !numbers.some((n) => toE164(n, country) === wanted))) return { error: MESSAGES.numberNotOnRecord };
  const candidates = wanted ? [wanted] : numbers;
  let lastReason: string = MESSAGES.noNumber;
  for (const n of candidates) {
    const d = dialableNumber(n, country, allowed);
    if (d.ok) {
      if (d.e164 === toE164(getEnv("TWILIO_CALLER_ID"))) return { error: MESSAGES.ownNumber };
      return { contactId: resolvedContact, companyId: resolvedCompany, taskId: task?.id ?? null, dealId: deal?.id ?? null, toNumber: d.e164 };
    }
    lastReason = d.reason;
  }
  return { error: candidates.length ? "Sorry, this call can't be placed. " + lastReason : MESSAGES.noNumber };
}

// How many calls this person placed recently; over the limit, no more calls.
async function overCallLimit(db: SupabaseClient, userId: string): Promise<string | null> {
  const count = async (sinceMs: number) => {
    const { count: n, error } = await db
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("direction", "outbound")
      .gte("started_at", new Date(Date.now() - sinceMs).toISOString());
    if (error) throw error;
    return n || 0;
  };
  if ((await count(3_600_000)) >= MAX_CALLS_PER_HOUR) return "Sorry, you have reached the limit of calls per hour. Please try again later.";
  if ((await count(86_400_000)) >= MAX_CALLS_PER_DAY) return "Sorry, you have reached the limit of calls per day. Please try again tomorrow.";
  return null;
}

async function outbound(req: Request): Promise<Response> {
  const p = await readTwilioWebhook(req);
  try {
    const cfg = twilioConfig();
    if (!cfg) return twiml(sayAndHangup(MESSAGES.notConfigured));
    const sid = str(p.CallSid, 64);
    if (!CALL_SID.test(sid)) return twiml(sayAndHangup(MESSAGES.error));
    const db = adminClient();

    // A retried webhook: answer exactly as the first time.
    const existing = await findCallBySid(db, sid);
    if (existing) {
      if (existing.direction !== "outbound" || !existing.to_number) return twiml(hangupTwiml());
      return twiml(outboundTwiml({ callerId: cfg.callerId, number: existing.to_number as string, recording: existing.recording_enabled, urls: voiceUrls() }));
    }

    const userId = userIdFromClientAddress(p.From || p.Caller);
    if (!userId) return twiml(sayAndHangup(MESSAGES.notAllowed));
    const member = await membershipOf(db, userId);
    if (!member || !EDITORS.includes(member.role as Role)) return twiml(sayAndHangup(MESSAGES.notAllowed));

    const ws = await loadWorkspace(db, member.workspaceId);
    const settings = callSettings(ws.settings);
    const limited = await overCallLimit(db, userId);
    if (limited) return twiml(sayAndHangup(limited));
    const target = await resolveTarget(db, ws.id, p, settings.defaultCountry, settings.allowedCallCountries);
    if ("error" in target) return twiml(sayAndHangup(target.error));

    const row = await insertCallOnce(db, {
      workspace_id: ws.id,
      provider: "twilio",
      provider_call_sid: sid,
      direction: "outbound",
      status: "initiated",
      from_number: cfg.callerId,
      to_number: target.toNumber,
      user_id: userId,
      contact_id: target.contactId,
      company_id: target.companyId,
      task_id: target.taskId,
      deal_id: target.dealId,
      recording_enabled: settings.recording,
    });
    return twiml(outboundTwiml({ callerId: cfg.callerId, number: row.to_number as string, recording: row.recording_enabled, urls: voiceUrls() }));
  } catch (err) {
    console.error("voice/outbound failed:", err);
    return twiml(sayAndHangup(MESSAGES.error));
  }
}

// ---------------------------------------------------------------------------
// Incoming calls: the phone number's Voice URL.
// ---------------------------------------------------------------------------
async function incoming(req: Request): Promise<Response> {
  const p = await readTwilioWebhook(req);
  try {
    const sid = str(p.CallSid, 64);
    if (!CALL_SID.test(sid)) return twiml(sayAndHangup(MESSAGES.inboundError));
    const db = adminClient();
    const ws = await loadWorkspace(db);
    const settings = callSettings(ws.settings);
    const urls = voiceUrls();

    let row = await findCallBySid(db, sid);
    if (!row) {
      const from = toE164(p.From, settings.defaultCountry);
      const match = await matchCaller(db, ws.id, from, settings.defaultCountry);
      row = await insertCallOnce(db, {
        workspace_id: ws.id,
        provider: "twilio",
        provider_call_sid: sid,
        direction: "inbound",
        status: "ringing",
        from_number: from || str(p.From, 50) || null,
        to_number: toE164(p.To) || str(p.To, 50) || null,
        contact_id: match.contactId,
        recording_enabled: settings.recording,
      });
    }
    if (row.direction !== "inbound") return twiml(hangupTwiml());

    // Nobody can take calls in the browser (or calling isn't fully set up): straight to voicemail.
    const clients = features.calling() ? await inboundClients(db, ws.id) : [];
    if (!clients.length) {
      await updateCall(db, row, (r) => (r.is_voicemail || r.answered_at ? null : { is_voicemail: true }));
      return twiml(voicemailTwiml({ urls }));
    }
    return twiml(
      incomingTwiml({
        announcement: row.recording_enabled ? settings.announcement : null,
        recording: row.recording_enabled,
        clients: clients.map((c) => ({
          identity: c.identity,
          // What the browser needs to show the caller and log the outcome (ids only, no personal data).
          params: { callId: row!.id, ...(row!.contact_id ? { contactId: row!.contact_id } : {}), recording: row!.recording_enabled ? "on" : "off" },
        })),
        urls,
      }),
    );
  } catch (err) {
    console.error("voice/incoming failed:", err);
    return twiml(sayAndHangup(MESSAGES.inboundError));
  }
}

// ---------------------------------------------------------------------------
// Call progress
// ---------------------------------------------------------------------------

/** Status callbacks of the dialled legs (and, if configured, of the call itself). */
async function status(req: Request): Promise<Response> {
  const p = await readTwilioWebhook(req);
  const st = normalizeStatus(p.CallStatus);
  if (!st) return twiml(emptyTwiml());
  const db = adminClient();
  const isChild = !!p.ParentCallSid;
  const row = await findCallBySid(db, isChild ? p.ParentCallSid : p.CallSid);
  if (!row) return twiml(emptyTwiml()); // not a CRM call (e.g. refused before it started)

  let answeredBy: string | null = null;
  if (isChild && row.direction === "inbound" && st === "in-progress") {
    const uid = userIdFromClientAddress(p.To || p.Called);
    const member = uid ? await membershipOf(db, uid) : null;
    if (uid && member && member.workspaceId === row.workspace_id && EDITORS.includes(member.role as Role)) answeredBy = uid;
  }
  await updateCall(db, row, (r) =>
    applyLegEvent(r, {
      source: isChild ? "child" : "parent",
      callSid: str(p.CallSid, 64) || null,
      status: st,
      at: eventTime(p.Timestamp),
      duration: numberOrNull(p.CallDuration),
      answeredBy,
    }),
  );
  return twiml(emptyTwiml());
}

/** The Dial verb's action: the dialled leg ended. Incoming calls nobody answered go to voicemail. */
async function dialComplete(req: Request): Promise<Response> {
  const p = await readTwilioWebhook(req);
  try {
    const db = adminClient();
    const row = await findCallBySid(db, p.CallSid);
    if (!row) return twiml(hangupTwiml());
    const st: CallStatus = normalizeStatus(p.DialCallStatus) || "failed";
    const toVoicemail = row.direction === "inbound" && (st === "no-answer" || st === "busy" || st === "failed");
    await updateCall(db, row, (r) => {
      const patch: CallPatch = applyLegEvent(r, {
        source: "dial",
        callSid: str(p.DialCallSid, 64) || null,
        status: st,
        at: new Date(),
        duration: numberOrNull(p.DialCallDuration),
      }) || {};
      if (toVoicemail && !r.is_voicemail && !r.answered_at) patch.is_voicemail = true;
      return Object.keys(patch).length ? patch : null;
    });
    return twiml(toVoicemail ? voicemailTwiml({ urls: voiceUrls() }) : hangupTwiml());
  } catch (err) {
    console.error("voice/dial-complete failed:", err);
    return twiml(hangupTwiml());
  }
}

/** After a voicemail: thank the caller. */
async function voicemailDone(req: Request): Promise<Response> {
  await readTwilioWebhook(req);
  return twiml(sayAndHangup(MESSAGES.voicemailThanks));
}

/** <Number url>: what the lead hears before an outgoing recorded call connects. */
async function announce(req: Request): Promise<Response> {
  await readTwilioWebhook(req);
  try {
    const ws = await loadWorkspace(adminClient());
    return twiml(announceTwiml(callSettings(ws.settings).announcement));
  } catch (err) {
    console.error("voice/announce failed:", err);
    return twiml(announceTwiml(callSettings({}).announcement));
  }
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
async function recordingStatus(req: Request): Promise<Response> {
  const p = await readTwilioWebhook(req);
  const sid = str(p.RecordingSid, 64);
  const st = str(p.RecordingStatus, 20);
  if (!RECORDING_SID.test(sid) || !st) return twiml(emptyTwiml());
  const db = adminClient();
  const row = await findCallForLeg(db, [p.CallSid, p.ParentCallSid]);
  if (!row) return twiml(emptyTwiml());
  const voicemail = p.RecordingSource === "RecordVerb";
  const updated = await updateCall(db, row, (r) => {
    const patch: CallPatch = applyRecordingEvent(r, { sid, status: st, duration: numberOrNull(p.RecordingDuration) }) || {};
    if (r.recording_sid && r.recording_sid !== sid) return null;
    if (voicemail && st === "completed" && !r.is_voicemail) patch.is_voicemail = true;
    if (r.is_voicemail && st === "absent") patch.is_voicemail = false; // the caller hung up without leaving a message
    return Object.keys(patch).length ? patch : null;
  });
  if (st === "completed" && updated.recording_sid === sid && updated.recording_status !== "available") {
    await enqueueJob(
      "voice.copy_recording",
      { call_id: updated.id, recording_sid: sid },
      { dedupeKey: `voice_recording:${sid}`, workspaceId: updated.workspace_id },
    );
  }
  return twiml(emptyTwiml());
}

/** A short-lived link to a recording, for people allowed to listen (can_play_recording). */
async function recordingUrl(req: Request, ctx: { params: Record<string, string> }): Promise<Response> {
  const auth = await requireAuth(req);
  const callId = ctx.params.callId;
  if (!isUuid(callId)) throw notFound("This recording isn't available.");
  const { data: allowed, error } = await auth.db.rpc("can_play_recording", { p_call: callId });
  if (error) throw error;
  if (allowed !== true) throw forbidden("You aren't allowed to play call recordings. The CRM owner decides who can (Team page).");
  const { data: call, error: cErr } = await auth.db
    .from("calls")
    .select("id, workspace_id, recording_status, recording_storage_path")
    .eq("id", callId)
    .maybeSingle();
  if (cErr) throw cErr;
  const path = call?.recording_storage_path as string | undefined;
  if (!call || call.recording_status !== "available" || !path || !path.startsWith(`${call.workspace_id}/`)) {
    throw notFound("This recording isn't available yet.");
  }
  const { data, error: sErr } = await adminClient().storage.from(RECORDINGS_BUCKET).createSignedUrl(path, RECORDING_URL_TTL_SECONDS);
  if (sErr || !data?.signedUrl) {
    console.error("Signing a recording link failed:", sErr?.message);
    throw notFound("This recording isn't available yet.");
  }
  return json({ url: data.signedUrl, expiresIn: RECORDING_URL_TTL_SECONDS });
}

export const voiceRoutes: Route[] = [
  { method: "POST", path: "/api/voice/token", handler: issueToken },
  { method: "GET", path: "/api/voice/setup", handler: setupStatus },
  { method: "POST", path: "/api/voice/outbound", handler: outbound },
  { method: "POST", path: "/api/voice/incoming", handler: incoming },
  { method: "POST", path: "/api/voice/status", handler: status },
  { method: "POST", path: "/api/voice/dial-complete", handler: dialComplete },
  { method: "POST", path: "/api/voice/voicemail-done", handler: voicemailDone },
  { method: "POST", path: "/api/voice/announce", handler: announce },
  { method: "POST", path: "/api/voice/recording-status", handler: recordingStatus },
  { method: "GET", path: "/api/voice/recordings/:callId", handler: recordingUrl },
];

export type { CallRow };
