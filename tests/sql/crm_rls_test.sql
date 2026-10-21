-- CRM records and integration data: row level security, grants and the
-- functions the app calls. Each block raises an exception on failure.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
end $$;
-- Runs sql and requires "permission denied" / an RLS refusal (42501).
create or replace function pg_temp.denied(sql text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when insufficient_privilege then return;
  end;
  raise exception 'expected permission denied for: %', sql;
end $$;
create or replace function pg_temp.n(sql text) returns bigint language plpgsql as $$
declare c bigint;
begin
  execute 'select count(*) from (' || sql || ') q' into c;
  return c;
end $$;

-- People: owner (first sign-up), editor, second editor, viewer, outsider.
insert into auth.users (id, email, email_confirmed_at) values
  ('10000000-0000-0000-0000-000000000001', 'owner@t.co', now()),
  ('10000000-0000-0000-0000-000000000002', 'editor@t.co', now()),
  ('10000000-0000-0000-0000-000000000005', 'editor2@t.co', now()),
  ('10000000-0000-0000-0000-000000000003', 'viewer@t.co', now()),
  ('10000000-0000-0000-0000-000000000004', 'outsider@t.co', now());
select id as crm from public.workspaces \gset
insert into public.workspace_members (workspace_id, user_id, role) values
  (:'crm', '10000000-0000-0000-0000-000000000002', 'editor'),
  (:'crm', '10000000-0000-0000-0000-000000000005', 'editor'),
  (:'crm', '10000000-0000-0000-0000-000000000003', 'viewer');
do $$ begin
  assert (select role from public.workspace_members where user_id = '10000000-0000-0000-0000-000000000001') = 'owner', 'first account owns the CRM';
end $$;

-- ---------------------------------------------------------------------------
-- An editor creates records. Bookkeeping fields can't be forged.
-- ---------------------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
insert into public.companies (id, workspace_id, name, created_by) values
  ('20000000-0000-0000-0000-0000000000c1', :'crm', 'Acme', '10000000-0000-0000-0000-000000000001');
insert into public.contacts (id, workspace_id, first_name, email, phone, company_id) values
  ('20000000-0000-0000-0000-0000000000a1', :'crm', 'Lea', ' Lea@Acme.COM ', '+1 (415) 555-0143', '20000000-0000-0000-0000-0000000000c1');
insert into public.deals (id, workspace_id, title, value, contact_id, company_id) values
  ('20000000-0000-0000-0000-0000000000d1', :'crm', 'Rebrand', 1000, '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000c1');
insert into public.tasks (id, workspace_id, title, assigned_to, deal_id, assignment_version, assigned_by) values
  ('20000000-0000-0000-0000-0000000000b1', :'crm', 'Call Lea', '10000000-0000-0000-0000-000000000003',
   '20000000-0000-0000-0000-0000000000d1', 99, '10000000-0000-0000-0000-000000000001');
insert into public.activities (id, workspace_id, type, subject, contact_id, actor_id) values
  ('20000000-0000-0000-0000-0000000000e1', :'crm', 'note', 'Team note', '20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001');
insert into public.activities (id, workspace_id, type, subject, contact_id, visibility, owner_user_id) values
  ('20000000-0000-0000-0000-0000000000e2', :'crm', 'note', 'Editor private', '20000000-0000-0000-0000-0000000000a1', 'private', '10000000-0000-0000-0000-000000000002');
update public.contacts set workspace_id = gen_random_uuid() where id = '20000000-0000-0000-0000-0000000000a1';
reset role;
do $$ begin
  assert (select created_by from public.companies where name = 'Acme') = '10000000-0000-0000-0000-000000000002', 'created_by is the real author';
  assert (select email_normalized from public.contacts where first_name = 'Lea') = 'lea@acme.com', 'email normalized for matching';
  assert (select phone_digits from public.contacts where first_name = 'Lea') = '14155550143', 'phone digits for call matching';
  assert (select assignment_version from public.tasks where title = 'Call Lea') = 1, 'assignment version cannot be forged';
  assert (select assigned_by from public.tasks where title = 'Call Lea') = '10000000-0000-0000-0000-000000000002', 'assigned_by is the real assigner';
  assert (select actor_id from public.activities where subject = 'Team note') = '10000000-0000-0000-0000-000000000002', 'activity actor is the real author';
  assert (select workspace_id from public.contacts where first_name = 'Lea') = (select id from public.workspaces), 'records cannot move workspace';
  assert exists (select 1 from public.activities where source = 'task' and event = 'created'), 'task creation is on the timeline';
end $$;

-- ---------------------------------------------------------------------------
-- The app can't forge timeline entries that only the system writes.
-- ---------------------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
select pg_temp.denied($q$insert into public.activities (workspace_id, type, source, subject) values ((select id from public.workspaces), 'email', 'email', 'fake email')$q$);
select pg_temp.denied($q$insert into public.activities (workspace_id, type, subject, dedupe_key) values ((select id from public.workspaces), 'note', 'x', 'email:<x>')$q$);
select pg_temp.denied($q$insert into public.activities (workspace_id, type, subject, task_id) values ((select id from public.workspaces), 'note', 'x', '20000000-0000-0000-0000-0000000000b1')$q$);
select pg_temp.denied($q$insert into public.activities (workspace_id, type, subject, visibility, owner_user_id) values ((select id from public.workspaces), 'note', 'x', 'private', '10000000-0000-0000-0000-000000000001')$q$);
update public.activities set subject = 'tampered' where source = 'task';
delete from public.activities where source = 'task';
select pg_temp.denied($q$update public.activities set source = 'email' where subject = 'Team note'$q$);
reset role;
do $$ begin
  assert exists (select 1 from public.activities where source = 'task') and not exists (select 1 from public.activities where subject = 'tampered'), 'system timeline entries are read-only';
  assert (select source from public.activities where subject = 'Team note') = 'manual', 'manual entries stay manual';
end $$;

-- ---------------------------------------------------------------------------
-- Private activities: only their owner sees them (not even the CRM owner).
-- ---------------------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
do $$ begin
  assert pg_temp.n($q$select 1 from public.activities where subject = 'Editor private'$q$) = 0, 'owner cannot see an editor''s private note';
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1') where subject = 'Editor private'$q$) = 0, 'nor through the timeline';
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1') where subject = 'Team note'$q$) = 1, 'owner sees team notes on the timeline';
end $$;
update public.activities set subject = 'owner edit' where subject = 'Editor private';
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
do $$ begin
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1') where subject = 'Editor private'$q$) = 1, 'the author sees their private note';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.activities where subject = 'Editor private'), 'others cannot edit a private note';
end $$;

-- Only a note's author (or the owner) can change or delete it.
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
update public.activities set subject = 'rewritten by someone else' where subject = 'Team note';
delete from public.activities where subject = 'Team note';
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
update public.activities set body = 'owner tidy-up' where subject = 'Team note';
reset role;
do $$ begin
  assert (select subject from public.activities where id = '20000000-0000-0000-0000-0000000000e1') = 'Team note', 'another editor cannot rewrite or delete a note';
  assert (select body from public.activities where id = '20000000-0000-0000-0000-0000000000e1') = 'owner tidy-up', 'the owner can';
end $$;

-- ---------------------------------------------------------------------------
-- Viewers read; outsiders see nothing.
-- ---------------------------------------------------------------------------
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  assert pg_temp.n('select 1 from public.contacts') = 1 and pg_temp.n('select 1 from public.deals') = 1 and pg_temp.n('select 1 from public.tasks') = 1, 'viewer reads records';
end $$;
select pg_temp.denied($q$insert into public.contacts (workspace_id, first_name) values ((select id from public.workspaces), 'v')$q$);
select pg_temp.denied($q$insert into public.activities (workspace_id, type, subject) values ((select id from public.workspaces), 'note', 'v')$q$);
update public.contacts set first_name = 'viewer edit';
update public.tasks set status = 'done';
delete from public.deals;
select pg_temp.act_as('10000000-0000-0000-0000-000000000004');
do $$ begin
  assert pg_temp.n('select 1 from public.companies') + pg_temp.n('select 1 from public.contacts') + pg_temp.n('select 1 from public.deals')
       + pg_temp.n('select 1 from public.tasks') + pg_temp.n('select 1 from public.activities') = 0, 'outsider sees no records';
  assert pg_temp.n($q$select 1 from public.get_timeline('workspace', null)$q$) = 0, 'outsider gets an empty timeline';
end $$;
select pg_temp.denied($q$insert into public.contacts (workspace_id, first_name) values ('00000000-0000-0000-0000-000000000000', 'x')$q$);
reset role;
do $$ begin
  assert (select first_name from public.contacts where id = '20000000-0000-0000-0000-0000000000a1') = 'Lea', 'viewer could not edit';
  assert (select status from public.tasks where title = 'Call Lea') = 'todo' and (select count(*) from public.deals) = 1, 'viewer could not change or delete';
end $$;

-- Browser roles have no table privileges beyond what the app uses.
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
select pg_temp.denied('truncate public.contacts');
select pg_temp.denied('select * from public.email_account_tokens');
select pg_temp.denied('select * from public.oauth_states');
select pg_temp.denied('select * from public.job_queue');
select pg_temp.denied($q$insert into public.email_accounts (workspace_id, user_id, provider, email_address) values ((select id from public.workspaces), auth.uid(), 'google', 'x@y.z')$q$);
select pg_temp.denied($q$insert into public.calls (workspace_id, direction) values ((select id from public.workspaces), 'outbound')$q$);
select pg_temp.denied($q$select public.enqueue_job('x', '{}'::jsonb)$q$);
select pg_temp.denied($q$select * from public.claim_jobs(array['x'], 1, 10)$q$);
select pg_temp.denied($q$select * from public.claim_email_accounts(1, 10)$q$);
select pg_temp.denied($q$select public.configure_cron('https://x.y', 'secretsecretsecretsecret12')$q$);
select pg_temp.denied($q$select public.scheduler_status()$q$);
select pg_temp.denied($q$select public.crm_cron_tick()$q$);
reset role;
set role anon;
select pg_temp.act_as(null);
select pg_temp.denied('select * from public.companies');
select pg_temp.denied('select * from public.calls');
select pg_temp.denied($q$select * from public.get_timeline('workspace', null)$q$);
reset role;

-- ---------------------------------------------------------------------------
-- Mailboxes and emails
-- ---------------------------------------------------------------------------
insert into public.email_accounts (id, workspace_id, user_id, provider, email_address, sharing) values
  ('30000000-0000-0000-0000-0000000000a1', :'crm', '10000000-0000-0000-0000-000000000002', 'google', 'editor@t.co', 'team'),
  ('30000000-0000-0000-0000-0000000000a2', :'crm', '10000000-0000-0000-0000-000000000005', 'microsoft', 'editor2@t.co', 'private');
insert into public.email_account_tokens (account_id, refresh_token_enc) values
  ('30000000-0000-0000-0000-0000000000a1', 'v1.x'), ('30000000-0000-0000-0000-0000000000a2', 'v1.y');
insert into public.email_messages (id, workspace_id, account_id, owner_user_id, provider, provider_message_id, internet_message_id,
                                   direction, from_address, to_addresses, subject, snippet, sent_at, visibility, matched_contact_ids) values
  ('31000000-0000-0000-0000-0000000000e1', :'crm', '30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002', 'google', 'g1', '<team@x>',
   'inbound', 'lea@acme.com', '[{"email":"editor@t.co"}]', 'Team email', 'hello', now() - interval '1 hour', 'team', array['20000000-0000-0000-0000-0000000000a1']::uuid[]),
  ('31000000-0000-0000-0000-0000000000e2', :'crm', '30000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000005', 'microsoft', 'm1', '<private@x>',
   'inbound', 'lea@acme.com', '[{"email":"editor2@t.co"}]', 'Private email', 'secret', now() - interval '2 hours', 'private', array['20000000-0000-0000-0000-0000000000a1']::uuid[]);

set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
do $$ begin
  assert pg_temp.n('select 1 from public.email_accounts') = 1, 'editor sees only their own mailbox';
  assert pg_temp.n('select 1 from public.email_messages') = 1, 'editor sees team emails, not someone else''s private one';
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1', null, null, 50, '{email}')$q$) = 1, 'editor''s timeline shows one email';
end $$;
select pg_temp.denied($q$select public.set_email_visibility('31000000-0000-0000-0000-0000000000e2', 'team')$q$);
select pg_temp.denied('select sync_cursor from public.email_accounts');
do $$ begin assert pg_temp.n('select id, status, last_synced_at from public.email_accounts') = 1, 'status columns stay readable'; end $$;
select pg_temp.denied($q$select public.update_email_account_settings('30000000-0000-0000-0000-0000000000a2', 'team', null)$q$);
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
do $$ begin
  assert pg_temp.n('select 1 from public.email_messages') = 2, 'mailbox owner sees their private email too';
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1', null, null, 50, '{email}')$q$) = 2, 'and it is on their timeline';
end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
do $$ begin
  assert pg_temp.n('select 1 from public.email_accounts') = 1, 'the CRM owner sees shared mailboxes'' status, not private ones';
  assert pg_temp.n('select 1 from public.email_messages') = 1, 'but not other people''s private emails';
end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  assert pg_temp.n('select 1 from public.email_accounts') = 0 and pg_temp.n('select 1 from public.email_messages') = 1, 'viewer sees team emails only';
end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000004');
do $$ begin
  assert pg_temp.n('select 1 from public.email_accounts') + pg_temp.n('select 1 from public.email_messages') = 0, 'outsider sees no email data';
end $$;
-- The mailbox owner shares their mailbox: every email from it becomes visible to the team.
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
select public.update_email_account_settings('30000000-0000-0000-0000-0000000000a2', 'team', null);
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  assert pg_temp.n('select 1 from public.email_messages') = 2, 'shared mailbox emails reach the team';
  assert pg_temp.n($q$select 1 from public.get_timeline('contact', '20000000-0000-0000-0000-0000000000a1', null, null, 50, '{email}') where visibility = 'team'$q$) = 2, 'as team timeline entries';
end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
select public.set_email_visibility('31000000-0000-0000-0000-0000000000e2', 'private');
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  assert pg_temp.n('select 1 from public.email_messages') = 1, 'one email made private again';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Calls: outcome and recordings
-- ---------------------------------------------------------------------------
insert into public.calls (id, workspace_id, provider_call_sid, direction, status, user_id, contact_id, recording_status) values
  ('40000000-0000-0000-0000-0000000000a1', :'crm', 'CA1', 'outbound', 'completed', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a1', 'available'),
  ('40000000-0000-0000-0000-0000000000a2', :'crm', 'CA2', 'inbound', 'no-answer', null, null, null);
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  assert pg_temp.n('select 1 from public.calls') = 2, 'viewer sees calls';
  assert not public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'viewers cannot play recordings by default';
end $$;
select pg_temp.denied($q$select public.set_call_disposition('40000000-0000-0000-0000-0000000000a1', 'connected', 'x')$q$);
select pg_temp.act_as('10000000-0000-0000-0000-000000000004');
select pg_temp.denied($q$select public.set_call_disposition('40000000-0000-0000-0000-0000000000a2', 'connected', 'x')$q$);
do $$ begin
  assert not public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'outsiders never play recordings';
end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
select pg_temp.denied($q$select public.set_call_disposition('40000000-0000-0000-0000-0000000000a1', 'connected', 'x')$q$);
select public.set_call_disposition('40000000-0000-0000-0000-0000000000a2', 'no_answer', 'nobody there');
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
select public.set_call_disposition('40000000-0000-0000-0000-0000000000a1', 'connected', '  Booked a demo  ');
do $$ begin
  assert public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'editors play recordings by default';
end $$;
reset role;
do $$ begin
  assert (select disposition from public.calls where provider_call_sid = 'CA1') = 'connected', 'outcome saved';
  assert (select notes from public.calls where provider_call_sid = 'CA1') = 'Booked a demo', 'notes trimmed and saved';
  assert (select disposition_by from public.calls where provider_call_sid = 'CA1') = '10000000-0000-0000-0000-000000000002', 'who set the outcome is recorded';
  assert (select body from public.activities where call_id = '40000000-0000-0000-0000-0000000000a1') = 'Booked a demo', 'call notes reach the timeline';
end $$;
update public.workspaces set settings = settings || '{"recordingAccess":"owner"}';
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
do $$ begin assert not public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'owner-only: other editors cannot play'; end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
do $$ begin assert public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'owner-only: the person on the call can'; end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
do $$ begin assert public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'owner-only: the owner can'; end $$;
reset role;
update public.workspaces set settings = settings || '{"recordingAccess":"all"}';
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin assert public.can_play_recording('40000000-0000-0000-0000-0000000000a1'), 'everyone: viewers can'; end $$;
reset role;
update public.workspaces set settings = settings - 'recordingAccess';

-- ---------------------------------------------------------------------------
-- Workspace settings and personal preferences
-- ---------------------------------------------------------------------------
update public.workspaces set settings = settings - 'timezone';
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
select pg_temp.denied($q$select public.ensure_workspace_timezone((select id from public.workspaces), 'Europe/London')$q$);
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
select public.ensure_workspace_timezone(:'crm', 'Europe/London');
select public.ensure_workspace_timezone(:'crm', 'Asia/Dubai');
do $$ begin
  begin
    perform public.ensure_workspace_timezone((select id from public.workspaces), 'Mars/Olympus');
    raise exception 'unknown time zone accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
update public.workspaces set settings = '{"currency":"EUR"}';
insert into public.user_preferences (user_id, notify_daily_digest, digest_hour) values (auth.uid(), true, 7);
select pg_temp.denied($q$insert into public.user_preferences (user_id) values ('10000000-0000-0000-0000-000000000003')$q$);
do $$ begin assert pg_temp.n('select 1 from public.user_preferences') = 1, 'people see only their own preferences'; end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
update public.workspaces set settings = settings || '{"currency":"AED"}';
reset role;
do $$ begin
  assert (select settings->>'timezone' from public.workspaces) = 'Europe/London', 'editors record the time zone once, never overwrite it';
  assert (select settings->>'currency' from public.workspaces) = 'AED', 'only the owner changes settings';
end $$;

-- ---------------------------------------------------------------------------
-- Removing someone destroys their mailbox tokens and stops syncing.
-- ---------------------------------------------------------------------------
delete from public.workspace_members where user_id = '10000000-0000-0000-0000-000000000005';
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000005');
select pg_temp.denied($q$select public.update_email_account_settings('30000000-0000-0000-0000-0000000000a2', 'private', null)$q$);
select pg_temp.denied($q$select public.set_email_visibility('31000000-0000-0000-0000-0000000000e2', 'team')$q$);
reset role;
do $$ begin
  assert (select status from public.email_accounts where id = '30000000-0000-0000-0000-0000000000a2') = 'disconnected', 'mailbox disconnected';
  assert not (select sync_enabled from public.email_accounts where id = '30000000-0000-0000-0000-0000000000a2'), 'sync off';
  assert not exists (select 1 from public.email_account_tokens where account_id = '30000000-0000-0000-0000-0000000000a2'), 'tokens destroyed';
  assert exists (select 1 from public.email_account_tokens where account_id = '30000000-0000-0000-0000-0000000000a1'), 'other mailboxes untouched';
end $$;
insert into public.workspace_members (workspace_id, user_id, role) values (:'crm', '10000000-0000-0000-0000-000000000005', 'editor');

-- Profile photos must be embedded images; names are bounded.
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
do $$ begin
  begin
    update public.profiles set avatar_data = 'https://attacker.example/pixel.gif' where id = auth.uid();
    raise exception 'a remote avatar URL was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set display_name = repeat('x', 101) where id = auth.uid();
    raise exception 'an over-long name was accepted';
  exception when check_violation then null;
  end;
end $$;
update public.profiles set avatar_data = 'data:image/png;base64,iVBORw0KGgo=', display_name = 'Vic' where id = auth.uid();
reset role;

-- Deleting a lead deletes the notes that only belonged to it.
insert into public.contacts (id, workspace_id, first_name) values ('20000000-0000-0000-0000-0000000000a9', :'crm', 'Gone');
insert into public.activities (workspace_id, type, subject, contact_id) values (:'crm', 'note', 'Note on a lead about to go', '20000000-0000-0000-0000-0000000000a9');
delete from public.contacts where id = '20000000-0000-0000-0000-0000000000a9';
do $$ begin
  assert not exists (select 1 from public.activities where subject = 'Note on a lead about to go'), 'a deleted lead takes its own notes with it';
end $$;

-- Invites for people who already have a login: the owner can list them, nobody
-- can read the token hashes or write invites or memberships directly.
insert into public.workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
  values (:'crm', 'newbie@t.co', 'editor', 'deadbeef', '10000000-0000-0000-0000-000000000001', now() + interval '7 days');
set role authenticated;
select pg_temp.act_as('10000000-0000-0000-0000-000000000001');
do $$ begin
  assert pg_temp.n('select id, email, role, expires_at, accepted_at from public.workspace_invites') = 1, 'the owner sees pending invites';
end $$;
select pg_temp.denied('select token_hash from public.workspace_invites');
select pg_temp.denied($q$insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values ((select id from public.workspaces limit 1), 'x@y.z', 'editor', 'h', now())$q$);
select pg_temp.denied($q$update public.workspace_invites set accepted_at = now()$q$);
select pg_temp.denied('delete from public.workspace_invites');
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
do $$ begin assert pg_temp.n('select id from public.workspace_invites') = 0, 'editors don''t see invites'; end $$;
select pg_temp.act_as('10000000-0000-0000-0000-000000000004');
do $$ begin assert pg_temp.n('select id from public.workspace_invites') = 0, 'outsiders don''t see invites'; end $$;
select pg_temp.denied($q$insert into public.workspace_members (workspace_id, user_id, role) values ((select id from public.workspaces limit 1), auth.uid(), 'editor')$q$);
reset role;
set role anon;
select pg_temp.act_as(null);
select pg_temp.denied('select id from public.workspace_invites');
reset role;
delete from public.workspace_invites;

-- Clean up records for the next file (people stay).
delete from public.email_accounts; delete from public.calls; delete from public.activities; delete from public.tasks;
delete from public.deals; delete from public.contacts; delete from public.companies; delete from public.job_queue;
delete from public.user_preferences;
select 'crm_rls_test.sql passed' as result;
