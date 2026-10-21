# Brandigade CRM: what's new and how to set it up

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

## What happens when you merge this

- The CRM stays at the same address: https://brandigade.github.io/brandigade-crm/
- Your current data is copied over automatically. Nothing is deleted, and the old copy is kept as a backup.
- It takes about 5 minutes. Ask the team to refresh the page afterwards.
- Hosting stays free (GitHub Pages and your current Supabase plan).

## To do

### 1. Merge (required)

1. Merge this pull request.
2. Open the **Actions** tab and wait until **Test and deploy** has a green tick (about 5 minutes).
3. Open the CRM and log in as usual.

That's all that's required. Task emails already work, from the Gmail account the CRM already uses for reminders.

### 2. Gmail inboxes (optional, about 15 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called "Brandigade CRM".
2. Search for **Gmail API** and click **Enable**.
3. Open **OAuth consent screen**. Choose **Internal** if you use Google Workspace (company Google accounts). Otherwise Google has to review the app first, which can take a few weeks.
4. Open **Clients → Create client → Web application**. Under **Authorized redirect URIs** add:
   `https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1/api/email/oauth/google/callback`
5. Add the **Client ID** and **Client secret** as the secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see "How to add a setting" below).

Then each person goes to **Profile → Email accounts → Connect Gmail**.

### 3. Outlook inboxes (optional, about 15 minutes)

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New registration**.
   - Name: "Brandigade CRM".
   - Accounts: "any organizational directory and personal Microsoft accounts".
   - Redirect URI: choose **Web**, then add `https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1/api/email/oauth/microsoft/callback`
2. Open **API permissions → Add a permission → Microsoft Graph → Delegated**. Tick `Mail.Read`, `Mail.Send`, `User.Read` and `offline_access`.
3. Open **Certificates & secrets → New client secret** and copy the **Value**. It expires; Microsoft shows when, so set yourself a reminder to renew it.
4. Add the **Application (client) ID** as `MICROSOFT_CLIENT_ID` and the secret's value as `MICROSOFT_CLIENT_SECRET`.

Then each person goes to **Profile → Email accounts → Connect Outlook**.

### 4. Calling (optional, paid)

1. Sign up at [twilio.com](https://www.twilio.com) and upgrade the account. A trial account can only call numbers you have verified.
2. Buy a phone number that supports **Voice**.
3. From the Twilio console home page, copy the **Account SID** and **Auth Token**.
4. Open **Account → API keys & tokens → Create API key** (Standard), and copy its **SID** and **Secret**.
5. Add these secrets:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_API_KEY_SID`
   - `TWILIO_API_KEY_SECRET`
   - `TWILIO_CALLER_ID`: your Twilio number, like `+14155550123`

   When you run the workflow, it connects the number to the CRM for you.
6. In the CRM, go to the **Team** page and choose the countries you call. Call recording stays off until you turn it on there. Only turn it on where recording calls is allowed.

## How to add or change a setting

1. In this repository, open **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**, or click an existing secret and then **Update**. Use the exact names from this page.
3. Open **Actions → Test and deploy → Run workflow**. The change is live in about 5 minutes.

To switch a feature off, delete its secrets and run the workflow again. Each run's summary page shows which features are on, and so does the **Team** page in the CRM.

## All settings

| Name | What it's for | Status |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Lets GitHub update Supabase | Already set |
| `SUPABASE_DB_PASSWORD` | The database password | Already set |
| `GMAIL_USER` (a variable) | The Gmail account task emails come from | Already set |
| `GMAIL_APP_PASSWORD` | That account's app password | Already set |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail inboxes | Add to switch on |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Outlook inboxes | Add to switch on |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_CALLER_ID` | Calling | Add to switch on |
| `MICROSOFT_TENANT_ID` | Optional: only allow your company's Microsoft accounts | Optional |
| `RESEND_API_KEY` | Optional: send task emails through Resend instead of Gmail | Optional |

The CRM creates its own internal keys. You never need to set those.

## Costs

- Hosting: free (GitHub Pages and your current Supabase plan).
- Gmail and Outlook: free.
- Calling: Twilio charges for the phone number (a few dollars a month) and per minute of calls.

## If something goes wrong

- Running the workflow again is always safe.
- If a run stops before the **Database** step, nothing changed for your team.
- If sign-up or password-reset emails don't arrive, add your Gmail account under **Supabase → Authentication → Emails → SMTP settings**.
