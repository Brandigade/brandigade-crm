# Brandigade CRM

Brandigade's own CRM, shared by the whole team: contacts (leads), companies, a
deal pipeline and tasks, with Gmail/Outlook email, browser calling and task
email notifications, all on one activity timeline per lead.

**Setting it up or changing a setting: see [SETUP.md](SETUP.md).**

* **Site:** static HTML/CSS/vanilla JS (`index.html`, `css/`, `js/`) on GitHub Pages
* **Server:** one Supabase Edge Function, `api` (`supabase/functions/api` → `lib/server/`)
* **Data, logins, realtime, files:** Supabase (Postgres with row level security)
* **Background work:** Supabase `pg_cron` calls the server every minute
* **Deploys:** `.github/workflows/deploy.yml` on every push to `main`

How it fits together, and the rules for changing it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What's in it

| Page | |
|---|---|
| **Dashboard** | Open pipeline, weighted forecast, won this month, win rate, deals closing soon, next tasks, recent activity. |
| **Pipeline** | Drag-and-drop deals: Lead, Qualified, Proposal sent, Negotiation, Won, Lost. |
| **Contacts / Companies** | Searchable records. Each lead, company and deal has one **activity timeline**: emails, calls, task changes, notes and meetings, filterable, updating live. Notes can be private. |
| **Tasks** | Kanban with due dates, reminders and priorities, linked to a deal and/or a lead. |
| **Profile** | Connect your Gmail or Outlook mailbox, choose your email notifications, browser calling. |
| **Team** | The owner invites people as editor or viewer, sets the currency and the calling/recording options, and sees the system status. |

Roles: **owner** (everything), **editor** (works with all CRM data), **viewer**
(read-only). The first person to sign up becomes the owner; anyone else needs
an invite. Someone whose address already has a login joins from a link emailed
to that address and chooses a new password then, so nobody can get in by
registering a teammate's address first.

## Configuration

In production every setting is a GitHub repository secret; the deploy
workflow copies them into the Edge Function (see [SETUP.md](SETUP.md)). For
local development, copy `.env.example` to `.env`; every variable is explained
there. Only `SUPABASE_URL`, `SUPABASE_ANON_KEY` and the server's address reach
the browser.

## Local development

Needs Node 24 and the Supabase CLI with Docker.

```
npm ci
supabase start            # local Supabase on ports 573xx (see supabase/config.toml)
npm run seed:local        # test accounts from tests/fixtures/local-users.json
npm run dev               # http://localhost:3000, with the server on /api
```

`.env.local` (git-ignored) points the app at the local stack. Local emails
(sign-up, invites, notifications) land in Mailpit at http://127.0.0.1:57324.

To run the server the way production does, inside the local Edge Function:

```
npm run build:edge
supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.local
SERVER_URL=http://127.0.0.1:57321/functions/v1 npm run dev
```

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
For the E2E tests against the local Edge Function, also set
`SERVER_URL=http://127.0.0.1:57321/functions/v1` and
`E2E_API_URL=http://127.0.0.1:57321/functions/v1/api`.

## Database changes

Schema changes always go in a **new** file in `supabase/migrations/`; never edit
one that has been applied. The deploy workflow applies them (`supabase db
push`). Every new table needs RLS policies, explicit grants and a test in
`tests/sql/`.

## Project layout

```
index.html                 the app shell
css/, js/                  styles and front-end modules (load order in index.html)
lib/server/                server code: core helpers, email/, notifications/, voice/
supabase/functions/api/    the Edge Function that runs lib/server (built by npm run build:edge)
supabase/migrations/       schema, row level security, triggers, scheduler
scripts/                   dev server, builds, deploy, seeding, setup-cron, setup-twilio
tests/                     unit/, app/, sql/, e2e/
docs/ARCHITECTURE.md       architecture and working agreements
SETUP.md                   what's new, and how to switch each part on
```
