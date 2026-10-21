-- After the new migrations (applied twice): every record from the JSON
-- document is in its table with its links, nothing is duplicated, the old
-- document is untouched and read-only, and nothing was emailed or logged for
-- records that merely moved.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.co(lid text) returns uuid language sql as $$ select id from public.companies where legacy_id = lid $$;
create or replace function pg_temp.ct(lid text) returns uuid language sql as $$ select id from public.contacts where legacy_id = lid $$;
create or replace function pg_temp.dl(lid text) returns uuid language sql as $$ select id from public.deals where legacy_id = lid $$;

do $$ begin
  assert (select count(*) from public.companies) = 3, 'companies copied (rows without an id or not objects skipped): ' || (select count(*) from public.companies);
  assert (select count(*) from public.contacts) = 2, 'contacts copied once (duplicate id skipped)';
  assert (select count(*) from public.deals) = 3, 'deals copied';
  assert (select count(*) from public.tasks) = 3, 'tasks copied';
  assert (select count(*) from public.activities) = 3, 'activities copied, and nothing extra recorded for moved tasks';
  assert (select count(*) from public.job_queue) = 0, 'no notification queued for tasks that merely moved';
end $$;

-- Companies
do $$ begin
  assert (select name = 'Cedar & Crumb' and industry = 'Food & beverage' and city = 'San Francisco' and created_at = '2026-10-01T10:00:00Z'
          from public.companies where legacy_id = 'co1'), 'company fields and creation time';
  assert (select name from public.companies where legacy_id = 'co2') = 'Unnamed company', 'empty name filled in';
  assert (select char_length(name) from public.companies where legacy_id = 'co3') = 200, 'over-long name clipped to the limit';
end $$;

-- Contacts
do $$ begin
  assert (select first_name = 'Maya' and last_name = 'Rivera' and email = 'Maya@CedarCrumb.example' and email_normalized = 'maya@cedarcrumb.example'
          and phone_digits = '14155550143' and status = 'customer' and source = 'Referral'
          and company_id = pg_temp.co('co1') and owner_id = '90000000-0000-0000-0000-000000000001'
          from public.contacts where legacy_id = 'c1'), 'contact fields and links';
  assert (select first_name = '' and company_id is null and owner_id is null and status = 'lead'
          from public.contacts where legacy_id = 'c2'), 'missing company/owner and unknown status handled';
end $$;

-- Deals
do $$ begin
  assert (select value = 18500 and stage = 'negotiation' and close_date = '2026-10-20' and contact_id = pg_temp.ct('c1') and company_id = pg_temp.co('co1')
          and owner_id = '90000000-0000-0000-0000-000000000002' from public.deals where legacy_id = 'd1'), 'deal fields and links';
  assert (select value = 0 and stage = 'lead' and close_date is null and closed_at = '2026-01-01' from public.deals where legacy_id = 'd2'), 'bad value/stage/date handled';
  assert (select value = 0 and stage = 'won' from public.deals where legacy_id = 'd3'), 'negative value floored at 0';
end $$;

-- Tasks
do $$ begin
  assert (select status = 'done' and completed_at is not null and due_date = '2026-10-18' and due_time = '10:00' and reminder = '1_hour'
          and priority = 'high' and assigned_to = '90000000-0000-0000-0000-000000000002' and assignment_version = 1
          and deal_id = pg_temp.dl('d1') and notes = 'Matte finish' and workstream = 'Follow-up'
          from public.tasks where legacy_id = 'b101'), 'task fields and links';
  assert (select status = 'todo' and reminder = 'at_due' and due_time is null and due_date = '2026-10-19' and workstream = 'General'
          from public.tasks where legacy_id = 'b102'), 'a task saved before reminders existed keeps its reminder email at the due time';
  assert (select reminder = 'none' and due_date is null and assigned_to is null from public.tasks where legacy_id = 'b103'), 'invalid date and unknown assignee handled';
end $$;

-- Activities
do $$ begin
  assert (select type = 'call' and source = 'manual' and subject = 'Discovery call' and body = 'Budget confirmed'
          and occurred_at = '2026-10-05T09:00:00Z' and actor_id = '90000000-0000-0000-0000-000000000001'
          and contact_id = pg_temp.ct('c1') and deal_id = pg_temp.dl('d1') and company_id = pg_temp.co('co1') and visibility = 'team'
          from public.activities where legacy_id = 'a1'), 'activity fields and links';
  assert (select type = 'note' from public.activities where legacy_id = 'a2'), 'unknown activity type becomes a note';
  assert (select actor_id is null and contact_id = pg_temp.ct('c2') from public.activities where legacy_id = 'a3'), 'unknown author handled';
  assert (select last_activity_at from public.contacts where legacy_id = 'c1') = '2026-10-05T09:00:00Z', 'last touch filled from history';
end $$;

-- Settings, the old document and the schedule
do $$ begin
  assert (select settings->>'currency' = 'AED' and settings->>'timezone' = 'Asia/Dubai' from public.workspaces), 'settings moved to the workspace';
  assert (select md5(data::text) from public.workspace_state) = (select md5 from public._fixture_state_md5), 'the old document is untouched';
end $$;
create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
end $$;
set role authenticated;
select pg_temp.act_as('90000000-0000-0000-0000-000000000002');
do $$ begin
  begin
    update public.workspace_state set data = '{}';
    raise exception 'the old document is still writable';
  exception when insufficient_privilege then
    assert sqlerrm like 'The CRM has moved to a new version%', 'saves from the old app get a clear message';
  end;
  assert (select count(*) from public.contacts) = 2 and (select count(*) from public.get_timeline('contact', (select id from public.contacts where legacy_id = 'c1'))) = 1,
         'the editor reads the moved records and their timeline';
end $$;
reset role;

-- The app keeps working on moved records: a reassignment emails, a change is logged.
select pg_temp.act_as('90000000-0000-0000-0000-000000000001');
update public.tasks set assigned_to = '90000000-0000-0000-0000-000000000001', status = 'todo' where legacy_id = 'b101';
update public.tasks set assigned_to = '90000000-0000-0000-0000-000000000002' where legacy_id = 'b101';
do $$ begin
  assert (select assignment_version from public.tasks where legacy_id = 'b101') = 3, 'assignment version continues from the copy';
  assert (select count(*) from public.job_queue where kind = 'notify.task_assigned') = 1, 'reassigning a moved task emails the new assignee';
  assert exists (select 1 from public.activities where source = 'task' and event = 'reopened'), 'changes to moved tasks are logged';
end $$;

drop table public._fixture_state_md5;
select 'upgrade_test.sql passed' as result;
