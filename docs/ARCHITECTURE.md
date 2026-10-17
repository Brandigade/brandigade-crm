# Brandigade CRM — architecture and working agreements

This is the contract every part of the CRM is built against. Read it before
changing anything; when you change a convention, change this file too.

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Front end | `index.html`, `css/*.css`, `js/*.js` — static files served by Vercel | Vanilla JS, no framework, no bundler. Classic `<script>` files sharing one global scope, loaded in the order in `index.html`. |
| Server | `api/index.ts` (one Vercel Function) → `lib/server/**` | Node.js 24, TypeScript, Web-standard `Request`/`Response`. `vercel.json` rewrites `/api/*` to it; `lib/server/routes.ts` routes by path. |
| Database, auth, realtime, file storage | Supabase (project `wqdysxpormmxxaakfgtu`) | Postgres with row level security on every table. Schema only via `supabase/migrations/`. |
| Scheduler | Supabase `pg_cron` → `POST /api/cron/tick` every minute | Vercel Hobby cron can only run once a day, so the minute-level schedule lives in Supabase (migration `20261017100300_scheduler.sql`). Vercel's daily cron (`/api/cron/daily`) is a backstop + housekeeping. |

### Why these choices (short)
* **Records moved out of the JSON document** (`workspace_state.data`) into real tables. Saving rewrote the whole document, so background writers (email sync, call webhooks) would have been overwritten by the next browser save, and RLS had nothing to protect per record. The old document is kept, read-only, as a backup.
* **The UI kept its in-memory `state`.** `js/data.js` maps it to the tables and saves only changed records, so the existing screens barely changed.
* **One server runtime.** The old Supabase Edge Functions (`team-admin`, `send-due-task-emails`) are replaced by Vercel routes; the Edge Function source stays in `supabase/functions/` only for the old site until cutover.
* **Vercel Hobby limits respected:** functions ≤ 300 s, request/response ≤ 4.5 MB, cron ≥ 1/day. Long or large work is chunked through the job queue; recordings are served from Supabase Storage via signed URLs, never streamed through a function.

## 2. Ownership and boundaries

| Area | Owner | Files |
|---|---|---|
| Schema, RLS, timeline triggers, core data layer, timeline UI, core screens, system status, server core | **Integrator** | `supabase/migrations/**`, `js/app.js`, `js/data.js`, `js/demo.js`, `js/timeline.js`, `js/system.js`, `css/app.css`, `css/timeline.css`, `index.html`, `lib/server/*.ts` (top level), `api/**`, `vercel.json`, `package.json` |
| Email (Gmail + Outlook) | **Email session** | `lib/server/email/**`, `js/email.js`, `css/email.css`, `tests/unit/email/**` |
| Task notifications | **Notifications session** | `lib/server/notifications/**`, `js/notifications.js`, `css/notifications.css`, `tests/unit/notifications/**` |
| Calling (Twilio) | **Dialer session** | `lib/server/voice/**`, `js/dialer.js`, `css/dialer.css`, `tests/unit/voice/**`, `scripts/setup-twilio.ts` |

Rules for feature sessions:
* **Don't edit files you don't own.** If you need a change there (a hook, a column, a dependency), write it down in your final report under "Integrator changes needed", with the exact diff you want. Don't add npm packages; if one is essential, ask in the report.
* **Don't add migrations.** The schema below is final for this round. If something is truly missing, put the SQL in `docs/proposals/<area>.sql` and explain.
* Each module exports exactly the names in §5 so `lib/server/routes.ts` and `lib/server/cron.ts` keep compiling.

## 3. Data model (Supabase)

All CRM tables have `workspace_id` (the single Brandigade CRM workspace) and RLS. Roles come from `workspace_members.role`: **owner** (everything), **editor** (read/write CRM data), **viewer** (read-only). Helper functions: `crm_can_read(ws)`, `crm_can_write(ws)`, `is_workspace_owner(ws)`, `is_workspace_member(ws)`.

| Table | What | Who writes |
|---|---|---|
| `companies`, `contacts`, `deals`, `tasks` | CRM records. `contacts` = leads; `email_normalized` and `phone_digits` (generated) are what email and call matching use. `tasks.contact_id` links a task to a lead; `assignment_version` increments on every reassignment. | Browser (owner/editor) via `js/data.js` |
| `activities` | **The unified timeline.** `source`: `manual` (logged by hand), `email`, `call`, `task`. `visibility`: `team` or `private` (only `owner_user_id` sees it). Links: `contact_id`, `company_id`, `deal_id`, `related_contact_ids[]`, and the source row (`email_message_id`, `call_id`, `task_id`). | Browser: manual only. Everything else: **database triggers** — never insert email/call/task activities yourself. |
| `email_accounts` | A connected mailbox (one person). `status`: `active`, `reconnect_required`, `error`, `disconnected`. `sharing`: `team` (default) / `private`. Sync bookkeeping: `sync_cursor` (jsonb, provider-specific), `next_sync_at`, `sync_lock_until`, `consecutive_failures`, `last_error`. | Server only |
| `email_account_tokens` | Encrypted tokens (`encryptSecret(token, accountId)`). No client role can read it. | Server only |
| `oauth_states` | One row per OAuth attempt: `state_hash` (sha256 of the state value), encrypted PKCE verifier, expiry. | Server only |
| `email_messages` | Stored **only if it involves a lead** (`matched_contact_ids` not empty). One row per mailbox copy: unique `(account_id, provider_message_id)`. Addresses are lowercased; `to_addresses`/`cc_addresses`/`bcc_addresses` are `[{ "email": "...", "name": "..." }]`. `body_html` must be sanitized before storing. | Server only. The `email_messages_timeline` trigger turns rows into timeline activities (deduplicated across mailboxes by `internet_message_id`; private copies → private activity). |
| `email_sends` | Every compose/reply request, unique `(user_id, client_request_id)` → a retried request can't send twice. | Server only |
| `calls` | One row per call, unique `provider_call_sid` (Twilio parent CallSid); `company_id` for calls to a company's main number. Status moves forward only. Disposition via RPC `set_call_disposition`. Recording: `recording_sid`, `recording_status` (`available` once copied to storage), `recording_storage_path` in bucket `call-recordings` (private). | Server only (+ RPC). `calls_timeline` trigger keeps its activity in step. |
| `user_preferences` | Per person: `notify_task_assigned`, `notify_task_reminders`, `notify_task_overdue`, `notify_daily_digest`, `digest_hour`, `timezone`, `calls_receive_inbound`. No row = defaults. | Browser (own row) |
| `job_queue` | Background jobs, idempotent by `dedupe_key`. | Server only |
| `workspaces.settings` | jsonb: `currency`, `timezone`, `seeded`, and for calling `callRecording` (`"off"`/`"on"`), `recordingAnnouncement` (text), `recordingAccess` (`"owner"`/`"editors"`/`"all"`), `defaultCountry` (ISO, for phone numbers). Owner-only writes. | Browser (owner) |

Database functions you can use:
* Browser (`sb.rpc`): `get_timeline(p_kind, p_id, p_before, p_before_id, p_limit, p_types)`, `set_call_disposition(p_call, p_disposition, p_notes)`, `update_email_account_settings(p_account, p_sharing, p_sync_enabled)`, `set_email_visibility(p_message, p_visibility)`, `can_play_recording(p_call)`, `ensure_workspace_timezone(p_workspace, p_timezone)`.
* Server (service role): `enqueue_job(...)`, `claim_jobs(kinds, limit, lease_seconds)`, `claim_email_accounts(limit, lease_seconds)` (only mailboxes of current owners/editors), `reap_dead_jobs()`, `scheduler_status()`, `configure_cron(url, secret)`.

Jobs the database queues itself:
* `notify.task_assigned` — payload `{ task_id, assignee_id, assigned_by, assignment_version }`, dedupe `task_assigned:<task>:<version>`. Not queued for self-assignment or done tasks.
* `email.backfill_contact` — payload `{ contact_id, email }`, dedupe `email_backfill:<contact>:<email>`, when a lead gets a new email address and any mailbox is connected.

Jobs the server queues (notification scheduler, every tick):
* `notify.task_reminder` — dedupe `task_reminder:<task>:<due_date>:<HH:MM or empty>:<reminder>` (the old reminder emails' rule: at the reminder time, at most 24 h late, assignee or else the owner).
* `notify.task_overdue` — dedupe `task_overdue:<task>:<due_date>:<HH:MM or empty>` (1 h after the due time; date-only tasks the next day at the person's digest hour).
* `notify.daily_digest` — dedupe `digest:<user>:<local yyyy-mm-dd>`.
* `voice.copy_recording` — dedupe `voice_recording:<RecordingSid>`: copies a finished Twilio recording into the private `call-recordings` bucket.
* `notify.test_email` — dedupe `test_email:<user>:<UTC yyyy-mm-ddThh:mm>` (the "send me a test email" rate limit).
Every notification handler re-checks the task, person and preferences when it runs and ends "skipped" when the email no longer applies. A send receipt is stored in the job result, so a re-run never sends again.

## 4. Server conventions (`lib/server`)

* A route module exports `Route[]` (`{ method, path, handler }`, paths like `/api/email/accounts/:id/sync`). Handlers take `(req: Request, ctx: { url, params })` and return a `Response`. Throw `HttpError` (`badRequest`, `forbidden`, `notConfigured`, ...); the router turns errors into `{ error, code }` JSON without leaking internals.
* **Authenticate every browser route** with `requireAuth(req, { roles })` (`lib/server/auth.ts`). It verifies the Supabase JWT with Supabase Auth and loads the caller's membership. Use `EDITORS` for anything that changes data or sends anything; viewers are read-only.
* Two Supabase clients: `ctx.db` from `requireAuth` acts **as the user** (RLS applies) — prefer it for reads that should respect permissions. `adminClient()` (service role) bypasses RLS — use it only for server-owned tables and after checking permissions in code. Never return service-role query results to the browser unfiltered.
* Webhooks (Twilio) and cron routes are not called by the browser: verify their signature/secret first (`requireCronSecret`, Twilio `X-Twilio-Signature` over `publicUrl(req, appUrl())` from `router.ts`).
* Read bodies with `readJson` / `readForm` (size-limited). Validate everything; clip strings with `str(v, max)`.
* Provider HTTP calls go through `fetchWithRetry` + `expectJson` (`lib/server/retry.ts`): timeouts, retries on 429/5xx with backoff, `Retry-After` honoured; a long rate limit throws `RateLimitError` so the caller can reschedule.
* Secrets: only via `lib/server/env.ts`. `features.*()` tells whether an integration is configured; when it isn't, routes answer `503 not_configured` and the UI shows a "not set up yet" state — never a fake success.
* For tests, provider base URLs must be overridable by environment variables (e.g. `GMAIL_API_BASE`, `GRAPH_API_BASE`, `GOOGLE_OAUTH_BASE`, `MICROSOFT_LOGIN_BASE`, `TWILIO_API_BASE`, `RESEND_API_BASE`, `GMAIL_SMTP_HOST`/`GMAIL_SMTP_PORT`), defaulting to the real ones.
* `GET /api/voice/setup` (owner) lists which calling settings are missing (names only). `TWILIO_API_BASE` exists for tests only.
* Exception to "editors for anything that sends": `POST /api/notifications/test` is open to every member, because it only ever emails the caller and is limited to one a minute.
* Background work: register job handlers (`Record<kind, JobHandler>`) and let `runJobs` claim them. Handlers must be idempotent (a job can run twice after a crash). Throw `PermanentJobError` to stop retrying, `RetryJobLater(ms)` to reschedule.
* Logs: `console.error`/`console.warn` with context, never tokens, email bodies or full addresses lists.

## 5. Module exports the core depends on

```ts
// lib/server/email/routes.ts          export const emailRoutes: Route[]
// lib/server/email/worker.ts          export const emailJobHandlers: Record<string, JobHandler>   // must handle "email.backfill_contact"
//                                     export async function syncDueEmailAccounts(opts: { deadline: number }): Promise<unknown>
// lib/server/notifications/routes.ts  export const notificationRoutes: Route[]
// lib/server/notifications/worker.ts  export const notificationJobHandlers: Record<string, JobHandler>  // must handle "notify.task_assigned"
//                                     export async function scheduleNotifications(opts: { now: Date }): Promise<unknown>
// lib/server/voice/routes.ts          export const voiceRoutes: Route[]
// lib/server/voice/worker.ts          export const voiceJobHandlers: Record<string, JobHandler>
```

`GET /api/config` returns `{ features: { gmail, outlook, calling, notifications } }` (booleans) — the browser reads it into `appFeatures`.

## 6. Front-end conventions

* Global helpers from `js/app.js`: `state`, `currentUser`, `currentRole`, `currentWorkspace`, `teamList`, `appFeatures`, `sb` (Supabase client), `api(path, { method, body })` (calls `/api` with the user's token; throws `Error` with `.status`/`.code`), `notify(title, body)`, `confirmDialog(msg, okLabel)`, `escapeHtml`, `newId()`, `guardEdit(fn)`, `guardOwnerOnly(fn)`, `applyRolePermissions()`, `openRecordModal(kind, id)`, `openTaskViewModal(id)`, `contactById`, `contactName`, `companyById`, `dealById`, `personName(userId)`, `logActivity(kind, id, fields)`, `findRecord(coll, id)`, `relTime`, `fmtDay`. From `js/timeline.js`: `refreshOpenTimeline()`, `renderActivityItem(a, opts)`, `fmtDuration(sec)`. From `js/data.js`: `saveState()`, `saveSettings()` (owner), `friendlyDbError(e)`.
* **Hooks** (`CRMHooks.on(name, fn)`; handlers returning DOM nodes get them inserted):

| Hook | Arguments | Return |
|---|---|---|
| `app:ready` | `{ workspace, user, role }` once the CRM opened | — |
| `app:deeplink` | `URLSearchParams` of the page URL (e.g. `?email_connected=google`) | `true` if handled |
| `realtime:channel` | `(channel, workspaceId)` before it subscribes — add `.on("postgres_changes", ...)` | — |
| `data:changed` | `coll` after a remote change was applied | — |
| `record:actions` | `(kind, record)` record modal opened (`kind`: contact/company/deal) | `Node` or `Node[]` for the header |
| `record:sections` | `(kind, id, box)` related sections being drawn | append to `box` yourself |
| `task:actions` | `(task, lead)` task view opened (`lead` may be null) | `Node`/`Node[]` |
| `contact:row-actions` | `(contact)` contacts table row | `Node`/`Node[]` next to the phone number |
| `profile:render` | `(tabEl)` — draw into `#profile-email-section`, `#profile-notifications-section`, `#profile-calling-section` | — |
| `team:render` | `(tabEl)` — owner-only settings into `#team-integrations-section` (append your own child panel, don't clear the container) | — |
| `activity:logged` | `(activity)` after a manual log | — |
| `escape` | Escape pressed (close your dialogs) | — |

* Module globals: `window.EmailUI = { openComposer({ to, contactId, replyTo }), openViewer(activity) }`, `window.DialerUI = { call({ contactId, companyId, dealId, taskId, number }), playRecording(callId, container), openDisposition(callId) }` (both used by the timeline), `window.NotificationsUI = { teamDueInstant(date, time, tz?), reloadPreferences(), refreshStatus() }` (the in-app reminders use `teamDueInstant` so they ring at the same moment as the reminder email).
* Escape every piece of user or provider text with `escapeHtml()` before `innerHTML`. Untrusted email HTML is only shown inside a sandboxed `<iframe sandbox srcdoc>` (no `allow-scripts`, no `allow-same-origin`).
* No `alert()`/`confirm()`: `notify()` and `await confirmDialog()`.
* Controls viewers may use need `data-always-enabled="true"`; call `applyRolePermissions()` after drawing controls.
* Colours only from the CSS tokens in `css/app.css` (`--surface`, `--ink`, `--muted`, `--line`, `--accent`, `--good`, `--warn`, `--bad`, ...). Reusable bits in `css/timeline.css`: `.feature-panel`, `.setting-row`, `.switch`, `.status-dot.ok|warn|bad`, `.btn-sm`, `.btn-icon`, `.tl-pill`.
* Every integration screen needs loading, error, empty and "not set up" states, and works on a phone-width screen.
* The CSP is in `vercel.json` (the dev server applies it too): scripts only from `'self'` and `https://cdn.jsdelivr.net` (pin exact versions), no inline scripts. If you need another origin, say so in your report.
* Demo mode (`js/demo.js`) has no server: `api()` returns `{ accounts: [] }` for `/email/accounts` and throws `status 501` for anything else. Show a short "not available in the demo" message in that case.

## 7. Security rules (non-negotiable)

1. No secret ever reaches the browser. Only `SUPABASE_URL` and `SUPABASE_ANON_KEY` are in `config.js`.
2. Authorization is enforced in the database (RLS) **and** on the server; the UI only mirrors it.
3. OAuth: `state` is random, single-use, expires in 10 minutes and is bound to the user who started it; PKCE (S256) where the provider supports it; redirect URIs are fixed from `APP_URL`. Tokens are encrypted with `encryptSecret(value, accountId)` before storage and never logged.
4. A person can only use their own mailbox; nobody can read another person's private emails, including the owner.
5. Webhooks verify signatures before doing anything and are idempotent (Twilio retries).
6. Phone calls can only be placed to numbers stored on CRM contacts/companies (no free dialling → no toll fraud).
7. Recordings are private: a signed URL valid for minutes, only after `can_play_recording()`.
8. Don't put personal data in URLs (except record ids).

## 8. Local development and tests

* Local Supabase runs in WSL (`supabase start` from the repo, ports **573xx**: API `http://127.0.0.1:57321`, DB `postgresql://postgres:postgres@127.0.0.1:57322/postgres`, Mailpit `http://127.0.0.1:57324`, SMTP `127.0.0.1:57325`). It is **shared** — never run `supabase db reset`, `supabase stop` or apply migrations from a feature session.
* `.env.local` (git-ignored) points the app at the local stack; copy it into your worktree. `npm run dev` serves on `PORT` (default 3000; feature sessions use their own port and set `APP_URL` to match).
* Test accounts: `tests/fixtures/local-users.json` (owner, editor, viewer, outsider). `npm run seed:local` creates them.
* `npm run typecheck`, `npm run lint`, `npm run test:unit` (Vitest, `tests/unit/**`), `npm run test:app` (jsdom, the whole UI against the demo client), `npm run test:db` (RLS tests in Postgres), `npm run test:e2e` (Playwright against the dev server + local Supabase).
* Unit tests must not hit real providers: inject `fetchImpl`, or point the `*_API_BASE` variables at a local fake.
