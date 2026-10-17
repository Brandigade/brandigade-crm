/* ============================================================
   CALLING (Twilio)
   Owned by the dialer integration. Contract (docs/ARCHITECTURE.md):
     - click-to-call on contacts (hook "contact:row-actions"), the record
       header (hook "record:actions") and the task view (hook "task:actions")
     - call bar, disposition prompt after each call, incoming call panel with
       the matched lead's details, recording playback
     - window.DialerUI = { call({ contactId, taskId, number }), playRecording(callId, container), openDisposition(callId) }
       used by js/timeline.js on call items
   Server routes: /api/voice/* (lib/server/voice/routes.ts)
============================================================ */
window.DialerUI = window.DialerUI || {};
