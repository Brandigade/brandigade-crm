-- Changes to leads, deals and companies reach the timeline by themselves.
\set ON_ERROR_STOP on
\pset tuples_only on

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
  perform set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, false);
end $$;
create or replace function pg_temp.denied(sql text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when insufficient_privilege or check_violation then return;
  end;
  raise exception 'expected a refusal for: %', sql;
end $$;

insert into auth.users (id, email, email_confirmed_at) values ('40000000-0000-0000-0000-0000000000e1', 'rt@own.co', now());
select id as crm from public.workspaces \gset
insert into public.workspace_members (workspace_id, user_id, role) values (:'crm', '40000000-0000-0000-0000-0000000000e1', 'editor');

set role authenticated;
select pg_temp.act_as('40000000-0000-0000-0000-0000000000e1');
insert into public.companies (id, workspace_id, name) values ('41000000-0000-0000-0000-0000000000c1', :'crm', 'Timeline Co');
insert into public.contacts (id, workspace_id, first_name, last_name, company_id, owner_id) values
  ('41000000-0000-0000-0000-0000000000a1', :'crm', 'Tia', 'Line', '41000000-0000-0000-0000-0000000000c1', '40000000-0000-0000-0000-0000000000e1');
insert into public.deals (id, workspace_id, title, contact_id, value, stage) values
  ('41000000-0000-0000-0000-0000000000d1', :'crm', 'Big deal', '41000000-0000-0000-0000-0000000000a1', 900, 'lead');
update public.contacts set status = 'prospect' where id = '41000000-0000-0000-0000-0000000000a1';
update public.contacts set phone = '+971 50 000 0001' where id = '41000000-0000-0000-0000-0000000000a1';
update public.contacts set phone = '+971 50 000 0002', title = 'CEO' where id = '41000000-0000-0000-0000-0000000000a1';
update public.deals set stage = 'proposal' where id = '41000000-0000-0000-0000-0000000000d1';
update public.companies set city = 'Dubai' where id = '41000000-0000-0000-0000-0000000000c1';
-- The app can't write these entries itself.
select pg_temp.denied($q$insert into public.activities (workspace_id, type, source, event, subject) values ((select id from public.workspaces), 'update', 'record', 'created', 'fake')$q$);
reset role;

do $$
declare
  co uuid := '41000000-0000-0000-0000-0000000000c1';
  ct uuid := '41000000-0000-0000-0000-0000000000a1';
  dl uuid := '41000000-0000-0000-0000-0000000000d1';
begin
  assert exists (select 1 from public.activities where source = 'record' and event = 'created' and company_id = co and contact_id is null and subject = 'Timeline Co'), 'company created';
  assert exists (select 1 from public.activities where source = 'record' and event = 'created' and contact_id = ct and company_id = co and subject = 'Tia Line'), 'lead created, on its company too';
  assert exists (select 1 from public.activities where source = 'record' and event = 'created' and deal_id = dl and contact_id = ct and company_id = co), 'deal created, on its lead and the lead''s company';
  assert (select meta->>'to' from public.activities where source = 'record' and event = 'status' and contact_id = ct) = 'prospect', 'status change with the new status';
  assert (select meta->>'from' from public.activities where source = 'record' and event = 'stage' and deal_id = dl) = 'lead', 'stage change with the old stage';
  assert (select count(*) from public.activities where source = 'record' and event = 'updated' and contact_id = ct) = 1, 'quick edits are folded into one entry';
  assert (select meta->'fields' from public.activities where source = 'record' and event = 'updated' and contact_id = ct) = '["phone", "title"]'::jsonb, 'the entry lists every changed field';
  assert (select actor_id from public.activities where source = 'record' and event = 'status' and contact_id = ct) = '40000000-0000-0000-0000-0000000000e1', 'entries name who made the change';
  assert (select last_activity_at from public.contacts where id = ct) is null, 'editing a lead is not a "last touch"';
end $$;

-- The company's timeline rolls up its leads and deals.
set role authenticated;
select pg_temp.act_as('40000000-0000-0000-0000-0000000000e1');
do $$ begin
  assert (select count(*) from public.get_timeline('company', '41000000-0000-0000-0000-0000000000c1') where source = 'record') = 7,
    'company timeline: company created + updated, lead created + status + updated, deal created + stage';
  assert (select count(*) from public.get_timeline('contact', '41000000-0000-0000-0000-0000000000a1') where source = 'record') = 5,
    'lead timeline: its own changes and its deal''s';
end $$;
-- Deleting a deal leaves a note of it on the lead.
delete from public.deals where id = '41000000-0000-0000-0000-0000000000d1';
reset role;
do $$ begin
  assert exists (select 1 from public.activities where source = 'record' and event = 'deleted' and contact_id = '41000000-0000-0000-0000-0000000000a1' and subject = 'Big deal'), 'deleted deal stays on the lead''s timeline';
end $$;

select 'record_timeline_test.sql passed';
