# Project briefing for Claude

Brandigade CRM: a multi-workspace CRM run as a SaaS. Built from a single-file PM starter. Read this before changing anything.

## Stack
- `index.html` is the whole front end (HTML, CSS, vanilla JS). No framework, no build step. Supabase JS from a pinned CDN tag. `config.js` holds the Supabase URL and anon key and is generated at deploy.
- Supabase: Postgres + RLS, Auth, Realtime, edge functions. Schema lives in `supabase/migrations/` and is applied by `supabase db push` in CI.
- GitHub Actions (`.github/workflows/deploy.yml`): tests, then migrations + functions, then GitHub Pages.

## Tenancy
- `workspaces`, `workspace_members` (owner/editor/viewer), `profiles` (`is_platform_admin`), `plans`, `workspace_state` (one JSON doc per workspace).
- RLS helpers: `is_platform_admin()`, `workspace_role(ws)`, `shares_workspace_with(user)`. Guard triggers stop non-admins changing plans, status, owner role or platform admin. Seat and contact limits are triggers.
- RPCs: `create_workspace`, `admin_list_workspaces`, `admin_list_users`.
- Invites and removals go through the `team-admin` edge function (service role), always with `workspaceId`.

## Front end
- Flow: `onLoggedIn` → `fetchMyProfile` → `fetchMyWorkspaces` → `afterWorkspacesLoaded` → onboarding or `enterWorkspace(id)`. `enterWorkspace` loads team + state, renders, and resubscribes realtime. Keep the `onLoggedInStarted` guard.
- `memberRole` is the real role; `currentRole` is what the UI enforces (drops to viewer when a workspace is suspended).
- Pages come from `TABS` (+ `ADMIN_TAB` for platform admins via `visibleTabs()`). Each has `<section id="tab-...">` and a render function in `renderAll()`; the admin console renders on demand (`renderAdmin`).
- CRM data: `COLLECTIONS` + `seedState()`. Contacts/companies/deals share the `RECORD_KINDS` modal.

## Rules to keep
1. Edit `state`, call `saveState()`, re-render.
2. Wrap data-changing handlers in `guardEdit()` / `guardOwnerOnly()`. RLS is the real protection: every new table needs policies and a test in `tests/sql/rls_test.sql`.
3. Never put the service-role key in the front end.
4. Escape user text with `escapeHtml()` before `innerHTML`.
5. Controls viewers keep need `data-always-enabled="true"`; call `applyRolePermissions()` after rendering controls.
6. No `alert()`/`confirm()`: use `notify()` and `await confirmDialog()`.
7. Colours come from the CSS tokens in `:root` and the two dark-theme blocks.
8. Never edit a deployed migration. Add a new timestamped file.

## Demo mode and tests
`createDemoClient()` is an in-browser stand-in for every Supabase call the app makes (tables, embeds, RPCs, team-admin, plan limits). Demo mode and `tests/test_crm.js` both run on it, so keep it in sync with new Supabase calls.
Run `npm test` and `npm run test:db` after changes. Take a Playwright screenshot for layout work.
