import { describe, expect, it } from "vitest";
import { applyLegEvent, applyRecordingEvent, eventTime, normalizeStatus, type CallRow, type LegEvent } from "../../../lib/server/voice/call-state.js";

const T0 = Date.parse("2026-10-17T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

function row(over: Partial<CallRow> = {}): CallRow {
  return {
    id: "c1", workspace_id: "ws", direction: "outbound", status: "initiated", provider_call_sid: "CAparent", provider_child_call_sid: null,
    user_id: "u1", contact_id: "lead", started_at: at(0).toISOString(), answered_at: null, ended_at: null, duration_seconds: null,
    is_voicemail: false, recording_enabled: false, recording_sid: null, recording_status: null, recording_duration_seconds: null,
    recording_storage_path: null, updated_at: "x", ...over,
  };
}

/** Applies callbacks in order, like the webhook would. */
function play(start: CallRow, events: LegEvent[]): CallRow {
  return events.reduce((r, ev) => ({ ...r, ...(applyLegEvent(r, ev) || {}) }), start);
}

const child = (status: LegEvent["status"], s: number, extra: Partial<LegEvent> = {}): LegEvent => ({ source: "child", callSid: "CAchild", status, at: at(s), ...extra });

describe("outgoing call status", () => {
  it("moves forward through a normal call", () => {
    const r = play(row(), [child("initiated", 0), child("ringing", 2), child("in-progress", 8), child("completed", 70, { duration: 62 })]);
    expect(r).toMatchObject({ status: "completed", provider_child_call_sid: "CAchild", answered_at: at(8).toISOString(), ended_at: at(70).toISOString(), duration_seconds: 62 });
  });

  it("out-of-order callbacks never move a call backwards", () => {
    const r = play(row(), [child("completed", 70, { duration: 62 }), child("ringing", 2), child("in-progress", 8), child("initiated", 0)]);
    expect(r.status).toBe("completed");
    expect(r.duration_seconds).toBe(62);
    expect(r.answered_at).toBe(at(8).toISOString()); // derived from the end time and the duration
  });

  it("duplicate callbacks change nothing", () => {
    const done = play(row(), [child("ringing", 2), child("in-progress", 8), child("completed", 70, { duration: 62 })]);
    expect(applyLegEvent(done, child("completed", 75, { duration: 99 }))).toBeNull();
    expect(applyLegEvent(done, child("in-progress", 9))).toBeNull();
    const ringing = play(row(), [child("ringing", 2)]);
    expect(applyLegEvent(ringing, child("ringing", 3))).toBeNull();
  });

  it("a finished call keeps its outcome; later callbacks only fill gaps", () => {
    const noAnswer = play(row(), [child("ringing", 2), { source: "dial", callSid: null, status: "no-answer", at: at(30), duration: null }]);
    expect(noAnswer).toMatchObject({ status: "no-answer", duration_seconds: 0, ended_at: at(30).toISOString() });
    expect(applyLegEvent(noAnswer, child("completed", 31, { duration: 0 }))).toBeNull();
    expect(applyLegEvent(noAnswer, { source: "parent", callSid: "CAparent", status: "completed", at: at(32) })).toBeNull();
  });

  it("the Dial action settles the call even if the leg's callbacks were lost", () => {
    const r = play(row(), [{ source: "dial", callSid: "CAchild", status: normalizeStatus("answered")!, at: at(70), duration: 60 }]);
    expect(r).toMatchObject({ status: "completed", provider_child_call_sid: "CAchild", duration_seconds: 60, answered_at: at(10).toISOString() });
  });

  it("ignores a callback from a leg that isn't this call's", () => {
    const r = play(row(), [child("in-progress", 8)]);
    expect(applyLegEvent(r, { ...child("completed", 20), callSid: "CAother" })).toBeNull();
  });

  it("the browser hanging up while the phone rings cancels the call", () => {
    const r = play(row(), [child("ringing", 2), { source: "parent", callSid: "CAparent", status: "completed", at: at(9) }]);
    expect(r).toMatchObject({ status: "canceled", duration_seconds: 0 });
  });

  it("the call ending ends a conversation that was in progress", () => {
    const r = play(row(), [child("in-progress", 8), { source: "parent", callSid: "CAparent", status: "completed", at: at(40), duration: 999 }]);
    expect(r).toMatchObject({ status: "completed", duration_seconds: 32 }); // the parent's own duration includes ringing
  });

  it("the parent being answered says nothing about the lead", () => {
    expect(applyLegEvent(row({ status: "ringing" }), { source: "parent", callSid: "CAparent", status: "in-progress", at: at(1) })).toBeNull();
  });
});

describe("incoming call status (several browsers ring)", () => {
  const inbound = () => row({ direction: "inbound", status: "ringing", user_id: null });
  const leg = (callSid: string, status: LegEvent["status"], s: number, extra: Partial<LegEvent> = {}): LegEvent => ({ source: "child", callSid, status, at: at(s), ...extra });

  it("the browser that answers owns the call; the others stopping doesn't end it", () => {
    const r = play(inbound(), [
      leg("CAa", "ringing", 1), leg("CAb", "ringing", 1),
      leg("CAb", "in-progress", 5, { answeredBy: "editor-b" }),
      leg("CAa", "canceled", 5),
      leg("CAb", "completed", 65, { duration: 60 }),
    ]);
    expect(r).toMatchObject({ status: "completed", user_id: "editor-b", provider_child_call_sid: "CAb", duration_seconds: 60 });
  });

  it("a browser that never answered can't cancel the call", () => {
    const r = play(inbound(), [leg("CAa", "ringing", 1), leg("CAa", "no-answer", 25), leg("CAb", "canceled", 25)]);
    expect(r.status).toBe("ringing");
    expect(r.user_id).toBeNull();
  });

  it("a second 'answered' can't take the call over", () => {
    const r = play(inbound(), [leg("CAb", "in-progress", 5, { answeredBy: "editor-b" }), leg("CAa", "in-progress", 6, { answeredBy: "editor-a" })]);
    expect(r).toMatchObject({ user_id: "editor-b", provider_child_call_sid: "CAb" });
  });

  it("an 'answered' arriving after the call went to voicemail is ignored", () => {
    const r = play(inbound(), [{ source: "dial", callSid: null, status: "no-answer", at: at(25) }]);
    expect(applyLegEvent(r, leg("CAa", "in-progress", 24, { answeredBy: "editor-a" }))).toBeNull();
  });
});

describe("recording status", () => {
  it("moves forward and never undoes a copied recording", () => {
    let r = row({ recording_enabled: true });
    r = { ...r, ...applyRecordingEvent(r, { sid: "RE1", status: "in-progress" }) };
    r = { ...r, ...applyRecordingEvent(r, { sid: "RE1", status: "completed", duration: 61 }) };
    expect(r).toMatchObject({ recording_sid: "RE1", recording_status: "completed", recording_duration_seconds: 61 });
    r = { ...r, recording_status: "available", recording_storage_path: "ws/c1.mp3" };
    expect(applyRecordingEvent(r, { sid: "RE1", status: "completed", duration: 61 })).toBeNull();
    expect(applyRecordingEvent(r, { sid: "RE1", status: "in-progress" })).toBeNull();
  });
  it("one recording per call", () => {
    expect(applyRecordingEvent(row({ recording_sid: "RE1", recording_status: "completed" }), { sid: "RE2", status: "completed" })).toBeNull();
  });
  it("ignores statuses it doesn't know", () => {
    expect(applyRecordingEvent(row(), { sid: "RE1", status: "available" })).toBeNull();
    expect(applyRecordingEvent(row(), { sid: "RE1", status: "weird" })).toBeNull();
  });
});

describe("callback values", () => {
  it("maps Twilio statuses", () => {
    expect(normalizeStatus("queued")).toBe("initiated");
    expect(normalizeStatus("in-progress")).toBe("in-progress");
    expect(normalizeStatus("answered")).toBe("completed");
    expect(normalizeStatus("nonsense")).toBeNull();
  });
  it("uses Twilio's timestamp unless it is far from our clock", () => {
    const now = new Date(T0);
    expect(eventTime("Sat, 17 Oct 2026 09:59:30 +0000", now).toISOString()).toBe("2026-10-17T09:59:30.000Z");
    expect(eventTime("Sat, 17 Oct 2020 09:59:30 +0000", now)).toBe(now);
    expect(eventTime(undefined, now)).toBe(now);
  });
});
