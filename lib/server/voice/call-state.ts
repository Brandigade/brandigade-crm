// How Twilio's callbacks change a calls row. Pure functions, so every
// ordering of callbacks can be tested.
//
// Twilio sends several callbacks per call and retries them, in no guaranteed
// order: the dialled leg's status callbacks, the Dial action when the leg
// ends, and (if configured) the parent leg's own status callback. A call's
// status therefore only ever moves forward:
//
//   initiated -> ringing -> in-progress -> completed | busy | no-answer | failed | canceled
//
// Once a call has ended, later callbacks may only fill in what is still
// missing (end time, duration); they never change the outcome.

export type CallStatus = "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "failed" | "canceled";

const RANK: Record<CallStatus, number> = {
  initiated: 0,
  ringing: 1,
  "in-progress": 2,
  completed: 3,
  busy: 3,
  "no-answer": 3,
  failed: 3,
  canceled: 3,
};

export const isTerminal = (s: string | null | undefined): boolean => !!s && RANK[s as CallStatus] === 3;

/** Twilio CallStatus / DialCallStatus -> our status. */
export function normalizeStatus(value: unknown): CallStatus | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "queued") return "initiated";
  if (v === "answered") return "completed"; // DialCallStatus: the dialled party answered and the Dial has ended
  return v in RANK ? (v as CallStatus) : null;
}

export interface CallRow {
  id: string;
  workspace_id: string;
  direction: "outbound" | "inbound";
  status: CallStatus;
  provider_call_sid: string | null;
  provider_child_call_sid: string | null;
  user_id: string | null;
  contact_id: string | null;
  task_id?: string | null;
  deal_id?: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  is_voicemail: boolean;
  recording_enabled: boolean;
  recording_sid: string | null;
  recording_status: string | null;
  recording_duration_seconds: number | null;
  recording_storage_path: string | null;
  from_number?: string | null;
  to_number?: string | null;
  updated_at: string;
}

export type CallPatch = Partial<Omit<CallRow, "id" | "workspace_id" | "updated_at">>;

export interface LegEvent {
  /**
   * child  - status callback of a dialled leg (the lead's phone, or one teammate's browser)
   * parent - status callback of the call itself (the browser leg of an outgoing call, the caller of an incoming one)
   * dial   - the Dial action: the dialled leg has ended
   */
  source: "child" | "parent" | "dial";
  /** CallSid of the leg the event is about (the child's sid, or DialCallSid). */
  callSid: string | null;
  status: CallStatus;
  at: Date;
  /** CallDuration / DialCallDuration in seconds, when Twilio sends it. */
  duration?: number | null;
  /** For an incoming call answered in a browser: who answered. */
  answeredBy?: string | null;
}

const iso = (d: Date) => d.toISOString();
const secondsBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

/** Fills end time / duration on a call that has ended (never changes what is already there). */
function fillEnded(row: CallRow, ev: LegEvent, patch: CallPatch) {
  const endedAt = row.ended_at ?? patch.ended_at ?? iso(ev.at);
  if (!row.ended_at && !patch.ended_at) patch.ended_at = endedAt;
  const answeredAt = row.answered_at ?? patch.answered_at ?? null;
  const status = patch.status ?? row.status;
  if (row.duration_seconds == null && patch.duration_seconds == null) {
    if (ev.duration != null && Number.isFinite(ev.duration) && ev.source !== "parent") patch.duration_seconds = Math.max(0, Math.round(ev.duration));
    else if (answeredAt) patch.duration_seconds = secondsBetween(answeredAt, endedAt);
    else if (status !== "completed") patch.duration_seconds = 0;
  }
  if (status === "completed" && !answeredAt && patch.duration_seconds != null) {
    patch.answered_at = iso(new Date(Date.parse(endedAt) - patch.duration_seconds * 1000));
  }
}

/** The change one callback makes to a call, or null when it changes nothing. */
export function applyLegEvent(row: CallRow, ev: LegEvent): CallPatch | null {
  const patch: CallPatch = {};
  const inbound = row.direction === "inbound";
  const child = row.provider_child_call_sid;

  if (ev.source === "child") {
    if (child && ev.callSid && child !== ev.callSid) return null; // another leg (e.g. a teammate's browser that didn't answer)
    if (inbound) {
      // Several browsers ring at once; only the one that answers is "the" leg.
      if (ev.status === "in-progress") {
        if (isTerminal(row.status) && row.status !== "completed") return null; // nobody answered after all
        if (!child && ev.callSid) patch.provider_child_call_sid = ev.callSid;
        if (!row.user_id && ev.answeredBy) patch.user_id = ev.answeredBy;
      } else if (isTerminal(ev.status) && !child) {
        return null; // a browser that never answered stopped ringing
      }
    } else if (!child && ev.callSid) {
      patch.provider_child_call_sid = ev.callSid;
    }
  }

  if (ev.source === "dial" && !child && ev.callSid && ev.status === "completed") {
    patch.provider_child_call_sid = ev.callSid;
  }

  let target: CallStatus = ev.status;
  if (ev.source === "parent") {
    // The call itself ending says nothing about the lead's leg unless the call is still open.
    if (!isTerminal(ev.status)) target = row.status;
    else if (ev.status === "completed") target = row.status === "in-progress" ? "completed" : "canceled";
  }

  if (isTerminal(row.status)) {
    if (isTerminal(target) && (ev.source !== "child" || !child || child === ev.callSid)) fillEnded(row, ev, patch);
  } else if (RANK[target] > RANK[row.status]) {
    patch.status = target;
    if (target === "in-progress" && !row.answered_at) patch.answered_at = iso(ev.at);
    if (isTerminal(target)) fillEnded(row, ev, patch);
  }

  return Object.keys(patch).length ? patch : null;
}

// ---------------------------------------------------------------------------
// Recordings: in-progress -> completed -> available (copied to our storage);
// absent / failed when Twilio has nothing. A retried "completed" callback must
// never undo "available".
// ---------------------------------------------------------------------------
const REC_RANK: Record<string, number> = { "in-progress": 0, completed: 1, available: 2, absent: 2, failed: 2, deleted: 3 };

export interface RecordingEvent {
  sid: string;
  status: string;
  duration?: number | null;
}

export function applyRecordingEvent(row: CallRow, ev: RecordingEvent): CallPatch | null {
  if (!(ev.status in REC_RANK) || ev.status === "available" || ev.status === "deleted") return null;
  if (row.recording_sid && row.recording_sid !== ev.sid) return null; // one recording per call
  const patch: CallPatch = {};
  if (!row.recording_sid) patch.recording_sid = ev.sid;
  const current = row.recording_status;
  if (!current || REC_RANK[ev.status] > (REC_RANK[current] ?? -1)) patch.recording_status = ev.status;
  if (ev.duration != null && Number.isFinite(ev.duration) && row.recording_duration_seconds == null && ev.status === "completed") {
    patch.recording_duration_seconds = Math.max(0, Math.round(ev.duration));
  }
  return Object.keys(patch).length ? patch : null;
}

/** Twilio's Timestamp parameter (RFC 2822), or now. */
export function eventTime(value: unknown, now = new Date()): Date {
  const t = Date.parse(String(value ?? ""));
  if (!Number.isFinite(t)) return now;
  // A clock far off ours (or a replayed callback) shouldn't move times around.
  return Math.abs(t - now.getTime()) > 6 * 3600_000 ? now : new Date(t);
}

export function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
