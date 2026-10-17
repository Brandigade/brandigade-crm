import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import { INBOUND_RING_SECONDS, MAX_CALL_SECONDS, VOICEMAIL_MAX_SECONDS, type VoiceUrls } from "./config.js";

// TwiML documents the voice webhooks answer with. Built with Twilio's own
// VoiceResponse, which escapes every attribute and text node, so names or an
// owner's announcement text can never inject markup.

export const MESSAGES = {
  notConfigured: "Calling isn't set up in the CRM yet. Goodbye.",
  notAllowed: "Sorry, your CRM account isn't allowed to place calls. Ask the CRM owner for editor access.",
  unknownRecord: "Sorry, this call can't be placed: that record isn't in the CRM.",
  noNumber: "Sorry, this call can't be placed: there is no valid phone number saved on that record.",
  numberNotOnRecord: "Sorry, the CRM only calls numbers that are saved on a contact or company.",
  ownNumber: "Sorry, the CRM can't call its own number.",
  error: "Sorry, something went wrong in the CRM and the call can't be placed. Please try again.",
  inboundError: "Sorry, we can't take your call right now. Please try again later.",
  voicemailGreeting: "Sorry, nobody can take your call right now. Please leave a message after the tone, and press the pound key when you're done.",
  voicemailThanks: "Thank you. Goodbye.",
} as const;

export function sayAndHangup(message: string): string {
  const r = new VoiceResponse();
  r.say(message);
  r.hangup();
  return r.toString();
}

export function hangupTwiml(): string {
  const r = new VoiceResponse();
  r.hangup();
  return r.toString();
}

/** For callbacks whose answer Twilio ignores (status, recording status). */
export function emptyTwiml(): string {
  return new VoiceResponse().toString();
}

export function announceTwiml(text: string): string {
  const r = new VoiceResponse();
  r.say(text);
  return r.toString();
}

/**
 * Browser -> phone. The browser leg keeps ringing until the lead answers
 * (answerOnBridge). With recording on, the lead hears the announcement
 * (<Number url>) before the conversation starts and both sides are recorded
 * on separate channels from the moment they answer.
 */
export function outboundTwiml(opts: { callerId: string; number: string; recording: boolean; urls: VoiceUrls }): string {
  const r = new VoiceResponse();
  const dial = r.dial({
    callerId: opts.callerId,
    answerOnBridge: true,
    timeLimit: MAX_CALL_SECONDS,
    action: opts.urls.dialComplete,
    method: "POST",
    ...(opts.recording
      ? {
          record: "record-from-answer-dual" as const,
          recordingStatusCallback: opts.urls.recordingStatus,
          recordingStatusCallbackMethod: "POST" as const,
          recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
        }
      : {}),
  });
  dial.number(
    {
      statusCallback: opts.urls.status,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      ...(opts.recording ? { url: opts.urls.announce, method: "POST" as const } : {}),
    },
    opts.number,
  );
  return r.toString();
}

export interface InboundClient {
  identity: string;
  params: Record<string, string>;
}

/**
 * Phone -> the team's browsers. Rings every owner/editor who takes calls in
 * the browser; whoever answers first gets the call. The Dial action decides
 * what happens when nobody answers (voicemail).
 */
export function incomingTwiml(opts: { announcement: string | null; recording: boolean; clients: InboundClient[]; urls: VoiceUrls }): string {
  const r = new VoiceResponse();
  if (opts.announcement) r.say(opts.announcement);
  const dial = r.dial({
    timeout: INBOUND_RING_SECONDS,
    timeLimit: MAX_CALL_SECONDS,
    action: opts.urls.dialComplete,
    method: "POST",
    ...(opts.recording
      ? {
          record: "record-from-answer-dual" as const,
          recordingStatusCallback: opts.urls.recordingStatus,
          recordingStatusCallbackMethod: "POST" as const,
          recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
        }
      : {}),
  });
  for (const c of opts.clients) {
    const client = dial.client({
      statusCallback: opts.urls.status,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["ringing", "answered", "completed"],
    });
    client.identity(c.identity);
    for (const [name, value] of Object.entries(c.params)) client.parameter({ name, value });
  }
  return r.toString();
}

/** Nobody answered: a short greeting and up to two minutes of message. */
export function voicemailTwiml(opts: { urls: VoiceUrls; greeting?: string }): string {
  const r = new VoiceResponse();
  r.say(opts.greeting || MESSAGES.voicemailGreeting);
  r.record({
    maxLength: VOICEMAIL_MAX_SECONDS,
    timeout: 5,
    playBeep: true,
    finishOnKey: "#",
    trim: "trim-silence",
    action: opts.urls.voicemailDone,
    method: "POST",
    recordingStatusCallback: opts.urls.recordingStatus,
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: ["completed", "absent"],
  });
  r.hangup();
  return r.toString();
}
