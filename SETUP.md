# Brandigade CRM: what's new and how to set it up

The CRM is live at https://brandigade.github.io/brandigade-crm/ with all your data. Hosting stays free (GitHub Pages and your current Supabase plan).

## What's new

- **Gmail and Outlook.** Each person connects their own inbox on the Profile page. Emails with a lead appear on that lead's page, and you can email a lead from the CRM. Private inboxes and private emails stay private. ([screenshot](docs/screenshots/profile.png))
- **Task emails.** You get an email when someone gives you a task, with a button that opens it. Reminders, overdue emails and a daily summary are optional; each person picks theirs on the Profile page. ([screenshot](docs/screenshots/task-email.png))
- **Calling.** Call a lead from the CRM in your browser. Calls are logged with their length and outcome, can be recorded, and incoming calls show who is calling. Until calling is set up, the Call button opens your phone's dialer and you log the call yourself. ([screenshot](docs/screenshots/log-a-call.png))
- **One timeline per lead.** Emails, calls, task updates and notes in one list, newest first. Notes can be private. ([screenshot](docs/screenshots/lead-timeline.png))
- **Safer and steadier.**
  - Two people editing at the same time no longer overwrite each other.
  - Permissions are checked by the database, not just the screen.
  - Invites can't be taken over by someone else.
  - Two old bugs are fixed: deals couldn't be saved, and the Escape key caused an error.

## What's on, and what's left to switch on

| Feature | Status | To switch it on |
|---|---|---|
| Everything above except the three below, including task emails | On | Nothing to do |
| Gmail inboxes | Off | Google settings: [Gmail inboxes](docs/SETTINGS.md#gmail-inboxes), about 15 minutes, free |
| Outlook inboxes | Off | Microsoft settings: [Outlook inboxes](docs/SETTINGS.md#outlook-inboxes), about 15 minutes, free |
| Calling | Off | A Twilio account: [Calling](docs/SETTINGS.md#calling-twilio), about 20 minutes, paid |

**[docs/SETTINGS.md](docs/SETTINGS.md)** lists every setting, where to get it, and how to put it in.

In short:
1. Open **Settings → Secrets and variables → Actions** and update the settings for the feature. They're already listed, holding `NOT_SET`.
2. Open **Actions → Apply settings → Run workflow**.

## Costs

- Hosting: free (GitHub Pages and your current Supabase plan).
- Gmail and Outlook: free.
- Calling: Twilio charges for the phone number (a few dollars a month) and per minute of calls.

## If something goes wrong

- **Apply settings** and **Test and deploy** can always be run again safely.
- If a **Test and deploy** run stops before the **Database** step, nothing changed for your team.
- If sign-up or password-reset emails don't arrive, add your Gmail account under **Supabase → Authentication → Emails → SMTP settings**.
