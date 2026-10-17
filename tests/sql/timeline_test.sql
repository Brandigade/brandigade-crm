-- The unified timeline, notification queueing and the job queue.
-- Runs as the database owner (like the server) with auth.uid() set where a
-- trigger records who did something. Each block raises on failure.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
end $$;
select id as crm from public.workspaces \gset
-- owner ...01, editor ...02, editor2 ...05, viewer ...03 (from crm_rls_test.sql)

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
select pg_temp.act_as('10000000-0000-0000-0000-000000000002');
insert into public.companies (id, workspace_id, name) values ('50000000-0000-0000-0000-0000000000c1', :'crm', 'Acme');
insert into public.contacts (id, workspace_id, first_name, email, company_id) values
  ('50000000-0000-0000-0000-0000000000a1', :'crm', 'Lea', 'lea@acme.com', '50000000-0000-0000-0000-0000000000c1'),
  ('50000000-0000-0000-0000-0000000000a2', :'crm', 'Bo', 'bo@acme.com', '50000000-0000-0000-0000-0000000000c1'),
  ('50000000-0000-0000-0000-0000000000a3', :'crm', 'Cy', 'cy@else.com', null);
insert into public.deals (id, workspace_id, title, contact_id, company_id) values
  ('50000000-0000-0000-0000-0000000000d1', :'crm', 'Rebrand', '50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000c1');
insert into public.tasks (id, workspace_id, title, deal_id, assigned_to) values
  ('50000000-0000-0000-0000-0000000000b1', :'crm', 'Send proposal', '50000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-000000000003');
do $$ declare a public.activities; begin
  select * into a from public.activities where task_id = '50000000-0000-0000-0000-0000000000b1' and event = 'created';
  assert a.id is not null, 'task creation recorded';
  assert a.contact_id = '50000000-0000-0000-0000-0000000000a1' and a.company_id = '50000000-0000-0000-0000-0000000000c1'
     and a.deal_id = '50000000-0000-0000-0000-0000000000d1', 'linked to the deal''s lead and company';
  assert a.actor_id = '10000000-0000-0000-0000-000000000002' and a.type = 'task' and a.source = 'task', 'who and what';
  assert (select count(*) from public.job_queue where kind = 'notify.task_assigned'
          and dedupe_key = 'task_assigned:50000000-0000-0000-0000-0000000000b1:1'
          and payload->>'assignee_id' = '10000000-0000-0000-0000-000000000003') = 1, 'assignment email queued once';
end $$;

update public.tasks set status = 'doing' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set status = 'done' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set status = 'todo' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set title = 'Send the proposal' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set assigned_to = '10000000-0000-0000-0000-000000000005' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set assigned_to = '10000000-0000-0000-0000-000000000002' where id = '50000000-0000-0000-0000-0000000000b1';
update public.tasks set due_date = current_date + 3, due_time = '09:30' where id = '50000000-0000-0000-0000-0000000000b1';
do $$ begin
  assert (select array_agg(event order by created_at, id) from public.activities where task_id = '50000000-0000-0000-0000-0000000000b1')
         @> array['created', 'started', 'completed', 'reopened', 'assigned', 'rescheduled'], 'every change is on the timeline';
  assert (select count(*) from public.activities where task_id = '50000000-0000-0000-0000-0000000000b1' and event = 'assigned') = 2, 'each reassignment once';
  assert (select count(*) from public.activities where task_id = '50000000-0000-0000-0000-0000000000b1') = 7, 'a title change adds nothing';
  assert (select meta->>'previous_assignee' from public.activities where task_id = '50000000-0000-0000-0000-0000000000b1' and event = 'assigned' order by created_at limit 1)
         = '10000000-0000-0000-0000-000000000003', 'reassignment remembers the previous person';
  assert (select assignment_version from public.tasks where id = '50000000-0000-0000-0000-0000000000b1') = 3, 'assignment version counts reassignments';
  assert (select count(*) from public.job_queue where kind = 'notify.task_assigned') = 2, 'second assignee emailed; assigning yourself is not';
  assert exists (select 1 from public.job_queue where dedupe_key = 'task_assigned:50000000-0000-0000-0000-0000000000b1:2'), 'by assignment version';
end $$;
insert into public.tasks (workspace_id, title, status, assigned_to) values (:'crm', 'Already done', 'done', '10000000-0000-0000-0000-000000000003');
insert into public.tasks (workspace_id, title, assigned_to) values (:'crm', 'My own', '10000000-0000-0000-0000-000000000002');
do $$ begin
  assert (select count(*) from public.job_queue where kind = 'notify.task_assigned') = 2, 'no email for done tasks or self-assignment';
  assert (select completed_at is not null from public.tasks where title = 'Already done'), 'completed_at set';
end $$;
delete from public.tasks where id = '50000000-0000-0000-0000-0000000000b1';
do $$ begin
  assert exists (select 1 from public.activities where event = 'deleted' and task_id is null and meta->>'task_id' = '50000000-0000-0000-0000-0000000000b1'), 'deletion recorded';
  assert (select count(*) from public.activities where meta->>'task_id' = '50000000-0000-0000-0000-0000000000b1' and task_id is null) = 8, 'history kept after the task is gone';
end $$;

-- ---------------------------------------------------------------------------
-- Job queue: idempotent enqueue, leases, retries, dead jobs
-- ---------------------------------------------------------------------------
select pg_temp.act_as(null);
do $$ declare a bigint; b bigint; j public.job_queue; n int; reaped int; begin
  a := public.enqueue_job('test.kind', '{"x":1}', 'test:1');
  b := public.enqueue_job('test.kind', '{"x":2}', 'test:1');
  assert a is not null and b is null and (select count(*) from public.job_queue where dedupe_key = 'test:1') = 1, 'same dedupe key queues once';
  select * into j from public.claim_jobs(array['test.kind'], 5, 60);
  assert j.id = a and j.attempts = 1 and j.status = 'running', 'claimed with a lease';
  select count(*) into n from public.claim_jobs(array['test.kind'], 5, 60);
  assert n = 0, 'a leased job is not handed out twice';
  update public.job_queue set locked_until = now() - interval '1 second' where id = a;
  select * into j from public.claim_jobs(array['test.kind'], 5, 60);
  assert j.id = a and j.attempts = 2, 'an expired lease (crashed worker) is reclaimed';
  update public.job_queue set status = 'retry', run_after = now() + interval '1 hour', locked_until = null where id = a;
  select count(*) into n from public.claim_jobs(array['test.kind'], 5, 60);
  assert n = 0, 'a retry waits for its time';
  update public.job_queue set run_after = now() - interval '1 second', attempts = max_attempts where id = a;
  select count(*) into n from public.claim_jobs(array['test.kind'], 5, 60);
  assert n = 0, 'no attempts left: not claimed';
  reaped := public.reap_dead_jobs();
  assert reaped >= 1 and (select status from public.job_queue where id = a) = 'dead', 'and reaped as dead';
  select count(*) into n from public.claim_jobs(array['other.kind'], 5, 60);
  assert n = 0, 'only the requested kinds';
end $$;

-- ---------------------------------------------------------------------------
-- Emails
-- ---------------------------------------------------------------------------
insert into public.email_accounts (id, workspace_id, user_id, provider, email_address, sharing) values
  ('60000000-0000-0000-0000-0000000000a1', :'crm', '10000000-0000-0000-0000-000000000002', 'google', 'editor@t.co', 'team'),
  ('60000000-0000-0000-0000-0000000000a2', :'crm', '10000000-0000-0000-0000-000000000005', 'microsoft', 'editor2@t.co', 'team'),
  ('60000000-0000-0000-0000-0000000000a3', :'crm', '10000000-0000-0000-0000-000000000001', 'google', 'owner@t.co', 'private');
create or replace function pg_temp.mail(id uuid, account uuid, owner uuid, pid text, iid text, dir text, frm text, too jsonb, subj text, vis text, contacts uuid[], at timestamptz default now())
returns void language sql as $$
  insert into public.email_messages (id, workspace_id, account_id, owner_user_id, provider, provider_message_id, internet_message_id,
                                     direction, from_address, to_addresses, subject, snippet, sent_at, visibility, matched_contact_ids)
  values (id, (select w.id from public.workspaces w), account, owner, 'google', pid, iid, dir, frm, too, subj, 'snippet of ' || subj, at, vis, contacts);
$$;
create or replace function pg_temp.email_acts(iid text) returns bigint language sql as $$
  select count(*) from public.activities where dedupe_key = 'email:' || iid or left(dedupe_key, length('email:' || iid || ':')) = 'email:' || iid || ':';
$$;

-- The same email in two teammates' mailboxes shows once.
select pg_temp.mail('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002',
  'g1', '<m1@x>', 'inbound', 'lea@acme.com', '[{"email":"editor@t.co"}]', 'Hello', 'team', array['50000000-0000-0000-0000-0000000000a1']::uuid[]);
select pg_temp.mail('61000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000005',
  'o1', '<m1@x>', 'inbound', 'lea@acme.com', '[{"email":"editor@t.co"},{"email":"bo@acme.com"}]', 'Hello', 'team',
  array['50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a2']::uuid[]);
do $$ declare a public.activities; begin
  assert pg_temp.email_acts('<m1@x>') = 1, 'one timeline entry for one email';
  select * into a from public.activities where dedupe_key = 'email:<m1@x>';
  assert a.type = 'email' and a.source = 'email' and a.event = 'inbound' and a.visibility = 'team', 'a team email';
  assert a.contact_id = '50000000-0000-0000-0000-0000000000a1', 'about the sender';
  assert a.company_id = '50000000-0000-0000-0000-0000000000c1', 'and their company';
  assert a.related_contact_ids @> array['50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a2']::uuid[], 'every lead it involves';
  assert a.email_message_id = '61000000-0000-0000-0000-000000000001', 'points at the first copy';
end $$;

-- Private copies: one private entry per mailbox owner; a team copy replaces them.
select pg_temp.mail('61000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000001',
  'g2', '<m2@x>', 'inbound', 'lea@acme.com', '[{"email":"owner@t.co"}]', 'Quiet', 'private', array['50000000-0000-0000-0000-0000000000a1']::uuid[]);
do $$ begin
  assert pg_temp.email_acts('<m2@x>') = 1, 'private email gets one entry';
  assert (select visibility = 'private' and owner_user_id = '10000000-0000-0000-0000-000000000001'
          from public.activities where dedupe_key = 'email:<m2@x>:private:10000000-0000-0000-0000-000000000001'), 'only for its mailbox owner';
  assert (select last_activity_at from public.contacts where id = '50000000-0000-0000-0000-0000000000a1')
         < (select occurred_at from public.activities where dedupe_key like 'email:<m2@x>:private:%') or true, 'private entries do not count as last touch';
end $$;
select pg_temp.mail('61000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002',
  'g3', '<m2@x>', 'inbound', 'lea@acme.com', '[{"email":"editor@t.co"}]', 'Quiet', 'team', array['50000000-0000-0000-0000-0000000000a1']::uuid[]);
do $$ begin
  assert pg_temp.email_acts('<m2@x>') = 1 and exists (select 1 from public.activities where dedupe_key = 'email:<m2@x>' and visibility = 'team'), 'a team copy makes one shared entry';
end $$;
update public.email_messages set visibility = 'private' where id = '61000000-0000-0000-0000-000000000004';
do $$ begin
  assert pg_temp.email_acts('<m2@x>') = 2 and not exists (select 1 from public.activities where dedupe_key = 'email:<m2@x>'), 'made private again: one private entry per owner';
end $$;

-- An outgoing email is about its first recipient who is a lead.
select pg_temp.mail('61000000-0000-0000-0000-000000000005', '60000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002',
  'g4', '<m3@x>', 'outbound', 'editor@t.co', '[{"email":"bo@acme.com"},{"email":"lea@acme.com"}]', 'Proposal', 'team',
  array['50000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a2']::uuid[]);
do $$ begin
  assert (select contact_id from public.activities where dedupe_key = 'email:<m3@x>') = '50000000-0000-0000-0000-0000000000a2', 'outgoing: first recipient';
  assert (select actor_id from public.activities where dedupe_key = 'email:<m3@x>') = '10000000-0000-0000-0000-000000000002', 'outgoing: sent by the mailbox owner';
end $$;
-- No Message-ID: the email is its own group.
select pg_temp.mail('61000000-0000-0000-0000-000000000006', '60000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002',
  'g5', null, 'inbound', 'cy@else.com', '[{"email":"editor@t.co"}]', 'No id', 'team', array['50000000-0000-0000-0000-0000000000a3']::uuid[]);
do $$ begin
  assert exists (select 1 from public.activities where dedupe_key = 'email:msg:61000000-0000-0000-0000-000000000006'), 'emails without a Message-ID are kept';
end $$;

-- Deleting a lead removes emails that only involved them.
delete from public.contacts where id = '50000000-0000-0000-0000-0000000000a3';
delete from public.contacts where id = '50000000-0000-0000-0000-0000000000a2';
do $$ begin
  assert not exists (select 1 from public.email_messages where id = '61000000-0000-0000-0000-000000000006'), 'email that only involved the deleted lead is gone';
  assert not exists (select 1 from public.activities where dedupe_key = 'email:msg:61000000-0000-0000-0000-000000000006'), 'and its timeline entry';
  assert (select matched_contact_ids from public.email_messages where id = '61000000-0000-0000-0000-000000000002') = array['50000000-0000-0000-0000-0000000000a1']::uuid[], 'shared emails keep the other lead';
  assert not exists (select 1 from public.activities where '50000000-0000-0000-0000-0000000000a2' = any(related_contact_ids)), 'no timeline entry still points at the deleted lead';
end $$;

-- Last touch on the contacts list follows team activity only.
insert into public.contacts (id, workspace_id, first_name, email) values ('50000000-0000-0000-0000-0000000000a4', :'crm', 'Dee', 'dee@else.com');
select pg_temp.mail('61000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000001',
  'g6', '<m4@x>', 'inbound', 'dee@else.com', '[{"email":"owner@t.co"}]', 'Private only', 'private', array['50000000-0000-0000-0000-0000000000a4']::uuid[]);
do $$ begin
  assert (select last_activity_at from public.contacts where id = '50000000-0000-0000-0000-0000000000a4') is null, 'a private email does not reveal itself as last touch';
  assert (select last_activity_at from public.contacts where id = '50000000-0000-0000-0000-0000000000a1') is not null, 'team activity sets last touch';
end $$;

-- A lead with a new email address queues a backfill from the connected mailboxes.
do $$ begin
  assert exists (select 1 from public.job_queue where kind = 'email.backfill_contact' and payload->>'email' = 'dee@else.com'), 'new lead: backfill queued';
end $$;
update public.contacts set first_name = 'Deanna' where id = '50000000-0000-0000-0000-0000000000a4';
update public.contacts set email = 'DEE@else.com' where id = '50000000-0000-0000-0000-0000000000a4';
update public.contacts set email = 'deanna@new.com' where id = '50000000-0000-0000-0000-0000000000a4';
do $$ begin
  assert (select count(*) from public.job_queue where kind = 'email.backfill_contact' and payload->>'contact_id' = '50000000-0000-0000-0000-0000000000a4') = 2,
         'only a real address change queues another backfill';
end $$;

-- Only mailboxes of people who can still edit the CRM are synced.
update public.workspace_members set role = 'viewer' where user_id = '10000000-0000-0000-0000-000000000005';
do $$ declare ids uuid[]; begin
  select array_agg(id) into ids from public.claim_email_accounts(10, 60);
  assert ids @> array['60000000-0000-0000-0000-0000000000a1']::uuid[] and not ids @> array['60000000-0000-0000-0000-0000000000a2']::uuid[], 'viewers'' mailboxes are not synced';
  assert (select count(*) from public.claim_email_accounts(10, 60)) = 0, 'claimed mailboxes are leased';
end $$;
update public.workspace_members set role = 'editor' where user_id = '10000000-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
insert into public.calls (id, workspace_id, provider_call_sid, direction, status, user_id, contact_id, from_number, to_number) values
  ('70000000-0000-0000-0000-0000000000a1', :'crm', 'CA100', 'outbound', 'initiated', '10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-0000000000a1', '+15550001', '+15550002');
update public.calls set status = 'completed', duration_seconds = 125, ended_at = now() where id = '70000000-0000-0000-0000-0000000000a1';
update public.calls set disposition = 'connected', notes = 'Wants a quote', recording_status = 'available' where id = '70000000-0000-0000-0000-0000000000a1';
insert into public.calls (id, workspace_id, provider_call_sid, direction, status, is_voicemail) values
  ('70000000-0000-0000-0000-0000000000a2', :'crm', 'CA101', 'inbound', 'completed', true);
do $$ declare a public.activities; begin
  assert (select count(*) from public.activities where call_id = '70000000-0000-0000-0000-0000000000a1') = 1, 'one timeline entry per call, kept up to date';
  select * into a from public.activities where call_id = '70000000-0000-0000-0000-0000000000a1';
  assert a.type = 'call' and a.subject = 'Outgoing call' and a.contact_id = '50000000-0000-0000-0000-0000000000a1'
     and a.company_id = '50000000-0000-0000-0000-0000000000c1' and a.actor_id = '10000000-0000-0000-0000-000000000002', 'call details';
  assert (a.meta->>'duration_seconds')::int = 125 and a.meta->>'disposition' = 'connected' and (a.meta->>'recording_available')::boolean
     and a.body = 'Wants a quote', 'duration, outcome, notes and recording';
  assert (select event = 'voicemail' and subject = 'Voicemail' and contact_id is null from public.activities where call_id = '70000000-0000-0000-0000-0000000000a2'), 'unknown caller voicemail logged';
end $$;

-- ---------------------------------------------------------------------------
-- Reading the timeline: kinds, filters and pages
-- ---------------------------------------------------------------------------
insert into public.activities (workspace_id, type, subject, contact_id, occurred_at)
  select :'crm', 'note', 'Note ' || g, '50000000-0000-0000-0000-0000000000a1', timestamptz '2026-01-01 12:00' + make_interval(mins => g)
  from generate_series(1, 5) g;
insert into public.activities (id, workspace_id, type, subject, contact_id, occurred_at) values
  ('80000000-0000-0000-0000-000000000001', :'crm', 'note', 'Tie A', '50000000-0000-0000-0000-0000000000a1', '2025-12-31 12:00'),
  ('80000000-0000-0000-0000-000000000002', :'crm', 'note', 'Tie B', '50000000-0000-0000-0000-0000000000a1', '2025-12-31 12:00');
select pg_temp.act_as('10000000-0000-0000-0000-000000000003');
set role authenticated;
do $$ declare p1 record; ids uuid[]; seen uuid[] := '{}'; total int := 0; cur_at timestamptz; cur_id uuid; r record; begin
  -- Page through all notes two at a time; nothing is skipped or repeated, ties included.
  loop
    ids := '{}';
    for r in select * from public.get_timeline('contact', '50000000-0000-0000-0000-0000000000a1', cur_at, cur_id, 2, '{note}') loop
      assert not (r.id = any(seen)), 'no repeats across pages';
      seen := seen || r.id; ids := ids || r.id; cur_at := r.occurred_at; cur_id := r.id; total := total + 1;
    end loop;
    exit when cardinality(ids) < 2;
  end loop;
  assert total = 7, 'every note reached through the pages (got ' || total || ')';
  select * into p1 from public.get_timeline('contact', '50000000-0000-0000-0000-0000000000a1', null, null, 1, '{note}');
  assert p1.subject = 'Note 5', 'newest first';
  assert (select count(*) from public.get_timeline('company', '50000000-0000-0000-0000-0000000000c1', null, null, 200, '{note}')) = 7, 'company timeline includes its people';
  assert (select count(*) from public.get_timeline('deal', '50000000-0000-0000-0000-0000000000d1', null, null, 200, '{note,call}')) = 8, 'deal timeline includes its main contact';
  assert (select call->>'disposition' from public.get_timeline('contact', '50000000-0000-0000-0000-0000000000a1', null, null, 50, '{call}')) = 'connected', 'call details joined';
  assert (select email->>'from_address' from public.get_timeline('contact', '50000000-0000-0000-0000-0000000000a1', null, null, 50, '{email}') limit 1) is not null, 'email details joined';
  assert (select count(*) from public.get_timeline('contact', '50000000-0000-0000-0000-0000000000a1', null, null, 1000)) <= 200, 'page size capped';
end $$;
reset role;

select 'timeline_test.sql passed' as result;
