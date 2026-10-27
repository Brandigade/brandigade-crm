# Brandigade CRM settings

Every setting the CRM uses, where to get it, and how to put it in.

The CRM is live and already works with the settings that are filled in. The empty ones switch on extra features: Gmail inboxes, Outlook inboxes and calling.

## How to fill in a setting

All settings live in this GitHub repository. Every one is already listed, and the ones not filled in yet hold the placeholder `NOT_SET`.

1. Open **Settings → Secrets and variables → Actions**.
   - Most settings are on the **Secrets** tab.
   - `GMAIL_USER` and `NOTIFICATION_FROM_EMAIL` are on the **Variables** tab.
2. Click the pencil next to the name, paste the value, and click **Update**.
   - Paste only the value: no quotes, and no spaces before or after.
   - GitHub never shows a secret again after you save it. That's normal.
3. Open **Actions → Apply settings → Run workflow → Run workflow**.
   - After about 2 minutes, open the finished run. Its summary shows which features are on.
   - The **Team** page in the CRM shows the same, under System status.

To switch a feature off, set its secrets back to `NOT_SET` and run **Apply settings** again.

## All settings at a glance

| Setting | What it's for | Status |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Lets GitHub update the CRM on Supabase | Set |
| `SUPABASE_DB_PASSWORD` | The database password, used when deploying | Set |
| `GMAIL_USER` (variable) | The Gmail account task emails are sent from | Set |
| `GMAIL_APP_PASSWORD` | That account's app password | Set |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail inboxes | `NOT_SET` |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Outlook inboxes | `NOT_SET` |
| `MICROSOFT_TENANT_ID` | Optional: only your company's Microsoft accounts | `NOT_SET` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_CALLER_ID` | Calling | `NOT_SET` |
| `RESEND_API_KEY` | Optional: send task emails through Resend instead of Gmail | `NOT_SET` |
| `NOTIFICATION_FROM_EMAIL` (variable) | Optional: the sender name on task emails | `NOT_SET` |

The CRM makes its own internal keys: `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `TWILIO_TWIML_APP_SID`, `APP_URL` and `SERVER_URL`. You never need to add those.

---

## Gmail inboxes

**Settings:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**What it switches on:** each person can connect their Gmail on their Profile page. Emails with a lead then appear on that lead's timeline, and leads can be emailed from the CRM.

**How to get them** (about 15 minutes, free):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the company's Google account.
2. At the top, click the project picker and choose **New project**. Name it "Brandigade CRM" and click **Create**, then make sure it's selected.
3. Search for **Gmail API**, open it and click **Enable**.
4. Go to **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**) and click **Get started**.
   - App name: "Brandigade CRM". Support email: your address.
   - Audience: choose **Internal** if Brandigade uses Google Workspace (company Google accounts). That only lets people in your company connect, and needs no review by Google.
   - If you only have personal @gmail.com accounts, you must choose **External**. Then add each teammate under **Test users**. Until Google reviews the app (it can take weeks), connections expire every 7 days and have to be reconnected.
5. Go to **Clients → Create client**.
   - Application type: **Web application**. Name: "Brandigade CRM".
   - Under **Authorized redirect URIs**, click **Add URI** and paste exactly:
     `https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1/api/email/oauth/google/callback`
   - Click **Create**.
6. Copy the two values it shows:
   - **Client ID**, which ends in `.apps.googleusercontent.com` → into `GOOGLE_CLIENT_ID`
   - **Client secret**, which starts with `GOCSPX-` → into `GOOGLE_CLIENT_SECRET`
7. Run **Apply settings**.

**If connecting fails:** "redirect_uri_mismatch" means the address in step 5 isn't exactly the one above.

## Outlook inboxes

**Settings:** `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, and optionally `MICROSOFT_TENANT_ID`.

**What it switches on:** the same as Gmail, for Outlook and Microsoft 365 mailboxes.

**How to get them** (about 15 minutes, free):

1. Go to [entra.microsoft.com](https://entra.microsoft.com) and sign in with the company's Microsoft account.
2. Open **Applications → App registrations → New registration**.
   - Name: "Brandigade CRM".
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: choose **Web**, and paste exactly:
     `https://wqdysxpormmxxaakfgtu.supabase.co/functions/v1/api/email/oauth/microsoft/callback`
   - Click **Register**.
3. On the app's **Overview** page, copy the **Application (client) ID** (it looks like `1a2b3c4d-…`) → into `MICROSOFT_CLIENT_ID`.
4. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
   - Tick `Mail.Read`, `Mail.Send`, `User.Read` and `offline_access`, then **Add permissions**.
   - If there's a **Grant admin consent** button and your company requires it, click it.
5. Open **Certificates & secrets → New client secret**, choose an expiry, and click **Add**.
   - Copy the **Value** column, not the "Secret ID", into `MICROSOFT_CLIENT_SECRET`. It's only shown once.
6. Optional, to allow only your company's Microsoft accounts: copy the **Directory (tenant) ID** from the Overview page into `MICROSOFT_TENANT_ID`.
7. Run **Apply settings**.

**Good to know:** the client secret expires (Microsoft shows the date). Set yourself a reminder to make a new one before then, and paste it in the same way.

**If connecting fails:** "AADSTS50011" means the redirect address in step 2 isn't exactly the one above. "invalid client secret" usually means the Secret ID was copied instead of the Value.

## Calling (Twilio)

**Settings:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_CALLER_ID`.

**What it switches on:** calling leads from the browser. Calls are logged with their length and outcome, call recording is optional, and incoming calls show who's calling. Until then, the Call button opens the phone's dialer and calls are logged by hand.

**Cost:** Twilio is paid. A phone number costs a few dollars a month, and calls are charged per minute.

**How to get them** (about 20 minutes):

1. Sign up at [twilio.com](https://www.twilio.com) and upgrade the account by adding billing details. A trial account can only call numbers you've verified.
2. Buy a number: **Phone Numbers → Buy a number**, and pick one that supports **Voice**. It goes into `TWILIO_CALLER_ID` in full international format, with no spaces, like `+14155550123`.
3. On the Twilio Console home page, under **Account Info**:
   - **Account SID** (starts with `AC`) → into `TWILIO_ACCOUNT_SID`
   - **Auth Token** (click to show it) → into `TWILIO_AUTH_TOKEN`
4. Open **Account → API keys & tokens → Create API key**. Type: **Standard**. Name: "Brandigade CRM".
   - **SID** (starts with `SK`) → into `TWILIO_API_KEY_SID`
   - **Secret** → into `TWILIO_API_KEY_SECRET`. It's only shown once.
5. Run **Apply settings**. It connects the number to the CRM for you. The run's log says "Twilio setup failed" if a value is wrong.
6. In the CRM, open the **Team** page and choose which countries may be called. Call recording stays off until you turn it on there. Only turn it on where recording calls is allowed.

## Optional settings

- **`NOTIFICATION_FROM_EMAIL`** (variable): the name task emails show as sent from, like `Brandigade CRM <crm@brandigade.com>`.
  - With Gmail, only the name part is used. Emails always come from the `GMAIL_USER` address.
- **`RESEND_API_KEY`**: send task emails through [Resend](https://resend.com) instead of Gmail.
  - Create an API key there and verify your domain.
  - Also set `NOTIFICATION_FROM_EMAIL` to an address on that domain.
  - When this is filled in, Resend is used instead of Gmail.
- **`MICROSOFT_TENANT_ID`**: see Outlook inboxes, step 6.

## Changing the settings that are already set

You only need these if something changes. After changing any of them, run **Apply settings** (or **Test and deploy** for the two Supabase ones).

- **`GMAIL_APP_PASSWORD`**:
  1. Sign in to the `GMAIL_USER` Google account and open **Google Account → Security**.
  2. Make sure **2-Step Verification** is on, then open **App passwords**.
  3. Create one called "Brandigade CRM" and paste the 16-letter code. Spaces don't matter.
- **`GMAIL_USER`**: the Gmail address task emails are sent from. If you change it, make a new app password for that account too.
- **`SUPABASE_ACCESS_TOKEN`**: on [supabase.com](https://supabase.com), open your **Account → Access Tokens → Generate new token**.
- **`SUPABASE_DB_PASSWORD`**: Supabase → the project → **Project Settings → Database → Reset database password**. Then put the new password here straight away, or deploys will fail.

## If a feature doesn't switch on

- **Check the run's summary** (Actions → Apply settings → the latest run). It lists each feature as On or Off.
- **Check the names:** they must be spelled exactly as above, in capitals.
- **Check the values:** they must be pasted without quotes or extra spaces.
- **Running Apply settings again is always safe.**
