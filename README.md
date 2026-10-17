# Brandigade CRM

Brandigade's own CRM, shared by the whole team: contacts (leads), companies, a
deal pipeline and tasks, with Gmail/Outlook email, browser calling and task
email notifications, all on one activity timeline per lead.

* **Front end:** static HTML/CSS/vanilla JS (`index.html`, `css/`, `js/`)
* **Server:** one Vercel Function (`api/index.ts` → `lib/server/`)
* **Data, logins, realtime, files:** Supabase (Postgres with row level security)
* **Background work:** Supabase `pg_cron` calls the server every minute

How it fits together, and the rules for changing it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What's in it

| Page | |
|---|---|
| **Dashboard** | Open pipeline, weighted forecast, won this month, win rate, deals closing soon, next tasks, recent activity. |
| **Pipeline** | Drag-and-drop deals: Lead, Qualified, Proposal sent, Negotiation, Won, Lost. |
| **Contacts / Companies** | Searchable records. Each lead, company and deal has one **activity timeline**: emails, calls, task changes, notes and meetings, filterable, updating live. Notes can be private. |
| **Tasks** | Kanban with due dates, reminders and priorities, linked to a deal and/or a lead. |
| **Profile** | Connect your Gmail or Outlook mailbox, choose your email notifications, browser calling. |
| **Team** | The owner invites people as editor or viewer, sets the currency and the calling/recording options. |

Roles: **owner** (everything), **editor** (works with all CRM data), **viewer**
(read-only). The first person to sign up becomes the owner; anyone else needs
an invite. Someone whose address already has a login joins from a link emailed
to that address and chooses a new password then, so nobody can get in by
registering a teammate's address first.

## Configuration

Copy `.env.example` to `.env` and fill it in; on Vercel set the same variables
under Project → Settings → Environment Variables. Every variable is explained
in `.env.example`. Only `SUPABASE_URL` and `SUPABASE_ANON_KEY` reach the
browser.

| Integration | Needs | Without it |
|---|---|---|
| Core CRM | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL` | — |
| Scheduler | `CRON_SECRET` on Vercel + `npm run setup:cron` once | no background sync or notification emails |
| Gmail | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` | "Connect Gmail" says it isn't set up |
| Outlook | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `TOKEN_ENCRYPTION_KEY` | "Connect Outlook" says it isn't set up |
| Notification emails | `GMAIL_USER` + `GMAIL_APP_PASSWORD`, or `RESEND_API_KEY`, or `SMTP_*` | no notification emails (in-app reminders still work) |
| Calling | `TWILIO_*` (6 values) | call buttons open the phone's dialer and offer to log the call by hand |

### Google (Gmail)
1. Google Cloud Console → create a project → enable the **Gmail API**.
2. OAuth consent screen: if Brandigade uses Google Workspace choose **Internal** (no Google review needed). An **External** app with Gmail scopes needs Google's verification for restricted scopes, and while it is in "Testing" refresh tokens expire after 7 days.
3. Credentials → OAuth client ID → **Web application**, authorized redirect URIs: `https://brandigade-crm.vercel.app/api/email/oauth/google/callback` (and `http://localhost:3000/api/email/oauth/google/callback` for development).

### Microsoft (Outlook / Microsoft 365)
1. Microsoft Entra admin center → App registrations → New registration; supported accounts: any organizational directory and personal Microsoft accounts (or single tenant).
2. Authentication → Web → redirect URI `https://brandigade-crm.vercel.app/api/email/oauth/microsoft/callback` (+ the localhost one).
3. Certificates & secrets → new client secret. API permissions (delegated): `openid`, `email`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`.

### Twilio (calling)
1. Twilio Console: note the Account SID and Auth Token; create an API key (Standard); buy (or use the trial) phone number with Voice.
2. Put the values in the environment, then run `npm run setup:twilio`: it creates the TwiML App and points the number's incoming calls at the CRM. Add the printed `TWILIO_TWIML_APP_SID`.
3. Call recording is off until the owner turns it on (Team page). When on, both sides hear a recording notice; check the consent rules where you and your clients are.

### Scheduler
Vercel's Hobby plan only allows daily cron jobs, so the minute-by-minute
schedule runs in Supabase (`pg_cron`). After setting `APP_URL` and
`CRON_SECRET` (the same value on Vercel), run once:

```
npm run setup:cron
```

## Local development

Needs Node 24 and the Supabase CLI with Docker.

```
npm ci
supabase start            # local Supabase on ports 573xx (see supabase/config.toml)
npm run seed:local        # test accounts from tests/fixtures/local-users.json
npm run dev               # http://localhost:3000
```

`.env.local` (git-ignored) points the app at the local stack; `.env` holds the
real provider credentials. Local emails (sign-up, invites, notifications) land
in Mailpit at http://127.0.0.1:57324.

## Tests

```
npm run typecheck
npm run lint
npm run test:unit      # server logic (Vitest)
npm run test:app       # the whole UI in jsdom against the in-browser stand-in
npm run test:db        # RLS, grants, triggers, upgrade rehearsal (needs a Postgres you can drop databases on)
npm run test:e2e       # Playwright: dev server + local Supabase
```

`test:db` uses `psql`; set `PSQL="docker exec -i <container> psql -U postgres"` to use a Postgres in Docker.

## Database changes

Schema changes always go in a **new** file in `supabase/migrations/`; never edit
one that has been applied. Apply them with `supabase db push` (or from CI, see
`.github/workflows/ci.yml`). Every new table needs RLS policies, explicit
grants and a test in `tests/sql/`.

## Project layout

```
index.html                 the app shell
css/, js/                  styles and front-end modules (load order in index.html)
api/index.ts               the Vercel Function (all /api/* routes)
lib/server/                server code: core helpers, email/, notifications/, voice/
supabase/migrations/       schema, row level security, triggers, scheduler
scripts/                   dev server, build, seeding, setup-cron, setup-twilio
tests/                     unit/, app/, sql/, e2e/
docs/ARCHITECTURE.md       architecture and working agreements
vercel.json                build, routing, security headers, daily backstop cron
```
