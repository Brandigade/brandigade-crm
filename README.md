# Brandigade CRM

A multi-workspace CRM that Brandigade runs as a SaaS. Each customer signs up, gets their own workspace, and invites their team. You manage every workspace, plan and user from the Admin console. Supabase holds the data and logins; GitHub runs the tests and deploys every change.

## What's in it

| For customers | |
|---|---|
| **Dashboard** | Open pipeline, weighted forecast, won this month, win rate, deals closing soon, next tasks, recent activity. |
| **Pipeline** | Drag-and-drop deals: Lead, Qualified, Proposal sent, Negotiation, Won, Lost. |
| **Contacts / Companies** | Searchable records with deals and a call, email, meeting and note log. |
| **Tasks** | Kanban with reminders, linked to deals. Optional reminder emails. |
| **Team** | Owner invites people as editor or viewer, sees plan usage, renames the workspace, sets the currency. |
| **Workspaces** | Anyone can belong to several workspaces and switch from the sidebar. |

| For Brandigade (platform admins) | |
|---|---|
| **Admin console** | Every workspace with owner, plan, seats, contacts, deals and last activity. Change plans, suspend or reactivate, open any workspace. Edit plan limits and prices. Grant or remove platform admin. Monthly revenue and total pipeline at the top. |

Plans start as Free (3 seats, 250 contacts), Pro (10 seats, $29) and Business (50 seats, $99). Limits are enforced by the database, not just the app. Billing is manual for now: you change a customer's plan in the Admin console.

The first person to sign up becomes a platform admin. Sign up first yourself.

## One-time setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. Note the **project ref** (the `xxxx` in `https://xxxx.supabase.co`), the **database password** you chose, and from Project Settings → API the **Project URL** and **anon public key**.
3. Create a **personal access token** at supabase.com/dashboard/account/tokens.
4. Authentication → URL Configuration: set **Site URL** to the app address (see step 2.4) and add it under **Redirect URLs**.

### 2. GitHub
1. Repository → Settings → Secrets and variables → Actions.
2. **Secrets:** `SUPABASE_ACCESS_TOKEN` (the personal token) and `SUPABASE_DB_PASSWORD`.
3. **Variables:** `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
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

Open `index.html` in a browser. With no keys in `config.js`, the login screen offers **Open the demo workspace**: sample customers, deals and workspaces, with you as platform admin. Changes stay in that browser.

## Project layout

```
index.html                         the whole app (HTML, CSS, JS)
config.js                          Supabase URL + anon key (written by the deploy workflow)
assets/                            logo files (also embedded in index.html)
supabase/migrations/               database schema, row level security, plan limits, admin functions
supabase/functions/team-admin/     invite and remove workspace members
supabase/functions/send-due-task-emails/   optional reminder emails for every workspace
supabase/optional/                 the cron job for reminder emails
tests/test_crm.js                  app tests (jsdom)
tests/sql/                         database and security tests (Postgres)
.github/workflows/deploy.yml       test and deploy pipeline
```

## Data model

- `plans`: seat and contact limits, monthly price.
- `workspaces`: one per customer, with `plan_id` and `status` (active or suspended).
- `workspace_members`: who is in which workspace, as owner, editor or viewer.
- `profiles`: one per person; `is_platform_admin` marks Brandigade staff.
- `workspace_state`: each workspace's CRM data as one JSON document (`board`, `companies`, `contacts`, `deals`, `activities`, `settings`).

Saving rewrites a workspace's document, so two people saving in the same instant means the last save wins. That's fine for small teams; moving contacts and deals into their own tables is the next step if customers grow large.

## Tests

```
npm install
npm test                               # app tests
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db   # needs a Postgres 16 you can drop databases on
```
