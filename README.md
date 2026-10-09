# Brandigade CRM

Brandigade's own CRM, shared by the whole team. The admin invites people by email and gives them editor or viewer access. Supabase holds the data and logins; GitHub runs the tests and deploys every change.

## What's in it

| Page | |
|---|---|
| **Dashboard** | Open pipeline, weighted forecast, won this month, win rate, deals closing soon, next tasks, recent activity. |
| **Pipeline** | Drag-and-drop deals: Lead, Qualified, Proposal sent, Negotiation, Won, Lost. |
| **Contacts / Companies** | Searchable records with deals and a call, email, meeting and note log. |
| **Tasks** | Kanban with reminders, linked to deals. Optional reminder emails. |
| **Team** | The owner invites people as editor or viewer, changes roles, removes people and sets the currency. |

The first person to sign up becomes the admin and owner. Sign up first yourself. Anyone else who signs up without an invite can log in but sees nothing until the owner adds them.

## One-time setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. Note the **project ref** (the `xxxx` in `https://xxxx.supabase.co`), the **database password** you chose, and from Project Settings → API the **Project URL** and **anon public key**.
3. Create a **personal access token** at supabase.com/dashboard/account/tokens.
4. Authentication → URL Configuration: set **Site URL** to the app address (see step 2.4) and add it under **Redirect URLs**.

### 2. GitHub
1. Repository → Settings → Secrets and variables → Actions.
2. **Secrets:** `SUPABASE_ACCESS_TOKEN` (the personal token) and `SUPABASE_DB_PASSWORD`.
3. **Variables:** none required. `SUPABASE_PROJECT_REF`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` default to this project's public Supabase values in the workflow (set them to override).
4. Settings → Pages → Source: **GitHub Actions**. The app is published at `https://<owner>.github.io/<repo>/`. If you use a custom domain, also add an `APP_URL` variable with that address.
5. Re-run the latest "Test and deploy" workflow (Actions tab), or push any change.

That's it. The workflow applies the database schema, deploys the edge functions, and publishes the site.

### 3. Optional: reminder emails
1. Create a [Resend](https://resend.com) account and verify a sending domain.
2. `supabase secrets set RESEND_API_KEY=... DUE_TASK_FROM_EMAIL="Brandigade CRM <crm@yourdomain.com>" BOARD_TIMEZONE=Asia/Karachi`
3. Fill in the two placeholders in `supabase/optional/email_reminders_cron.sql` and run it in the Supabase SQL editor.

## How updates reach the cloud

Push to `main` (or merge a pull request). GitHub Actions then:
1. runs the app tests and the database security tests,
2. applies any new files in `supabase/migrations/` with `supabase db push`,
3. redeploys the edge functions,
4. publishes the new `index.html` to GitHub Pages.

Pull requests run the tests only. Database changes always go in a **new** migration file; never edit one that has already been deployed.

## Try it without Supabase

Open `index.html` in a browser. With no keys in `config.js`, the login screen offers **Open the demo**: sample contacts, deals and teammates, with you as owner. Changes stay in that browser.

## Project layout

```
index.html                         the whole app (HTML, CSS, JS)
config.js                          Supabase URL + anon key (written by the deploy workflow)
assets/                            logo files (also embedded in index.html)
supabase/migrations/               database schema and row level security
supabase/functions/team-admin/     invite and remove team members
supabase/functions/send-due-task-emails/   optional reminder emails
supabase/optional/                 the cron job for reminder emails
tests/test_crm.js                  app tests (jsdom)
tests/sql/                         database and security tests (Postgres)
.github/workflows/deploy.yml       test and deploy pipeline
```

## Data model

- `workspaces`: exactly one row, the Brandigade CRM. It's created for the first person who signs up.
- `workspace_members`: who has access, as owner, editor or viewer.
- `profiles`: one per person; `is_platform_admin` marks the first account.
- `workspace_state`: the CRM data as one JSON document (`board`, `companies`, `contacts`, `deals`, `activities`, `settings`).

Saving rewrites that document, so two people saving in the same instant means the last save wins. That's fine for small teams; moving contacts and deals into their own tables is the next step if the data grows large.

## Tests

```
npm install
npm test                               # app tests
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db   # needs a Postgres 16 you can drop databases on
```
