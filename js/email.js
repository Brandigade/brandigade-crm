/* ============================================================
   EMAIL (Gmail / Outlook)
   Owned by the email integration. Contract (docs/ARCHITECTURE.md):
     - Profile page: connected mailboxes in #profile-email-section
       (connect, reconnect, disconnect, sync now, sharing, status/errors)
     - Record header "Email" button (hook "record:actions") and task view
       "Email" button (hook "task:actions") open the composer
     - window.EmailUI = { openComposer({ to, contactId, replyTo }), openViewer(activity) }
       used by js/timeline.js for "Open" and "Reply" on email items
   Server routes: /api/email/* (lib/server/email/routes.ts)
============================================================ */
window.EmailUI = window.EmailUI || {};
