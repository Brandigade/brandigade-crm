# Upgrade notes: October 2026

Read this if your work (a local copy, a branch, or a Claude session) started
before the upgrade, that is from commit `a1945c2` ("Send reminder emails at
the same moment as the in-app reminder", 9 October 2026) or earlier.

The upgrade is pull requests #1 and #2. It moved the CRM's data into real
tables and added Gmail/Outlook, task emails, calling and a timeline per
lead. The live database was switched over when those were merged.

## What moved where

| Before (`a1945c2`) | Now |
|---|---|
| `index.html` held everything: markup, styles and scripts | `index.html` is the page shell. Styles are in `css/*.css`; scripts are in `js/app.js` (screens), `js/data.js` (loading and saving), `js/timeline.js`, `js/email.js`, `js/notifications.js`, `js/dialer.js`, `js/system.js` and `js/demo.js` |
| All records in one JSON document, `workspace_state.data` (`companies`, `contacts`, `deals`, `board`, `activities`, `settings`) | One table per kind: `companies`, `contacts`, `deals`, `tasks` (was `board`), `activities`. Settings are in `workspaces.settings`. The browser still edits `state` and calls `saveState()`, which saves only the rows that changed (`js/data.js`) |
| `workspace_state` was read and written by the app | `workspace_state` is a **read-only backup** of the data as it was at the switch-over. Any write from a signed-in person fails |
| `supabase/functions/team-admin`, `supabase/functions/send-due-task-emails` | One Supabase Edge Function, `api`, built from `lib/server/` (`npm run build:edge`). Invites: `lib/server/core-routes.ts`. Task emails: `lib/server/notifications/` |
| The `send-due-task-emails` cron job | pg_cron job `crm-tick` → `/api/cron/tick` every minute, plus `crm-daily` |
| `config.js` written by the workflow | Written by `npm run build` (`scripts/build.mjs`) |
| `.github/workflows/deploy.yml`: tests, migrations, old functions, site | A new `deploy.yml`: tests on every pull request, and on `main` it updates the server, database and site (`scripts/deploy-server.sh`) |
| Secrets set by hand in Supabase | GitHub secrets, which the workflow copies into Supabase on every deploy ([SETUP.md](../SETUP.md)) |

Structure and rules: [ARCHITECTURE.md](ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md).

## Bringing older work across

1. Keep your work safe first: commit it on a branch (`git switch -c my-work && git commit -am "WIP"`).
2. `git fetch origin`, then `git rebase origin/main` (or merge it). Never force-push to `main`.
3. Resolve conflicts **towards the new layout**:
   - Move your change into the file that now holds that code (table above).
   - Don't restore the old `index.html`, `deploy.yml` or `supabase/functions/*` over the new ones.
4. Data your feature stores goes in a table: a new migration in `supabase/migrations/` with row level security, explicit grants and a test in `tests/sql/`. Map it in `DATA_TABLES` in `js/data.js` and in the demo stand-in (`js/demo.js`).
5. If you added new keys to the JSON document before the switch-over, that data is still in `workspace_state.data`, because the switch-over copied only the keys listed above. Copy it into its table with a new migration; don't read from or write to `workspace_state` in the app.
6. Before pushing:
   - `npm ci`, then `npm run typecheck && npm run lint && npm test && npm run test:db`.
   - For anything on screen, also `npm run test:e2e`, against the local Supabase (`supabase start`, `npm run seed:local`).
7. Open a pull request rather than pushing to `main`: a push to `main` deploys straight to the live CRM.

## Never do these against the live project

Each one either loses data or splits it between two places:

- Writing to `workspace_state`, or removing its read-only trigger. New edits would land in the old copy and never reach the tables.
- Editing a migration that has already been applied, `supabase db reset`, or dropping or truncating tables.
- Copying data from `workspace_state` over rows in the tables. The tables are newer.
- Deploying the old functions or the old site again.

## Checking the live state

- In the CRM, the **Team** page has a System status panel.
- `supabase migration list --linked` shows which migrations the live database has.
- **Actions → Test and deploy**: each run's summary shows which features are on.
