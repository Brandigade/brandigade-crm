import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAdminClientForTests } from "../../../lib/server/supabase.js";
import { PermanentJobError, RetryJobLater, runJobs, type Job } from "../../../lib/server/jobs.js";
import { copyRecording, voiceJobHandlers } from "../../../lib/server/voice/worker.js";
import { crmDb, ids, setEnv, sid, TWILIO } from "./helpers.js";
import type { MemoryDb } from "./memory-db.js";

const env = { ...process.env };
const CALL = "abababab-abab-4bab-8bab-abababababab";
const REC = sid("RE", 1);
let db: MemoryDb;

beforeEach(() => {
  setEnv({ TWILIO_API_BASE: "http://twilio.test" });
  db = crmDb();
  db.tables.calls.push({
    id: CALL, workspace_id: ids.ws, direction: "outbound", status: "completed", provider_call_sid: sid("CA", 1),
    recording_sid: REC, recording_status: "completed", recording_storage_path: null, updated_at: "x",
  });
  __setAdminClientForTests(db.client);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...env };
  __setAdminClientForTests(null);
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 1, kind: "voice.copy_recording", payload: { call_id: CALL, recording_sid: REC }, workspace_id: ids.ws,
  dedupe_key: `voice_recording:${REC}`, attempts: 1, max_attempts: 6, run_after: new Date().toISOString(), ...over,
});
const ctx = () => ({ deadline: Date.now() + 60_000 });
const MP3 = Buffer.from("ID3\x03\x00fake-mp3-bytes");

function twilioApi(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any = {}) => { seen.push({ url: String(url), init }); return handler(String(url), init); });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}
const ok = () => new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(MP3.length) } });

describe("voice.copy_recording", () => {
  it("downloads the MP3 from Twilio with the API key and stores it privately", async () => {
    const api = twilioApi(ok);
    const out = await copyRecording(job(), ctx(), { fetchImpl: api.fetchImpl });
    expect(api.seen[0].url).toBe(`http://twilio.test/2010-04-01/Accounts/${TWILIO.TWILIO_ACCOUNT_SID}/Recordings/${REC}.mp3`);
    const auth = (api.seen[0].init.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(`${TWILIO.TWILIO_API_KEY_SID}:${TWILIO.TWILIO_API_KEY_SECRET}`);
    const path = `${ids.ws}/${CALL}.mp3`;
    expect(db.storage.get(`call-recordings/${path}`)).toEqual({ bytes: MP3, contentType: "audio/mpeg" });
    expect(db.tables.calls[0]).toMatchObject({ recording_status: "available", recording_storage_path: path });
    expect(out).toEqual({ status: "done", result: { path, bytes: MP3.length } });
  });

  it("is idempotent: a second run (or a crashed run's retry) does nothing", async () => {
    const api = twilioApi(ok);
    await copyRecording(job(), ctx(), { fetchImpl: api.fetchImpl });
    const again = await copyRecording(job({ attempts: 2 }), ctx(), { fetchImpl: api.fetchImpl });
    expect(again).toMatchObject({ status: "skipped", result: { reason: "already copied" } });
    expect(api.seen).toHaveLength(1);
  });

  it("a crash between upload and update just uploads again (same path, overwritten)", async () => {
    db.storage.set(`call-recordings/${ids.ws}/${CALL}.mp3`, { bytes: Buffer.from("partial") });
    await copyRecording(job(), ctx(), { fetchImpl: twilioApi(ok).fetchImpl });
    expect(db.storage.get(`call-recordings/${ids.ws}/${CALL}.mp3`)!.bytes).toEqual(MP3);
  });

  it("skips calls that are gone or got another recording", async () => {
    const api = twilioApi(ok);
    expect(await copyRecording(job({ payload: { call_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", recording_sid: REC } }), ctx(), { fetchImpl: api.fetchImpl })).toMatchObject({ status: "skipped" });
    expect(await copyRecording(job({ payload: { call_id: CALL, recording_sid: sid("RE", 2) } }), ctx(), { fetchImpl: api.fetchImpl })).toMatchObject({ status: "skipped" });
    expect(api.seen).toHaveLength(0);
  });

  it("bad payloads and refused credentials are permanent; 5xx and early 404s are retried", async () => {
    await expect(copyRecording(job({ payload: { call_id: CALL, recording_sid: "../../etc" } }), ctx())).rejects.toBeInstanceOf(PermanentJobError);
    await expect(copyRecording(job(), ctx(), { fetchImpl: twilioApi(() => new Response("no", { status: 401 })).fetchImpl })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(copyRecording(job(), ctx(), { fetchImpl: twilioApi(() => new Response("{}", { status: 400 })).fetchImpl })).rejects.toBeInstanceOf(PermanentJobError);

    const notYet = copyRecording(job({ attempts: 1 }), ctx(), { fetchImpl: twilioApi(() => new Response("", { status: 404 })).fetchImpl });
    await expect(notYet).rejects.toThrow(/hasn't published/);
    await expect(notYet).rejects.not.toBeInstanceOf(PermanentJobError);
    await expect(copyRecording(job({ attempts: 4 }), ctx(), { fetchImpl: twilioApi(() => new Response("", { status: 404 })).fetchImpl })).rejects.toBeInstanceOf(PermanentJobError);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const flaky = copyRecording(job(), ctx(), { fetchImpl: twilioApi(() => new Response("oops", { status: 503 })).fetchImpl });
      const settled = flaky.catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentJobError);
    } finally {
      vi.useRealTimers();
    }
    expect(db.tables.calls[0].recording_status).toBe("completed");
  });

  it("a long Twilio rate limit reschedules the job", async () => {
    const limited = () => new Response("", { status: 429, headers: { "retry-after": "120" } });
    await expect(copyRecording(job(), ctx(), { fetchImpl: twilioApi(limited).fetchImpl })).rejects.toBeInstanceOf(RetryJobLater);
  });

  it("refuses recordings larger than the bucket allows", async () => {
    const huge = () => new Response("x", { status: 200, headers: { "content-length": String(60 * 1024 * 1024) } });
    await expect(copyRecording(job(), ctx(), { fetchImpl: twilioApi(huge).fetchImpl })).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("runs through the job queue under its kind", async () => {
    expect(Object.keys(voiceJobHandlers)).toEqual(["voice.copy_recording"]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = twilioApi(ok).fetchImpl;
    try {
      let served = false;
      db.client.rpc = async (name: string) => {
        if (name !== "claim_jobs") return { data: null, error: null };
        const out = served ? [] : [job()];
        served = true;
        return { data: out, error: null };
      };
      const summary = await runJobs(voiceJobHandlers, { deadline: Date.now() + 60_000 });
      expect(summary).toMatchObject({ claimed: 1, done: 1 });
      expect(db.tables.calls[0].recording_status).toBe("available");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
