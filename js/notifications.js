/* ============================================================
   NOTIFICATION PREFERENCES
   Owned by the notifications integration. Contract (docs/ARCHITECTURE.md):
     - Profile page: personal email notification settings in
       #profile-notifications-section (task assigned, reminders, overdue,
       daily digest + hour + time zone), saved to user_preferences
     - Team page (owner): sender status and "send me a test email" in
       #team-integrations-section
   Server routes: /api/notifications/* (lib/server/notifications/routes.ts)
============================================================ */
window.NotificationsUI = window.NotificationsUI || {};
