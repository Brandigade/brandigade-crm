-- Record ownership: everyone reads every record; editors change only their
-- own; the owner and admins change everything; viewers change nothing.
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
  exception when insufficient_privilege then return;
  end;
  raise exception 'expected permission denied for: %', sql;
end $$;

-- Admin A, editors E1 and E2, viewer V.
insert into auth.users (id, email, email_confirmed_at) values
  ('30000000-0000-0000-0000-0000000000a0', 'admin@own.co', now()),
  ('30000000-0000-0000-0000-0000000000e1', 'e1@own.co', now()),
  ('30000000-0000-0000-0000-0000000000e2', 'e2@own.co', now()),
  ('30000000-0000-0000-0000-0000000000f0', 'v@own.co', now());
select id as crm from public.workspaces \gset
select user_id as owner from public.workspace_members where role = 'owner' \gset
insert into public.workspace_members (workspace_id, user_id, role) values
  (:'crm', '30000000-0000-0000-0000-0000000000a0', 'admin'),
  (:'crm', '30000000-0000-0000-0000-0000000000e1', 'editor'),
  (:'crm', '30000000-0000-0000-0000-0000000000e2', 'editor'),
  (:'crm', '30000000-0000-0000-0000-0000000000f0', 'viewer');

-- A record from before ownership existed: no owner, no creator.
select pg_temp.act_as(null);
insert into public.contacts (id, workspace_id, first_name) values ('31000000-0000-0000-0000-0000000000a9', :'crm', 'Legacy');
update public.contacts set created_by = null where id = '31000000-0000-0000-0000-0000000000a9';

-- E1 creates a company, a lead of their own, a deal owned by E2 and a task for E2.
set role authenticated;
select pg_temp.act_as('30000000-0000-0000-0000-0000000000e1');
insert into public.companies (id, workspace_id, name) values ('31000000-0000-0000-0000-0000000000c1', :'crm', 'E1 Co');
insert into public.contacts (id, workspace_id, first_name, owner_id) values ('31000000-0000-0000-0000-0000000000a1', :'crm', 'E1 lead', '30000000-0000-0000-0000-0000000000e1');
insert into public.deals (id, workspace_id, title, owner_id) values ('31000000-0000-0000-0000-0000000000d1', :'crm', 'For E2', '30000000-0000-0000-0000-0000000000e2');
insert into public.tasks (id, workspace_id, title, assigned_to) values ('31000000-0000-0000-0000-0000000000b1', :'crm', 'E2 task', '30000000-0000-0000-0000-0000000000e2');

-- E2 sees all of it but can't change E1's records.
select pg_temp.act_as('30000000-0000-0000-0000-0000000000e2');
do $$ begin
  assert (select count(*) from public.contacts where id in ('31000000-0000-0000-0000-0000000000a1', '31000000-0000-0000-0000-0000000000a9')) = 2, 'editors read everyone''s leads';
  assert (select count(*) from public.companies where id = '31000000-0000-0000-0000-0000000000c1') = 1, 'editors read everyone''s companies';
end $$;
update public.companies set name = 'hacked' where id = '31000000-0000-0000-0000-0000000000c1';
update public.contacts set first_name = 'hacked' where id in ('31000000-0000-0000-0000-0000000000a1', '31000000-0000-0000-0000-0000000000a9');
delete from public.companies where id = '31000000-0000-0000-0000-0000000000c1';
delete from public.contacts where id = '31000000-0000-0000-0000-0000000000a1';
select pg_temp.denied($q$insert into public.contacts (id, workspace_id, first_name) values ('31000000-0000-0000-0000-0000000000a1', (select id from public.workspaces), 'upsert') on conflict (id) do update set first_name = excluded.first_name$q$);
-- ...but can work on what is theirs: the deal they own and the task assigned to them.
update public.deals set value = 500 where id = '31000000-0000-0000-0000-0000000000d1';
update public.tasks set status = 'done' where id = '31000000-0000-0000-0000-0000000000b1';
-- ...and can't hand their deal to someone else and keep editing it.
select pg_temp.denied($q$update public.deals set owner_id = '30000000-0000-0000-0000-0000000000e1' where id = '31000000-0000-0000-0000-0000000000d1'$q$);
-- Creating records (for anyone) is fine.
insert into public.contacts (id, workspace_id, first_name, owner_id) values ('31000000-0000-0000-0000-0000000000a2', :'crm', 'E2 lead for E1', '30000000-0000-0000-0000-0000000000e1');
update public.contacts set first_name = 'E2 lead (renamed)' where id = '31000000-0000-0000-0000-0000000000a2';
reset role;
do $$ begin
  assert (select name from public.companies where id = '31000000-0000-0000-0000-0000000000c1') = 'E1 Co', 'editor cannot rename someone else''s company';
  assert (select first_name from public.contacts where id = '31000000-0000-0000-0000-0000000000a1') = 'E1 lead', 'editor cannot edit someone else''s lead';
  assert (select first_name from public.contacts where id = '31000000-0000-0000-0000-0000000000a9') = 'Legacy', 'editor cannot edit a lead nobody owns';
  assert exists (select 1 from public.contacts where id = '31000000-0000-0000-0000-0000000000a1'), 'editor cannot delete someone else''s lead';
  assert (select value from public.deals where id = '31000000-0000-0000-0000-0000000000d1') = 500, 'editor edits a deal they own';
  assert (select owner_id from public.deals where id = '31000000-0000-0000-0000-0000000000d1') = '30000000-0000-0000-0000-0000000000e2', 'deal stays with its owner';
  assert (select status from public.tasks where id = '31000000-0000-0000-0000-0000000000b1') = 'done', 'editor updates a task assigned to them';
  assert (select first_name from public.contacts where id = '31000000-0000-0000-0000-0000000000a2') = 'E2 lead (renamed)', 'the creator keeps editing a record they made for someone else';
end $$;

-- E1 (the creator) still edits the deal and task they made for E2.
set role authenticated;
select pg_temp.act_as('30000000-0000-0000-0000-0000000000e1');
update public.deals set title = 'For E2 (by E1)' where id = '31000000-0000-0000-0000-0000000000d1';
update public.tasks set title = 'E2 task (by E1)' where id = '31000000-0000-0000-0000-0000000000b1';
reset role;
do $$ begin
  assert (select title from public.deals where id = '31000000-0000-0000-0000-0000000000d1') = 'For E2 (by E1)', 'creator edits their deal';
  assert (select title from public.tasks where id = '31000000-0000-0000-0000-0000000000b1') = 'E2 task (by E1)', 'creator edits their task';
end $$;

-- The viewer changes nothing, not even records "assigned" to them.
set role authenticated;
select pg_temp.act_as('30000000-0000-0000-0000-0000000000f0');
update public.contacts set first_name = 'viewer' where id = '31000000-0000-0000-0000-0000000000a1';
select pg_temp.denied($q$insert into public.companies (workspace_id, name) values ((select id from public.workspaces), 'viewer co')$q$);
reset role;
do $$ begin
  assert (select first_name from public.contacts where id = '31000000-0000-0000-0000-0000000000a1') = 'E1 lead', 'viewer cannot edit';
end $$;

-- The admin and the owner change anything, including records nobody owns.
set role authenticated;
select pg_temp.act_as('30000000-0000-0000-0000-0000000000a0');
update public.contacts set first_name = 'By admin' where id in ('31000000-0000-0000-0000-0000000000a1', '31000000-0000-0000-0000-0000000000a9');
update public.deals set owner_id = '30000000-0000-0000-0000-0000000000e1' where id = '31000000-0000-0000-0000-0000000000d1';
select pg_temp.act_as(:'owner');
update public.companies set name = 'By owner' where id = '31000000-0000-0000-0000-0000000000c1';
delete from public.tasks where id = '31000000-0000-0000-0000-0000000000b1';
reset role;
do $$ begin
  assert (select count(*) from public.contacts where first_name = 'By admin') = 2, 'admin edits every lead';
  assert (select owner_id from public.deals where id = '31000000-0000-0000-0000-0000000000d1') = '30000000-0000-0000-0000-0000000000e1', 'admin reassigns deals';
  assert (select name from public.companies where id = '31000000-0000-0000-0000-0000000000c1') = 'By owner', 'owner edits every company';
  assert not exists (select 1 from public.tasks where id = '31000000-0000-0000-0000-0000000000b1'), 'owner deletes any task';
end $$;

-- Admins can't manage the team, and nobody promotes themselves.
set role authenticated;
select pg_temp.act_as('30000000-0000-0000-0000-0000000000a0');
update public.workspace_members set role = 'viewer' where user_id = '30000000-0000-0000-0000-0000000000e1';
select pg_temp.act_as('30000000-0000-0000-0000-0000000000e2');
update public.workspace_members set role = 'admin' where user_id = '30000000-0000-0000-0000-0000000000e2';
reset role;
do $$ begin
  assert (select role from public.workspace_members where user_id = '30000000-0000-0000-0000-0000000000e1') = 'editor', 'admin cannot change roles';
  assert (select role from public.workspace_members where user_id = '30000000-0000-0000-0000-0000000000e2') = 'editor', 'editor cannot make themselves admin';
end $$;
-- The owner can make someone an admin.
set role authenticated;
select pg_temp.act_as(:'owner');
update public.workspace_members set role = 'admin' where user_id = '30000000-0000-0000-0000-0000000000e2';
reset role;
do $$ begin
  assert (select role from public.workspace_members where user_id = '30000000-0000-0000-0000-0000000000e2') = 'admin', 'owner makes an admin';
end $$;

select 'ownership_test.sql passed';
