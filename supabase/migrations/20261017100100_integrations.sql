-- ============================================================================
-- Tables for the integrations: connected mailboxes, synced emails, calls,
-- personal notification preferences and the background job queue.
--
-- Security model
--   * OAuth tokens and OAuth state live in tables no client role can touch;
--     only the server (service role) reads them, and tokens are encrypted by
--     the server before they are stored.
--   * A mailbox belongs to one person. Emails from it are shared with the team
--     only when that person's mailbox is set to "team" (the default); a
--     "private" email is visible to nobody but the mailbox owner.
--   * Calls are visible to the whole team; recordings only to the roles the
--     owner allows (settings.recordingAccess), checked by can_play_recording().
--   * All writes to these tables go through the server or SECURITY DEFINER
--     functions that check the caller first.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Connected mailboxes
-- ---------------------------------------------------------------------------
create table if not exists public.email_accounts (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  user_id               uuid not null references public.profiles(id) on delete cascade,
  provider              text not null check (provider in ('google', 'microsoft')),
  email_address         text not null check (char_length(email_address) <= 320),
  display_name          text,
  status                text not null default 'active' check (status in ('active', 'reconnect_required', 'error', 'disconnected')),
  sharing               text not null default 'team' check (sharing in ('team', 'private')),
  sync_enabled          boolean not null default true,
  sync_cursor           jsonb not null default '{}'::jsonb,
  initial_sync_done     boolean not null default false,
  last_synced_at        timestamptz,
  last_sync_started_at  timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  consecutive_failures  integer not null default 0,
  next_sync_at          timestamptz not null default now(),
  sync_lock_until       timestamptz,
  connected_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (workspace_id, user_id, provider, email_address)
);
create index if not exists email_accounts_due_idx on public.email_accounts(next_sync_at) where status = 'active' and sync_enabled;
create index if not exists email_accounts_user_idx on public.email_accounts(user_id);

-- Server only. Values are AES-256-GCM ciphertext produced by lib/server/crypto.ts.
create table if not exists public.email_account_tokens (
  account_id              uuid primary key references public.email_accounts(id) on delete cascade,
  access_token_enc        text,
  refresh_token_enc       text,
  access_token_expires_at timestamptz,
  scope                   text,
  updated_at              timestamptz not null default now()
);

-- Server only. One row per OAuth attempt; the state value itself is never stored.
create table if not exists public.oauth_states (
  state_hash        text primary key,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  provider          text not null check (provider in ('google', 'microsoft')),
  code_verifier_enc text not null,
  return_to         text,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Emails. Only messages that involve a CRM lead are stored. One row per copy
-- in a mailbox; the timeline shows each email once (see the timeline migration).
-- ---------------------------------------------------------------------------
create table if not exists public.email_messages (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  account_id          uuid not null references public.email_accounts(id) on delete cascade,
  owner_user_id       uuid not null references public.profiles(id) on delete cascade,
  provider            text not null check (provider in ('google', 'microsoft')),
  provider_message_id text not null,
  provider_thread_id  text,
  internet_message_id text,
  in_reply_to         text,
  references_header   text,
  direction           text not null check (direction in ('inbound', 'outbound')),
  from_address        text,
  from_name           text,
  to_addresses        jsonb not null default '[]'::jsonb,
  cc_addresses        jsonb not null default '[]'::jsonb,
  bcc_addresses       jsonb not null default '[]'::jsonb,
  subject             text,
  snippet             text,
  body_text           text,
  body_html           text,
  has_attachments     boolean not null default false,
  sent_at             timestamptz not null,
  visibility          text not null default 'team' check (visibility in ('team', 'private')),
  matched_contact_ids uuid[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (account_id, provider_message_id)
);
create index if not exists email_messages_internet_id_idx on public.email_messages(workspace_id, internet_message_id);
create index if not exists email_messages_sent_idx on public.email_messages(workspace_id, sent_at desc);
create index if not exists email_messages_contacts_idx on public.email_messages using gin (matched_contact_ids);
create index if not exists email_messages_thread_idx on public.email_messages(account_id, provider_thread_id);

-- Every send/reply request, keyed by a client-generated id so a double click
-- or a retried request can never send the same email twice.
create table if not exists public.email_sends (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  account_id             uuid references public.email_accounts(id) on delete set null,
  user_id                uuid not null references public.profiles(id) on delete cascade,
  client_request_id      uuid not null,
  contact_id             uuid references public.contacts(id) on delete set null,
  in_reply_to_message_id uuid references public.email_messages(id) on delete set null,
  to_addresses           jsonb not null default '[]'::jsonb,
  cc_addresses           jsonb not null default '[]'::jsonb,
  subject                text,
  body_text              text,
  status                 text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider_message_id    text,
  email_message_id       uuid references public.email_messages(id) on delete set null,
  error                  text,
  created_at             timestamptz not null default now(),
  sent_at                timestamptz,
  unique (user_id, client_request_id)
);

-- ---------------------------------------------------------------------------
-- Calls (Twilio). provider_call_sid is the parent call; webhooks are matched
-- on it, so a retried webhook updates the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.calls (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces(id) on delete cascade,
  provider                   text not null default 'twilio',
  provider_call_sid          text unique,
  provider_child_call_sid    text,
  direction                  text not null check (direction in ('outbound', 'inbound')),
  status                     text not null default 'initiated'
                             check (status in ('initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')),
  from_number                text,
  to_number                  text,
  user_id                    uuid references public.profiles(id) on delete set null,
  contact_id                 uuid references public.contacts(id) on delete set null,
  task_id                    uuid references public.tasks(id) on delete set null,
  deal_id                    uuid references public.deals(id) on delete set null,
  started_at                 timestamptz not null default now(),
  answered_at                timestamptz,
  ended_at                   timestamptz,
  duration_seconds           integer check (duration_seconds >= 0),
  disposition                text check (disposition in ('connected', 'left_voicemail', 'no_answer', 'busy', 'wrong_number',
                                                         'not_interested', 'callback_requested', 'other')),
  notes                      text check (char_length(notes) <= 20000),
  disposition_by             uuid references public.profiles(id) on delete set null,
  disposition_at             timestamptz,
  is_voicemail               boolean not null default false,
  recording_enabled          boolean not null default false,
  recording_sid              text,
  recording_status           text check (recording_status in ('in-progress', 'completed', 'absent', 'failed', 'available', 'deleted')),
  recording_duration_seconds integer,
  recording_storage_path     text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index if not exists calls_workspace_time_idx on public.calls(workspace_id, started_at desc);
create index if not exists calls_contact_idx on public.calls(contact_id);
create index if not exists calls_user_idx on public.calls(user_id);

alter table public.activities drop constraint if exists activities_email_message_fk;
alter table public.activities add constraint activities_email_message_fk
  foreign key (email_message_id) references public.email_messages(id) on delete set null;
alter table public.activities drop constraint if exists activities_call_fk;
alter table public.activities add constraint activities_call_fk
  foreign key (call_id) references public.calls(id) on delete set null;
create index if not exists activities_email_message_idx on public.activities(email_message_id);
create index if not exists activities_call_idx on public.activities(call_id);

-- ---------------------------------------------------------------------------
-- Personal preferences (notifications and calling). No row = the defaults.
-- ---------------------------------------------------------------------------
create table if not exists public.user_preferences (
  user_id                uuid primary key references public.profiles(id) on delete cascade,
  notify_task_assigned   boolean not null default true,
  notify_task_reminders  boolean not null default true,
  notify_task_overdue    boolean not null default true,
  notify_daily_digest    boolean not null default false,
  digest_hour            smallint not null default 8 check (digest_hour between 0 and 23),
  timezone               text check (timezone is null or char_length(timezone) <= 64),
  calls_receive_inbound  boolean not null default true,
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Background jobs (notification emails, mailbox backfills, recording copies).
-- dedupe_key makes enqueueing idempotent: the same notification can only ever
-- be queued once. Workers claim jobs with claim_jobs() (SKIP LOCKED + lease),
-- so overlapping scheduler runs never process a job twice at the same time.
-- ---------------------------------------------------------------------------
create table if not exists public.job_queue (
  id           bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  dedupe_key   text unique,
  status       text not null default 'pending' check (status in ('pending', 'running', 'retry', 'done', 'dead', 'skipped')),
  attempts     integer not null default 0,
  max_attempts integer not null default 6,
  run_after    timestamptz not null default now(),
  locked_until timestamptz,
  last_error   text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists job_queue_ready_idx on public.job_queue(run_after) where status in ('pending', 'retry', 'running');
create index if not exists job_queue_kind_idx on public.job_queue(kind, status);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['email_accounts', 'email_messages', 'calls', 'user_preferences', 'job_queue', 'email_account_tokens'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.email_accounts       enable row level security;
alter table public.email_account_tokens enable row level security;
alter table public.oauth_states         enable row level security;
alter table public.email_messages       enable row level security;
alter table public.email_sends          enable row level security;
alter table public.calls                enable row level security;
alter table public.user_preferences     enable row level security;
alter table public.job_queue            enable row level security;

-- No client role may ever read tokens, OAuth state or the job queue.
revoke all on public.email_account_tokens from anon, authenticated;
revoke all on public.oauth_states from anon, authenticated;
revoke all on public.job_queue from anon, authenticated;

-- Mailboxes: you see your own; the CRM owner sees everyone's connection status.
drop policy if exists email_accounts_read on public.email_accounts;
create policy email_accounts_read on public.email_accounts for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_owner(workspace_id));
revoke insert, update, delete on public.email_accounts from anon, authenticated;

-- Emails: team emails for members; private emails only for the mailbox owner.
drop policy if exists email_messages_read on public.email_messages;
create policy email_messages_read on public.email_messages for select to authenticated
  using (public.is_workspace_member(workspace_id) and (visibility = 'team' or owner_user_id = auth.uid()));
revoke insert, update, delete on public.email_messages from anon, authenticated;

drop policy if exists email_sends_read on public.email_sends;
create policy email_sends_read on public.email_sends for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.email_sends from anon, authenticated;

drop policy if exists calls_read on public.calls;
create policy calls_read on public.calls for select to authenticated using (public.crm_can_read(workspace_id));
revoke insert, update, delete on public.calls from anon, authenticated;

drop policy if exists user_preferences_own on public.user_preferences;
create policy user_preferences_own on public.user_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Functions the app calls
-- ---------------------------------------------------------------------------

-- Share a mailbox's emails with the team, keep them private, or pause syncing.
-- Changing sharing applies to every email already synced from that mailbox.
create or replace function public.update_email_account_settings(p_account uuid, p_sharing text default null, p_sync_enabled boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare acc public.email_accounts;
begin
  select * into acc from public.email_accounts where id = p_account;
  if acc.id is null or acc.user_id <> auth.uid() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_sharing is not null and p_sharing not in ('team', 'private') then raise exception 'Invalid sharing' using errcode = '22023'; end if;
  update public.email_accounts
     set sharing = coalesce(p_sharing, sharing),
         sync_enabled = coalesce(p_sync_enabled, sync_enabled),
         next_sync_at = case when p_sync_enabled then now() else next_sync_at end
   where id = p_account;
  if p_sharing is not null and p_sharing <> acc.sharing then
    update public.email_messages set visibility = p_sharing where account_id = p_account and visibility <> p_sharing;
  end if;
end;
$$;

-- Make one email private (or share it again). Only the mailbox owner can.
create or replace function public.set_email_visibility(p_message uuid, p_visibility text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_visibility not in ('team', 'private') then raise exception 'Invalid visibility' using errcode = '22023'; end if;
  update public.email_messages set visibility = p_visibility
   where id = p_message and owner_user_id = auth.uid();
  if not found then raise exception 'Not allowed' using errcode = '42501'; end if;
end;
$$;

-- After a call: outcome and notes. The person on the call, or the owner, can
-- set them; for calls nobody answered any editor can.
create or replace function public.set_call_disposition(p_call uuid, p_disposition text, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.calls;
begin
  select * into c from public.calls where id = p_call;
  if c.id is null or not public.crm_can_write(c.workspace_id)
     or not (c.user_id = auth.uid() or c.user_id is null or public.is_workspace_owner(c.workspace_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update public.calls
     set disposition = nullif(p_disposition, ''),
         notes = left(nullif(btrim(coalesce(p_notes, '')), ''), 20000),
         disposition_by = auth.uid(),
         disposition_at = now()
   where id = p_call;
end;
$$;

-- Who may listen to a call recording:
--   settings.recordingAccess = 'owner'   the owner, and the person on the call
--                            = 'editors' (default) owners and editors
--                            = 'all'     every member, viewers included
create or replace function public.can_play_recording(p_call uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  c public.calls;
  role_name text;
  access text;
begin
  select * into c from public.calls where id = p_call;
  if c.id is null then return false; end if;
  role_name := public.workspace_role(c.workspace_id);
  if role_name is null then return false; end if;
  select coalesce(settings->>'recordingAccess', 'editors') into access from public.workspaces where id = c.workspace_id;
  return case access
    when 'all' then true
    when 'owner' then role_name = 'owner' or c.user_id = auth.uid()
    else role_name in ('owner', 'editor')
  end;
end;
$$;

revoke execute on function public.update_email_account_settings(uuid, text, boolean) from public, anon;
revoke execute on function public.set_email_visibility(uuid, text) from public, anon;
revoke execute on function public.set_call_disposition(uuid, text, text) from public, anon;
revoke execute on function public.can_play_recording(uuid) from public, anon;
grant execute on function public.update_email_account_settings(uuid, text, boolean) to authenticated;
grant execute on function public.set_email_visibility(uuid, text) to authenticated;
grant execute on function public.set_call_disposition(uuid, text, text) to authenticated;
grant execute on function public.can_play_recording(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Job queue and mailbox sync scheduling (server only)
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_job(p_kind text, p_payload jsonb, p_dedupe_key text default null,
                                              p_run_after timestamptz default now(), p_workspace uuid default null,
                                              p_max_attempts integer default 6)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  insert into public.job_queue (kind, payload, dedupe_key, run_after, workspace_id, max_attempts)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, coalesce(p_run_after, now()), p_workspace, coalesce(p_max_attempts, 6))
  on conflict (dedupe_key) do nothing
  returning id into new_id;
  return new_id;  -- null when an identical job was already queued
end;
$$;

-- Claims up to p_limit ready jobs of the given kinds for p_lease_seconds.
-- A job whose lease ran out (a worker crashed) becomes claimable again.
create or replace function public.claim_jobs(p_kinds text[], p_limit integer, p_lease_seconds integer)
returns setof public.job_queue language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.job_queue j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
         updated_at = now()
   where j.id in (
     select q.id from public.job_queue q
      where q.kind = any(p_kinds)
        and q.attempts < q.max_attempts
        and q.run_after <= now()
        and (q.status in ('pending', 'retry') or (q.status = 'running' and q.locked_until < now()))
      order by q.run_after
      limit greatest(p_limit, 0)
      for update skip locked)
  returning j.*;
end;
$$;

-- Jobs that ran out of attempts while running are marked dead.
create or replace function public.reap_dead_jobs()
returns integer language sql security definer set search_path = public as $$
  with d as (
    update public.job_queue set status = 'dead', finished_at = now(), locked_until = null
     where status in ('running', 'retry') and attempts >= max_attempts
       and (locked_until is null or locked_until < now())
    returning 1)
  select count(*)::integer from d;
$$;

-- Claims mailboxes that are due for a sync. Only mailboxes of people who can
-- still edit the CRM are synced.
create or replace function public.claim_email_accounts(p_limit integer, p_lease_seconds integer)
returns setof public.email_accounts language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.email_accounts a
     set sync_lock_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         last_sync_started_at = now()
   where a.id in (
     select e.id from public.email_accounts e
      join public.workspace_members m on m.workspace_id = e.workspace_id and m.user_id = e.user_id and m.role in ('owner', 'editor')
      where e.status = 'active' and e.sync_enabled
        and e.next_sync_at <= now()
        and (e.sync_lock_until is null or e.sync_lock_until < now())
      order by e.next_sync_at
      limit greatest(p_limit, 0)
      for update of e skip locked)
  returning a.*;
end;
$$;

revoke execute on function public.enqueue_job(text, jsonb, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.claim_jobs(text[], integer, integer) from public, anon, authenticated;
revoke execute on function public.reap_dead_jobs() from public, anon, authenticated;
revoke execute on function public.claim_email_accounts(integer, integer) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, jsonb, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.claim_jobs(text[], integer, integer) to service_role;
grant execute on function public.reap_dead_jobs() to service_role;
grant execute on function public.claim_email_accounts(integer, integer) to service_role;

-- Someone leaving the CRM: their mailboxes stop syncing and the tokens are
-- destroyed. Emails they already shared stay on the leads' timelines.
create or replace function public.on_member_removed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.email_account_tokens
   where account_id in (select id from public.email_accounts where workspace_id = old.workspace_id and user_id = old.user_id);
  update public.email_accounts set status = 'disconnected', sync_enabled = false, sync_lock_until = null
   where workspace_id = old.workspace_id and user_id = old.user_id;
  return old;
end;
$$;
drop trigger if exists after_member_delete on public.workspace_members;
create trigger after_member_delete after delete on public.workspace_members
  for each row execute function public.on_member_removed();

-- ---------------------------------------------------------------------------
-- Private storage for call recordings. Never public: the server hands out
-- short-lived signed links after checking can_play_recording().
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('call-recordings', 'call-recordings', false, 52428800, array['audio/mpeg', 'audio/wav', 'audio/x-wav'])
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime for the dialer (call status) and the mailbox settings screen.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['calls', 'email_accounts'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
