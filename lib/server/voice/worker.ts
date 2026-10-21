import type { Job, JobContext, JobHandler, JobOutcome } from "../jobs.js";
import { PermanentJobError, RetryJobLater } from "../jobs.js";
import { fetchWithRetry, RateLimitError } from "../retry.js";
import { adminClient } from "../supabase.js";
import { getEnv } from "../env.js";
import { isUuid, RECORDINGS_BUCKET, twilioApiBase } from "./config.js";

// Background work for calling: copying finished recordings from Twilio into
// the private "call-recordings" bucket, where the CRM hands out short-lived
// signed links (never streamed through the server).

const RECORDING_SID = /^RE[0-9a-f]{32}$/i;
/** The bucket's own limit (migration 20261017100100_integrations.sql). */
export const MAX_RECORDING_BYTES = 52_428_800;
/** Twilio can take a moment to publish the media after the "completed" callback. */
const NOT_FOUND_RETRIES = 4;

export interface CopyRecordingDeps {
  fetchImpl?: typeof fetch;
}

export async function copyRecording(job: Job, ctx: JobContext, deps: CopyRecordingDeps = {}): Promise<JobOutcome> {
  const callId = String(job.payload?.call_id ?? "");
  const recordingSid = String(job.payload?.recording_sid ?? "");
  if (!isUuid(callId) || !RECORDING_SID.test(recordingSid)) throw new PermanentJobError("Bad voice.copy_recording payload");

  const db = adminClient();
  const { data: call, error } = await db
    .from("calls")
    .select("id, workspace_id, recording_sid, recording_status, recording_storage_path")
    .eq("id", callId)
    .maybeSingle();
  if (error) throw new Error(`Reading the call failed: ${error.message}`);
  if (!call) return { status: "skipped", result: { reason: "call deleted" } };
  if (call.recording_sid && call.recording_sid !== recordingSid) return { status: "skipped", result: { reason: "a different recording" } };
  if (call.recording_status === "available" && call.recording_storage_path) {
    return { status: "skipped", result: { reason: "already copied", path: call.recording_storage_path } };
  }
  if (call.recording_status === "deleted") return { status: "skipped", result: { reason: "recording deleted" } };

  const accountSid = getEnv("TWILIO_ACCOUNT_SID");
  const keySid = getEnv("TWILIO_API_KEY_SID");
  const keySecret = getEnv("TWILIO_API_KEY_SECRET");
  if (!accountSid || !keySid || !keySecret) throw new PermanentJobError("Twilio credentials are not set on the server");
  if (Date.now() > ctx.deadline - 15_000) throw new RetryJobLater(5_000, "Not enough time left in this run");

  // Built from our own settings, never from a URL in the callback.
  const url = `${twilioApiBase()}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Recordings/${recordingSid}.mp3`;
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      { headers: { Authorization: "Basic " + Buffer.from(`${keySid}:${keySecret}`).toString("base64"), Accept: "audio/mpeg" } },
      { retries: 2, timeoutMs: 90_000, fetchImpl: deps.fetchImpl },
    );
  } catch (err) {
    if (err instanceof RateLimitError) throw new RetryJobLater(err.retryAfterMs, "Twilio rate limit");
    throw new Error(`Downloading the recording failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    if (job.attempts < NOT_FOUND_RETRIES) throw new Error("Twilio hasn't published the recording yet (404)");
    throw new PermanentJobError("Twilio has no such recording (404)");
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new PermanentJobError(`Twilio refused the API key (${res.status})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500) throw new Error(`Twilio error ${res.status}`);
    throw new PermanentJobError(`Twilio refused the download (${res.status})`);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_RECORDING_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new PermanentJobError("The recording is larger than the storage limit");
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error("Twilio sent an empty recording");
  if (bytes.length > MAX_RECORDING_BYTES) throw new PermanentJobError("The recording is larger than the storage limit");

  const path = `${call.workspace_id}/${call.id}.mp3`;
  const { error: upErr } = await db.storage.from(RECORDINGS_BUCKET).upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
  if (upErr) throw new Error(`Saving the recording failed: ${upErr.message}`);

  const { error: updErr } = await db
    .from("calls")
    .update({ recording_status: "available", recording_storage_path: path, recording_sid: recordingSid })
    .eq("id", call.id);
  if (updErr) throw new Error(`Updating the call failed: ${updErr.message}`);
  return { status: "done", result: { path, bytes: bytes.length } };
}

export const voiceJobHandlers: Record<string, JobHandler> = {
  "voice.copy_recording": (job, ctx) => copyRecording(job, ctx),
};
